import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient, type Client, type Row } from "@libsql/client";

import { SESSION_IDLE_HOURS, SESSION_MAX_DAYS } from "@/lib/session-policy";

import { prepareLocalDatabaseDirectory } from "../files/database-url";
import { AppError } from "../files/errors";
import {
  beginWriteTransaction,
  closeWriteTransaction,
  configuredWrite,
  runDatabaseWrite,
} from "../database/write-transaction";
import { hashPassword, normalizeUsername, verifyPassword } from "./password";

export type UserRole = "admin" | "member";

export interface User {
  id: string;
  username: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  passwordChangedAt: string;
  temporaryPasswordExpiresAt: string | null;
}

export interface PasswordAuthentication {
  user: User;
  passwordHash: string;
}

interface AuthRepositoryOptions {
  verifyPassword?: typeof verifyPassword;
}

export type ApiKeyStatus = "pending" | "active";

export interface ApiKeyMetadata {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  lastFour: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: ApiKeyStatus;
  pendingExpiresAt: string | null;
}

// Two-phase browser creation: phase 1 stores a PENDING, non-authenticating
// key under a caller-supplied idempotency request id and returns the
// show-once secret; phase 2 activates it only after the client confirms it
// received that secret. A lost response therefore never leaves an ACTIVE
// credential nobody can recover — at worst an inert pending row that is
// truthfully listed, cancellable, and expires.
export interface BeginApiKeyCreationResult {
  /** False when this request id was already committed — the secret is
   * intentionally NOT re-exposed on retries. */
  created: boolean;
  id: string;
  name: string;
  secret: string | null;
  status: ApiKeyStatus;
  pendingExpiresAt: string | null;
}

export interface OwnedApiKeyMetadata extends ApiKeyMetadata {
  ownerUsername: string;
}

export interface ApiKeyPage {
  apiKeys: OwnedApiKeyMetadata[];
  nextCursor: string | null;
  totals: { total: number; active: number; pending: number };
}

export interface ApiKeyCursor {
  createdAt: string;
  id: string;
}

// Revoked API keys are retained for audit context under an explicit,
// bounded policy: at most this many revoked records per user, and none
// older than the retention age. Pruning happens on the owner's next key
// creation. This is bounded retention, not a durable audit log.
export const REVOKED_KEY_RETENTION_COUNT = 20;
export const REVOKED_KEY_RETENTION_DAYS = 90;

// Ambiguous non-key mutations (admin user creation, admin password reset)
// accept an opaque idempotency request id so a client that lost the
// response can retry and truthfully reconcile against the original commit.
// Only opaque metadata is retained — never plaintext — bounded by this
// window; rows also die with their user via ON DELETE CASCADE.
export const IDEMPOTENT_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;

// Browser lost-response recovery needs a short, finite reconciliation window.
// Once a key-creation binding reaches a terminal outcome, retain its metadata
// for exactly 24 hours; live pending/active bindings are never age-pruned.
export const API_KEY_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

// Pending (phase-1) keys are short-lived and bounded per user; expired
// rows are pruned on the next key creation touch.
export const PENDING_API_KEY_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_API_KEYS = 5;

export function encodeApiKeyCursor(cursor: ApiKeyCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.createdAt, cursor.id]),
    "utf8",
  ).toString("base64url");
}

export function decodeApiKeyCursor(value: string): ApiKeyCursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !Number.isFinite(Date.parse(parsed[0])) ||
      parsed[1].length === 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return { createdAt: parsed[0], id: parsed[1] };
  } catch (cause) {
    throw new AppError(400, "invalid_cursor", "Cursor is invalid", { cause });
  }
}

// Column DDL shared verbatim by fresh creation and the legacy-upgrade
// rebuild so every database — new or migrated — carries the exact same
// semantic constraints (including the status CHECK).
const USERS_COLUMNS = `
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  password_changed_at TEXT NOT NULL,
  temporary_password_expires_at TEXT
`;

const API_KEYS_COLUMNS = `
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_digest TEXT NOT NULL UNIQUE CHECK(length(key_digest) = 64),
  key_prefix TEXT NOT NULL,
  last_four TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active')),
  request_id TEXT,
  pending_expires_at TEXT
`;

const SESSIONS_COLUMNS = `
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE CHECK(length(token_digest) = 64),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
`;

const IDEMPOTENT_OPERATIONS_COLUMNS = `
  operation TEXT NOT NULL CHECK(operation IN ('user_create', 'password_reset')),
  actor_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  intent_version INTEGER CHECK(intent_version IS NULL OR intent_version IN (0, 1)),
  intent_username TEXT,
  intent_role TEXT CHECK(intent_role IS NULL OR intent_role IN ('admin', 'member')),
  intent_credential_hash TEXT,
  PRIMARY KEY (operation, actor_key, request_id)
`;

const API_KEY_IDEMPOTENT_OPERATIONS_COLUMNS = `
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intent_version INTEGER NOT NULL CHECK(intent_version = 1),
  intent_name TEXT NOT NULL,
  key_id TEXT NOT NULL,
  pending_expires_at TEXT,
  terminal_code TEXT CHECK(terminal_code IS NULL OR terminal_code IN ('pending_expired', 'api_key_not_found')),
  terminal_at TEXT,
  created_at TEXT NOT NULL,
  CHECK((terminal_code IS NULL AND terminal_at IS NULL) OR (terminal_code IS NOT NULL AND terminal_at IS NOT NULL))
`;

const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (${USERS_COLUMNS});
CREATE INDEX IF NOT EXISTS users_role_active_idx ON users(role, active);

CREATE TABLE IF NOT EXISTS sessions (${SESSIONS_COLUMNS});
CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON sessions(user_id, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_revoked_idx ON sessions(revoked_at);

CREATE TABLE IF NOT EXISTS api_keys (${API_KEYS_COLUMNS});
CREATE INDEX IF NOT EXISTS api_keys_user_active_idx ON api_keys(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS api_key_idempotent_operations (${API_KEY_IDEMPOTENT_OPERATIONS_COLUMNS});
CREATE INDEX IF NOT EXISTS api_key_idempotent_operations_user_idx
  ON api_key_idempotent_operations(user_id);

CREATE TABLE IF NOT EXISTS idempotent_operations (${IDEMPOTENT_OPERATIONS_COLUMNS});
CREATE INDEX IF NOT EXISTS idempotent_operations_created_idx ON idempotent_operations(created_at);
CREATE INDEX IF NOT EXISTS idempotent_operations_user_idx ON idempotent_operations(user_id);

CREATE TABLE IF NOT EXISTS login_failures (
  throttle_key TEXT PRIMARY KEY NOT NULL,
  failures INTEGER NOT NULL,
  window_started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_window_idx ON login_failures(window_started_at);
`;

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/\bIF NOT EXISTS\b/giu, "")
    .replaceAll('"', "")
    .replaceAll("`", "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),=])\s*/gu, "$1")
    .trim()
    .toLocaleLowerCase("en-US");
}

async function hasCanonicalSchema(
  executor: Pick<Client, "execute">,
  expected: Record<string, string>,
): Promise<boolean> {
  const names = Object.keys(expected);
  const result = await executor.execute({
    sql: `SELECT name, sql FROM sqlite_master
      WHERE name IN (${names.map(() => "?").join(", ")})`,
    args: names,
  });
  const actual = new Map(
    result.rows.map((row) => [
      typeof row.name === "string" ? row.name : "",
      typeof row.sql === "string" ? normalizeSchemaSql(row.sql) : "",
    ]),
  );
  return names.every(
    (name) => actual.get(name) === normalizeSchemaSql(expected[name]!),
  );
}

const USERS_SCHEMA_OBJECTS = {
  users: `CREATE TABLE users (${USERS_COLUMNS})`,
  users_role_active_idx:
    "CREATE INDEX users_role_active_idx ON users(role, active)",
};

const SESSIONS_SCHEMA_OBJECTS = {
  sessions: `CREATE TABLE sessions (${SESSIONS_COLUMNS})`,
  sessions_user_active_idx:
    "CREATE INDEX sessions_user_active_idx ON sessions(user_id, expires_at, revoked_at)",
  sessions_expires_idx:
    "CREATE INDEX sessions_expires_idx ON sessions(expires_at)",
  sessions_revoked_idx:
    "CREATE INDEX sessions_revoked_idx ON sessions(revoked_at)",
};

const IDEMPOTENT_OPERATIONS_SCHEMA_OBJECTS = {
  idempotent_operations: `CREATE TABLE idempotent_operations (${IDEMPOTENT_OPERATIONS_COLUMNS})`,
  idempotent_operations_created_idx:
    "CREATE INDEX idempotent_operations_created_idx ON idempotent_operations(created_at)",
  idempotent_operations_user_idx:
    "CREATE INDEX idempotent_operations_user_idx ON idempotent_operations(user_id)",
};

const API_KEY_IDEMPOTENT_OPERATIONS_SCHEMA_OBJECTS = {
  api_key_idempotent_operations: `CREATE TABLE api_key_idempotent_operations (${API_KEY_IDEMPOTENT_OPERATIONS_COLUMNS})`,
  api_key_idempotent_operations_user_idx:
    "CREATE INDEX api_key_idempotent_operations_user_idx ON api_key_idempotent_operations(user_id)",
  api_key_idempotent_operations_terminal_idx:
    "CREATE INDEX api_key_idempotent_operations_terminal_idx ON api_key_idempotent_operations(terminal_code, terminal_at)",
};

let authMigrationQueue: Promise<unknown> = Promise.resolve();
function runAuthMigrationsExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = authMigrationQueue.then(task, task);
  authMigrationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export const SESSION_IDLE_TTL_MS = SESSION_IDLE_HOURS * 60 * 60 * 1000;
export const SESSION_MAX_TTL_MS = SESSION_MAX_DAYS * 24 * 60 * 60 * 1000;
export const TEMPORARY_PASSWORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const MAX_ADDRESS_LOGIN_ATTEMPTS = 10;
const MAX_ACTIVE_API_KEYS = 10;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stringColumn(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid ${key} column`);
  return value;
}

function userFromRow(row: Row): User {
  return {
    id: stringColumn(row, "id"),
    username: stringColumn(row, "username"),
    role: stringColumn(row, "role") as UserRole,
    active: Number(row.active) === 1,
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
    passwordChangedAt: stringColumn(row, "password_changed_at"),
    temporaryPasswordExpiresAt:
      typeof row.temporary_password_expires_at === "string"
        ? row.temporary_password_expires_at
        : null,
  };
}

export class AuthRepository {
  private constructor(
    private readonly client: Client,
    private readonly databaseUrl: string,
    private readonly verifyPasswordForLogin: typeof verifyPassword,
  ) {}

  static async create(
    databaseUrl: string,
    options: AuthRepositoryOptions = {},
  ): Promise<AuthRepository> {
    await prepareLocalDatabaseDirectory(databaseUrl);
    const client = createClient({ url: databaseUrl, intMode: "number" });
    await client.execute("PRAGMA foreign_keys = OFF");
    await client.execute("PRAGMA busy_timeout = 5000");
    await runDatabaseWrite(databaseUrl, () =>
      runAuthMigrationsExclusive(async () => {
        await client.executeMultiple(AUTH_SCHEMA);
        await AuthRepository.migrateUsersSchema(client);
        await AuthRepository.migrateSessionsSchema(client);
        await AuthRepository.migrateIdempotentOperationsSchema(client);
        await AuthRepository.migrateApiKeysSchema(client);
        await AuthRepository.migrateApiKeyIdempotentOperationsSchema(client);
        await AuthRepository.migrateApiKeyRequestIndex(client);
        await AuthRepository.migrateApiKeyIdempotency(client);
        await AuthRepository.pruneRetainedApiKeys(client, new Date());
      }),
    );
    await client.execute("PRAGMA foreign_keys = ON");
    const foreignKeys = await client.execute("PRAGMA foreign_key_check");
    if (foreignKeys.rows.length > 0) {
      client.close();
      throw new AppError(
        500,
        "invalid_foreign_keys",
        "Database migration failed foreign-key validation",
      );
    }
    return new AuthRepository(
      client,
      databaseUrl,
      options.verifyPassword ?? verifyPassword,
    );
  }

  private static async pruneApiKeyIdempotencyTombstones(
    executor: Pick<Client, "execute">,
    now: Date,
  ): Promise<void> {
    await executor.execute({
      sql: `DELETE FROM api_key_idempotent_operations
        WHERE terminal_code IS NOT NULL AND terminal_at IS NOT NULL
          AND terminal_at <= ?`,
      args: [
        new Date(
          now.getTime() - API_KEY_IDEMPOTENCY_RETENTION_MS,
        ).toISOString(),
      ],
    });
  }

  private static async pruneRetainedApiKeys(
    client: Client,
    now: Date,
  ): Promise<void> {
    const transaction = await beginWriteTransaction(client, {
      retryBusy: true,
      foreignKeys: false,
    });
    try {
      const cutoff = new Date(
        now.getTime() - REVOKED_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const nowIso = now.toISOString();
      await transaction.execute({
        sql: `UPDATE api_key_idempotent_operations
          SET terminal_code = 'api_key_not_found', terminal_at = COALESCE(terminal_at, ?)
          WHERE key_id IN (
            SELECT id FROM api_keys
            WHERE revoked_at IS NOT NULL AND revoked_at <= ?
          )`,
        args: [nowIso, cutoff],
      });
      await transaction.execute({
        sql: "DELETE FROM api_keys WHERE revoked_at IS NOT NULL AND revoked_at <= ?",
        args: [cutoff],
      });
      const overflow = `SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY user_id ORDER BY revoked_at DESC, id DESC
          ) AS retained_position
        FROM api_keys WHERE revoked_at IS NOT NULL
      ) WHERE retained_position > ?`;
      await transaction.execute({
        sql: `UPDATE api_key_idempotent_operations
          SET terminal_code = 'api_key_not_found', terminal_at = COALESCE(terminal_at, ?)
          WHERE key_id IN (${overflow})`,
        args: [nowIso, REVOKED_KEY_RETENTION_COUNT],
      });
      await transaction.execute({
        sql: `DELETE FROM api_keys WHERE id IN (${overflow})`,
        args: [REVOKED_KEY_RETENTION_COUNT],
      });
      await transaction.execute({
        sql: `UPDATE api_key_idempotent_operations
          SET terminal_code = 'pending_expired', terminal_at = COALESCE(terminal_at, ?)
          WHERE key_id IN (
            SELECT id FROM api_keys
            WHERE status = 'pending' AND pending_expires_at <= ?
          )`,
        args: [nowIso, nowIso],
      });
      await transaction.execute({
        sql: `DELETE FROM api_keys
          WHERE status = 'pending' AND pending_expires_at <= ?`,
        args: [nowIso],
      });
      await AuthRepository.pruneApiKeyIdempotencyTombstones(transaction, now);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      await closeWriteTransaction(client, transaction, { foreignKeys: true });
    }
  }

  private static async migrateSessionsSchema(client: Client): Promise<void> {
    const isCanonical = (executor: Pick<Client, "execute">) =>
      hasCanonicalSchema(executor, SESSIONS_SCHEMA_OBJECTS);
    if (await isCanonical(client)) return;
    const transaction = await beginWriteTransaction(client, {
      retryBusy: true,
      foreignKeys: false,
    });
    try {
      if (await isCanonical(transaction)) {
        await transaction.commit();
        return;
      }
      const columns = await transaction.execute("PRAGMA table_info(sessions)");
      const names = new Set(
        columns.rows.map((row) =>
          typeof row.name === "string" ? row.name : "",
        ),
      );
      const lastSeenExpression = names.has("last_seen_at")
        ? "last_seen_at"
        : "created_at";
      const idleExpiryExpression = names.has("idle_expires_at")
        ? "idle_expires_at"
        : `CASE
            WHEN expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+12 hours') THEN expires_at
            ELSE strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+12 hours')
          END`;
      await transaction.execute("DROP TABLE IF EXISTS sessions_rebuild");
      await transaction.execute(
        `CREATE TABLE sessions_rebuild (${SESSIONS_COLUMNS})`,
      );
      await transaction.execute(`INSERT INTO sessions_rebuild
        (id, user_id, token_digest, created_at, last_seen_at, idle_expires_at, expires_at, revoked_at)
        SELECT id, user_id, token_digest, created_at,
          ${lastSeenExpression}, ${idleExpiryExpression},
          expires_at, revoked_at
        FROM sessions`);
      await transaction.execute("DROP TABLE sessions");
      await transaction.execute(
        "ALTER TABLE sessions_rebuild RENAME TO sessions",
      );
      await transaction.execute(
        "CREATE INDEX sessions_user_active_idx ON sessions(user_id, expires_at, revoked_at)",
      );
      await transaction.execute(
        "CREATE INDEX sessions_expires_idx ON sessions(expires_at)",
      );
      await transaction.execute(
        "CREATE INDEX sessions_revoked_idx ON sessions(revoked_at)",
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      await closeWriteTransaction(client, transaction, { foreignKeys: false });
    }
  }

  private static async migrateUsersSchema(client: Client): Promise<void> {
    const isCanonical = (executor: Pick<Client, "execute">) =>
      hasCanonicalSchema(executor, USERS_SCHEMA_OBJECTS);
    if (await isCanonical(client)) return;
    const transaction = await beginWriteTransaction(client, {
      retryBusy: true,
      foreignKeys: false,
    });
    try {
      if (await isCanonical(transaction)) {
        await transaction.commit();
        return;
      }
      const columns = await transaction.execute("PRAGMA table_info(users)");
      const names = new Set(columns.rows.map((row) => row.name));
      const passwordChanged = names.has("password_changed_at")
        ? "COALESCE(password_changed_at, created_at)"
        : "created_at";
      const temporaryExpiry = names.has("temporary_password_expires_at")
        ? "temporary_password_expires_at"
        : "NULL";
      await transaction.execute("DROP TABLE IF EXISTS users_rebuild");
      await transaction.execute(
        `CREATE TABLE users_rebuild (${USERS_COLUMNS})`,
      );
      await transaction.execute(`INSERT INTO users_rebuild
        (id, username, password_hash, role, active, created_at, updated_at, password_changed_at, temporary_password_expires_at)
        SELECT id, username, password_hash, role, active, created_at, updated_at,
          ${passwordChanged}, ${temporaryExpiry}
        FROM users`);
      await transaction.execute("DROP TABLE users");
      await transaction.execute("ALTER TABLE users_rebuild RENAME TO users");
      await transaction.execute(
        "CREATE INDEX users_role_active_idx ON users(role, active)",
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      await closeWriteTransaction(client, transaction, { foreignKeys: false });
    }
  }

  private static async migrateIdempotentOperationsSchema(
    client: Client,
  ): Promise<void> {
    const isCanonical = (executor: Pick<Client, "execute">) =>
      hasCanonicalSchema(executor, IDEMPOTENT_OPERATIONS_SCHEMA_OBJECTS);
    if (await isCanonical(client)) return;
    const transaction = await beginWriteTransaction(client, {
      retryBusy: true,
      foreignKeys: false,
    });
    try {
      if (await isCanonical(transaction)) {
        await transaction.commit();
        return;
      }
      const columns = await transaction.execute(
        "PRAGMA table_info(idempotent_operations)",
      );
      const names = new Set(
        columns.rows.map((row) =>
          typeof row.name === "string" ? row.name : "",
        ),
      );
      const expression = (name: string, fallback: string) =>
        names.has(name) ? name : fallback;
      await transaction.execute(
        "DROP TABLE IF EXISTS idempotent_operations_rebuild",
      );
      await transaction.execute(
        `CREATE TABLE idempotent_operations_rebuild (${IDEMPOTENT_OPERATIONS_COLUMNS})`,
      );
      await transaction.execute(`INSERT INTO idempotent_operations_rebuild
        (operation, actor_key, request_id, user_id, created_at,
          intent_version, intent_username, intent_role, intent_credential_hash)
        SELECT operation, actor_key, request_id, user_id, created_at,
          ${expression("intent_version", "CASE WHEN operation = 'user_create' THEN 0 ELSE NULL END")},
          ${expression("intent_username", "NULL")},
          ${expression("intent_role", "NULL")},
          ${expression("intent_credential_hash", "NULL")}
        FROM idempotent_operations`);
      await transaction.execute("DROP TABLE idempotent_operations");
      await transaction.execute(
        "ALTER TABLE idempotent_operations_rebuild RENAME TO idempotent_operations",
      );
      await transaction.execute(
        "CREATE INDEX idempotent_operations_created_idx ON idempotent_operations(created_at)",
      );
      await transaction.execute(
        "CREATE INDEX idempotent_operations_user_idx ON idempotent_operations(user_id)",
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      await closeWriteTransaction(client, transaction, { foreignKeys: false });
    }
  }

  private static async migrateApiKeyIdempotentOperationsSchema(
    client: Client,
  ): Promise<void> {
    const isCanonical = (executor: Pick<Client, "execute">) =>
      hasCanonicalSchema(
        executor,
        API_KEY_IDEMPOTENT_OPERATIONS_SCHEMA_OBJECTS,
      );
    if (await isCanonical(client)) return;
    const transaction = await beginWriteTransaction(client, {
      retryBusy: true,
      foreignKeys: false,
    });
    try {
      if (await isCanonical(transaction)) {
        await transaction.commit();
        return;
      }
      const columns = await transaction.execute(
        "PRAGMA table_info(api_key_idempotent_operations)",
      );
      const names = new Set(
        columns.rows.map((row) =>
          typeof row.name === "string" ? row.name : "",
        ),
      );
      const invalidTerminal = await transaction.execute(
        `SELECT COUNT(*) AS count FROM api_key_idempotent_operations
          WHERE terminal_code IS NOT NULL
            AND terminal_code NOT IN ('pending_expired', 'api_key_not_found')`,
      );
      if (Number(invalidTerminal.rows[0]?.count) !== 0) {
        throw new AppError(
          500,
          "invalid_api_key_idempotency_terminal",
          "API-key idempotency metadata contains an invalid terminal outcome",
        );
      }
      if (names.has("terminal_at")) {
        const inconsistent = await transaction.execute(
          `SELECT COUNT(*) AS count FROM api_key_idempotent_operations
            WHERE (terminal_code IS NULL) != (terminal_at IS NULL)`,
        );
        if (Number(inconsistent.rows[0]?.count) !== 0) {
          throw new AppError(
            500,
            "invalid_api_key_idempotency_terminal",
            "API-key idempotency terminal timestamps are inconsistent",
          );
        }
      }
      const terminalAt = names.has("terminal_at")
        ? "terminal_at"
        : "CASE WHEN terminal_code IS NULL THEN NULL ELSE created_at END";
      await transaction.execute(
        "DROP TABLE IF EXISTS api_key_idempotent_operations_rebuild",
      );
      await transaction.execute(
        `CREATE TABLE api_key_idempotent_operations_rebuild (${API_KEY_IDEMPOTENT_OPERATIONS_COLUMNS})`,
      );
      await transaction.execute(`INSERT INTO api_key_idempotent_operations_rebuild
        (request_id, user_id, intent_version, intent_name, key_id,
          pending_expires_at, terminal_code, terminal_at, created_at)
        SELECT request_id, user_id, intent_version, intent_name, key_id,
          pending_expires_at, terminal_code, ${terminalAt}, created_at
        FROM api_key_idempotent_operations`);
      await transaction.execute("DROP TABLE api_key_idempotent_operations");
      await transaction.execute(
        "ALTER TABLE api_key_idempotent_operations_rebuild RENAME TO api_key_idempotent_operations",
      );
      await transaction.execute(
        "CREATE INDEX api_key_idempotent_operations_user_idx ON api_key_idempotent_operations(user_id)",
      );
      await transaction.execute(
        "CREATE INDEX api_key_idempotent_operations_terminal_idx ON api_key_idempotent_operations(terminal_code, terminal_at)",
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      await closeWriteTransaction(client, transaction, { foreignKeys: false });
    }
  }

  // A browser key-creation request id is globally bound to one canonical
  // owner/name intent. Upgrade the earlier owner-scoped partial index in a
  // serialized, idempotent transaction; re-checking under the write lock keeps
  // concurrent repository startup safe.
  private static async migrateApiKeyRequestIndex(
    client: Client,
  ): Promise<void> {
    const expected =
      /ON api_keys\s*\(request_id\)\s*WHERE request_id IS NOT NULL/iu;
    const indexSql = async (
      executor: Pick<Client, "execute">,
    ): Promise<string> => {
      const result = await executor.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'api_keys_request_idx'",
      );
      return typeof result.rows[0]?.sql === "string" ? result.rows[0].sql : "";
    };
    if (expected.test(await indexSql(client))) return;
    const transaction = await beginWriteTransaction(client, {
      retryBusy: true,
      foreignKeys: false,
    });
    try {
      if (!expected.test(await indexSql(transaction))) {
        // Earlier releases allowed the same request id for multiple owners.
        // Keep the oldest canonical binding and retire only the duplicate
        // replay metadata; every key row remains intact. Retries by a retired
        // owner then conflict against the retained binding instead of minting
        // or re-exposing a secret.
        await transaction.execute(`UPDATE api_keys SET request_id = NULL
          WHERE request_id IS NOT NULL AND id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY request_id ORDER BY created_at, id
              ) AS binding_position
              FROM api_keys WHERE request_id IS NOT NULL
            ) WHERE binding_position > 1
          )`);
        await transaction.execute("DROP INDEX IF EXISTS api_keys_request_idx");
        await transaction.execute(
          `CREATE UNIQUE INDEX api_keys_request_idx
            ON api_keys(request_id) WHERE request_id IS NOT NULL`,
        );
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      await closeWriteTransaction(client, transaction, { foreignKeys: false });
    }
  }

  private static async migrateApiKeyIdempotency(client: Client): Promise<void> {
    const transaction = await beginWriteTransaction(client, {
      retryBusy: true,
    });
    try {
      await transaction.execute(`INSERT OR IGNORE INTO api_key_idempotent_operations
        (request_id, user_id, intent_version, intent_name, key_id,
          pending_expires_at, terminal_code, created_at)
        SELECT request_id, user_id, 1, name, id, pending_expires_at, NULL, created_at
        FROM api_keys WHERE request_id IS NOT NULL`);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      await closeWriteTransaction(client, transaction);
    }
  }

  // Upgrade api_keys tables created before the two-phase columns — or
  // upgraded by the earlier ALTER-based migration, which could not add the
  // status CHECK — to the exact fresh schema via a transactional table
  // rebuild. Idempotent (canonical tables are detected and skipped, also
  // under concurrent startups), crash-safe (one write transaction), and
  // fail-closed: unexpected status values abort the upgrade unchanged.
  private static async migrateApiKeysSchema(client: Client): Promise<void> {
    const tableSql = async (
      executor: Pick<Client, "execute">,
    ): Promise<string> => {
      const result = await executor.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'",
      );
      return typeof result.rows[0]?.sql === "string" ? result.rows[0].sql : "";
    };
    const canonical = "CHECK(status IN ('pending', 'active'))";
    if ((await tableSql(client)).includes(canonical)) return;
    const transaction = await beginWriteTransaction(client, {
      retryBusy: true,
      foreignKeys: false,
    });
    try {
      // Re-check under the write lock: a concurrent startup may have
      // completed the rebuild while this one waited.
      if ((await tableSql(transaction)).includes(canonical)) {
        await transaction.commit();
        return;
      }
      const columns = await transaction.execute("PRAGMA table_info(api_keys)");
      const names = new Set(
        columns.rows.map((row) =>
          typeof row.name === "string" ? row.name : "",
        ),
      );
      if (names.has("status")) {
        // Fail closed on values the constrained schema would reject —
        // never coerce data during an upgrade.
        const invalid = await transaction.execute(
          `SELECT COUNT(*) AS count FROM api_keys
            WHERE status IS NULL OR status NOT IN ('pending', 'active')`,
        );
        if (Number(invalid.rows[0]?.count) !== 0) {
          throw new AppError(
            500,
            "invalid_api_key_status",
            "api_keys contains status values outside ('pending', 'active'); refusing to migrate",
          );
        }
      }
      // Rebuild with the exact fresh-schema DDL, carrying every row and
      // column across (absent legacy columns read as their defaults).
      const statusExpr = names.has("status") ? "status" : "'active'";
      const requestExpr = names.has("request_id") ? "request_id" : "NULL";
      const pendingExpr = names.has("pending_expires_at")
        ? "pending_expires_at"
        : "NULL";
      await transaction.execute(
        `CREATE TABLE api_keys_rebuild (${API_KEYS_COLUMNS})`,
      );
      await transaction.execute(
        `INSERT INTO api_keys_rebuild
          (id, user_id, name, key_digest, key_prefix, last_four, created_at, last_used_at, expires_at, revoked_at, status, request_id, pending_expires_at)
          SELECT id, user_id, name, key_digest, key_prefix, last_four, created_at, last_used_at, expires_at, revoked_at, ${statusExpr}, ${requestExpr}, ${pendingExpr}
          FROM api_keys`,
      );
      await transaction.execute("DROP TABLE api_keys");
      await transaction.execute(
        "ALTER TABLE api_keys_rebuild RENAME TO api_keys",
      );
      // Recreate both api_keys indexes dropped with the old table.
      await transaction.execute(
        "CREATE INDEX IF NOT EXISTS api_keys_user_active_idx ON api_keys(user_id, revoked_at)",
      );
      await transaction.execute(
        `CREATE UNIQUE INDEX IF NOT EXISTS api_keys_request_idx
          ON api_keys(request_id) WHERE request_id IS NOT NULL`,
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      await closeWriteTransaction(client, transaction, { foreignKeys: false });
    }
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async bootstrapAdmin(input: {
    username: string;
    password: string;
  }): Promise<User> {
    const username = normalizeUsername(input.username);
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.runExclusive(async () => {
      const transaction = await beginWriteTransaction(this.client);
      try {
        const count = await transaction.execute(
          "SELECT COUNT(*) AS count FROM users",
        );
        if (Number(count.rows[0]?.count) !== 0) {
          throw new AppError(
            409,
            "bootstrap_complete",
            "User database is already initialized",
          );
        }
        await transaction.execute({
          sql: `INSERT INTO users
            (id, username, password_hash, role, active, created_at, updated_at, password_changed_at)
            VALUES (?, ?, ?, 'admin', 1, ?, ?, ?)`,
          args: [id, username, passwordHash, now, now, now],
        });
        await transaction.commit();
        return {
          id,
          username,
          role: "admin",
          active: true,
          createdAt: now,
          updatedAt: now,
          passwordChangedAt: now,
          temporaryPasswordExpiresAt: null,
        };
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  async createUser(
    input: {
      username: string;
      password: string;
      role: UserRole;
    },
    actorUserId?: string,
  ): Promise<User> {
    const username = normalizeUsername(input.username);
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    const now = new Date().toISOString();
    const temporaryPasswordExpiresAt = new Date(
      Date.parse(now) + TEMPORARY_PASSWORD_TTL_MS,
    ).toISOString();
    try {
      const result = await this.safeWrite(() =>
        this.client.execute({
          sql: `INSERT INTO users
          (id, username, password_hash, role, active, created_at, updated_at, password_changed_at, temporary_password_expires_at)
          SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?
          WHERE ? IS NULL OR EXISTS (
            SELECT 1 FROM users
            WHERE id = ? AND role = 'admin' AND active = 1
          )`,
          args: [
            id,
            username,
            passwordHash,
            input.role,
            now,
            now,
            now,
            temporaryPasswordExpiresAt,
            actorUserId ?? null,
            actorUserId ?? null,
          ],
        }),
      );
      if (result.rowsAffected === 0) {
        throw new AppError(
          403,
          "admin_revoked",
          "Administrator access is no longer valid",
        );
      }
    } catch (cause) {
      if (String(cause).toLocaleLowerCase("en-US").includes("unique")) {
        throw new AppError(409, "username_exists", "Username already exists", {
          cause,
        });
      }
      throw cause;
    }
    return {
      id,
      username,
      role: input.role,
      active: true,
      createdAt: now,
      updatedAt: now,
      passwordChangedAt: now,
      temporaryPasswordExpiresAt,
    };
  }

  private safeWrite<T>(run: () => Promise<T>): Promise<T> {
    return this.runExclusive(() =>
      configuredWrite(this.client, run, { foreignKeys: true }),
    );
  }

  private safeExecute(statement: Parameters<Client["execute"]>[0]) {
    return this.safeWrite(() => this.client.execute(statement));
  }

  private safeBatch(
    statements: Parameters<Client["batch"]>[0],
    mode: Parameters<Client["batch"]>[1],
  ) {
    return this.safeWrite(() => this.client.batch(statements, mode));
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return runDatabaseWrite(this.databaseUrl, task);
  }

  private validateOperationRequestId(requestId: string): void {
    if (!requestId || requestId.length > 128) {
      throw new AppError(
        400,
        "invalid_request_id",
        "request_id must be 1-128 characters",
      );
    }
  }

  private async pruneIdempotentOperations(
    executor: Pick<Client, "execute">,
    now: Date,
  ): Promise<void> {
    await executor.execute({
      sql: "DELETE FROM idempotent_operations WHERE created_at <= ?",
      args: [
        new Date(
          now.getTime() - IDEMPOTENT_OPERATION_RETENTION_MS,
        ).toISOString(),
      ],
    });
  }

  private async findIdempotentOperation(
    operation: "user_create" | "password_reset",
    actorKey: string,
    requestId: string,
    executor: Pick<Client, "execute"> = this.client,
  ): Promise<{
    userId: string;
    createdAt: string;
    intentVersion: number | null;
    intentUsername: string | null;
    intentRole: UserRole | null;
    intentCredentialHash: string | null;
  } | null> {
    const result = await executor.execute({
      sql: `SELECT user_id, intent_version, intent_username, intent_role,
          intent_credential_hash, created_at FROM idempotent_operations
        WHERE operation = ? AND actor_key = ? AND request_id = ?`,
      args: [operation, actorKey, requestId],
    });
    const row = result.rows[0];
    return row
      ? {
          userId: stringColumn(row, "user_id"),
          createdAt: stringColumn(row, "created_at"),
          intentVersion:
            typeof row.intent_version === "number" ? row.intent_version : null,
          intentUsername:
            typeof row.intent_username === "string"
              ? row.intent_username
              : null,
          intentRole:
            typeof row.intent_role === "string"
              ? (row.intent_role as UserRole)
              : null,
          intentCredentialHash:
            typeof row.intent_credential_hash === "string"
              ? row.intent_credential_hash
              : null,
        }
      : null;
  }

  private async getUserCredential(
    id: string,
    executor: Pick<Client, "execute"> = this.client,
  ): Promise<{ user: User; passwordHash: string } | null> {
    const result = await executor.execute({
      sql: `SELECT id, username, password_hash, role, active, created_at, updated_at, password_changed_at, temporary_password_expires_at
        FROM users WHERE id = ?`,
      args: [id],
    });
    const row = result.rows[0];
    return row
      ? {
          user: userFromRow(row),
          passwordHash: stringColumn(row, "password_hash"),
        }
      : null;
  }

  // Idempotent admin user creation: a retry with the same request id
  // resolves to the SAME committed user (never a duplicate), so the
  // client that retained the candidate password can truthfully finish the
  // show-once credential flow after a lost response. Only the bcrypt hash
  // is ever persisted.
  async createUserIdempotent(
    input: { username: string; password: string; role: UserRole },
    actor: { userId: string | null },
    requestId: string,
    now = new Date(),
  ): Promise<{ user: User; created: boolean }> {
    this.validateOperationRequestId(requestId);
    const actorKey = actor.userId ?? "legacy";
    const username = normalizeUsername(input.username);
    const passwordHash = await hashPassword(input.password);
    const replay = async (): Promise<{ user: User; created: false } | null> => {
      const operation = await this.findIdempotentOperation(
        "user_create",
        actorKey,
        requestId,
      );
      if (!operation) return null;
      if (
        operation.intentVersion !== 1 ||
        operation.intentUsername !== username ||
        operation.intentRole !== input.role ||
        !operation.intentCredentialHash ||
        !(await verifyPassword(input.password, operation.intentCredentialHash))
      ) {
        throw new AppError(
          409,
          "request_id_conflict",
          "request_id is already bound to another user creation",
        );
      }
      const credential = await this.getUserCredential(operation.userId);
      if (!credential) return null;
      if (!(await verifyPassword(input.password, credential.passwordHash))) {
        throw new AppError(
          409,
          "credential_superseded",
          "The created user's password has since changed; start a new credential flow",
        );
      }
      return { user: credential.user, created: false };
    };
    const existing = await replay();
    if (existing) return existing;
    return this.runExclusive(async () => {
      const reconciled = await replay();
      if (reconciled) return reconciled;
      const id = randomUUID();
      const nowIso = now.toISOString();
      const temporaryPasswordExpiresAt = new Date(
        now.getTime() + TEMPORARY_PASSWORD_TTL_MS,
      ).toISOString();
      const transaction = await beginWriteTransaction(this.client);
      try {
        await this.assertCurrentAdmin(transaction, actor.userId);
        await this.pruneIdempotentOperations(transaction, now);
        const result = await transaction.execute({
          sql: `INSERT INTO users
            (id, username, password_hash, role, active, created_at, updated_at, password_changed_at, temporary_password_expires_at)
            SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?
            WHERE ? IS NULL OR EXISTS (
              SELECT 1 FROM users
              WHERE id = ? AND role = 'admin' AND active = 1
            )`,
          args: [
            id,
            username,
            passwordHash,
            input.role,
            nowIso,
            nowIso,
            nowIso,
            temporaryPasswordExpiresAt,
            actor.userId,
            actor.userId,
          ],
        });
        if (result.rowsAffected === 0) {
          throw new AppError(
            403,
            "admin_revoked",
            "Administrator access is no longer valid",
          );
        }
        await transaction.execute({
          sql: `INSERT INTO idempotent_operations
            (operation, actor_key, request_id, user_id, created_at,
              intent_version, intent_username, intent_role, intent_credential_hash)
            VALUES ('user_create', ?, ?, ?, ?, 1, ?, ?, ?)`,
          args: [
            actorKey,
            requestId,
            id,
            nowIso,
            username,
            input.role,
            passwordHash,
          ],
        });
        await transaction.commit();
      } catch (cause) {
        await transaction.rollback();
        if (String(cause).toLocaleLowerCase("en-US").includes("unique")) {
          // Either a concurrent duplicate of this request committed first
          // (reconcile to it) or the username is genuinely taken.
          const raced = await replay();
          if (raced) return raced;
          throw new AppError(
            409,
            "username_exists",
            "Username already exists",
            { cause },
          );
        }
        throw cause;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
      return {
        user: {
          id,
          username,
          role: input.role,
          active: true,
          createdAt: nowIso,
          updatedAt: nowIso,
          passwordChangedAt: nowIso,
          temporaryPasswordExpiresAt,
        },
        created: true,
      };
    });
  }

  // Idempotent admin password reset: the candidate password applies
  // exactly once per request id. A replay applies NOTHING — it never
  // generates or re-applies a password, so a retry arriving after a newer
  // reset cannot silently overwrite the newer credential.
  async resetPasswordIdempotent(
    id: string,
    password: string,
    actorUserId: string | null,
    requestId: string,
    now = new Date(),
  ): Promise<{ user: User; applied: boolean }> {
    this.validateOperationRequestId(requestId);
    const actorKey = actorUserId ?? "legacy";
    const initialCredential = await this.getUserCredential(id);
    if (!initialCredential) {
      throw new AppError(404, "user_not_found", "User not found");
    }
    const user = initialCredential.user;
    const expectedPasswordHash = initialCredential.passwordHash;
    const passwordHash = await hashPassword(password);
    const nowIso = now.toISOString();
    const legacyCutoff = new Date(
      now.getTime() - IDEMPOTENT_OPERATION_RETENTION_MS,
    ).toISOString();

    return this.runExclusive(async () => {
      const transaction = await beginWriteTransaction(this.client);
      try {
        const operation = await this.findIdempotentOperation(
          "password_reset",
          actorKey,
          requestId,
          transaction,
        );
        if (operation) {
          // Route authorization can become stale while hashing the candidate.
          // Revalidate under the replay transaction before inspecting or
          // returning any target-bound state. A null actor remains the narrow
          // legacy-service bypass enforced by assertCurrentAdmin.
          await this.assertCurrentAdmin(transaction, actorUserId);
          if (operation.userId !== id) {
            throw new AppError(
              409,
              "request_id_conflict",
              "request_id is already bound to another password reset",
            );
          }
          const current = await this.getUserCredential(id, transaction);
          if (!current) {
            throw new AppError(404, "user_not_found", "User not found");
          }

          if (operation.intentVersion === 1) {
            if (
              !operation.intentCredentialHash ||
              !(await verifyPassword(password, operation.intentCredentialHash))
            ) {
              throw new AppError(
                409,
                "request_id_conflict",
                "request_id is already bound to another password reset",
              );
            }
          } else {
            const isLegacyNullIntent =
              operation.intentVersion === null &&
              operation.intentUsername === null &&
              operation.intentRole === null &&
              operation.intentCredentialHash === null;
            if (!isLegacyNullIntent || operation.createdAt <= legacyCutoff) {
              throw new AppError(
                409,
                "request_id_conflict",
                "request_id has no verifiable password-reset intent",
              );
            }
            // Narrow migration bridge for pre-intent rows: only during the
            // existing 24-hour lost-response window, and only while the
            // candidate still verifies as current. Upgrade under the same
            // write lock so subsequent replays use exact versioned intent.
            if (!(await verifyPassword(password, current.passwordHash))) {
              throw new AppError(
                409,
                "credential_superseded",
                "A newer password is active; start a new reset",
              );
            }
            const upgraded = await transaction.execute({
              sql: `UPDATE idempotent_operations
                SET intent_version = 1, intent_credential_hash = ?
                WHERE operation = 'password_reset' AND actor_key = ?
                  AND request_id = ? AND user_id = ? AND intent_version IS NULL
                  AND intent_username IS NULL AND intent_role IS NULL
                  AND intent_credential_hash IS NULL AND created_at > ?`,
              args: [passwordHash, actorKey, requestId, id, legacyCutoff],
            });
            if (upgraded.rowsAffected !== 1) {
              throw new AppError(
                409,
                "request_id_conflict",
                "request_id password-reset intent changed during reconciliation",
              );
            }
            await transaction.commit();
            return { user: current.user, applied: false };
          }

          // Match the immutable target and candidate first; only then classify
          // the operation as current or superseded. Current-state coincidence
          // can never make a different candidate a valid replay.
          if (!(await verifyPassword(password, current.passwordHash))) {
            throw new AppError(
              409,
              "credential_superseded",
              "A newer password is active; start a new reset",
            );
          }
          await transaction.commit();
          return { user: current.user, applied: false };
        }

        await this.assertCurrentAdmin(transaction, actorUserId);
        await this.pruneIdempotentOperations(transaction, now);
        await transaction.execute({
          sql: `INSERT INTO idempotent_operations
            (operation, actor_key, request_id, user_id, created_at,
              intent_version, intent_credential_hash)
            VALUES ('password_reset', ?, ?, ?, ?, 1, ?)`,
          args: [actorKey, requestId, id, nowIso, passwordHash],
        });
        const result = await transaction.execute({
          sql: `UPDATE users SET password_hash = ?, updated_at = ?, password_changed_at = ?, temporary_password_expires_at = ?
            WHERE id = ? AND password_hash = ?`,
          args: [
            passwordHash,
            nowIso,
            nowIso,
            new Date(now.getTime() + TEMPORARY_PASSWORD_TTL_MS).toISOString(),
            id,
            expectedPasswordHash,
          ],
        });
        if (result.rowsAffected === 0) {
          throw new AppError(
            409,
            "password_reset_conflict",
            "The password changed while this reset was in progress; start a new reset",
          );
        }
        await transaction.execute({
          sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          args: [nowIso, id],
        });
        await transaction.commit();
        return {
          user: {
            ...user,
            updatedAt: nowIso,
            passwordChangedAt: nowIso,
            temporaryPasswordExpiresAt: new Date(
              now.getTime() + TEMPORARY_PASSWORD_TTL_MS,
            ).toISOString(),
          },
          applied: true,
        };
      } catch (cause) {
        await transaction.rollback();
        throw cause;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  async listUsers(): Promise<User[]> {
    const result = await this.client.execute(
      "SELECT id, username, role, active, created_at, updated_at, password_changed_at, temporary_password_expires_at FROM users ORDER BY created_at, id",
    );
    return result.rows.map(userFromRow);
  }

  async usageByUser(
    userIds: string[],
    now = new Date(),
  ): Promise<
    Map<
      string,
      { apiKeys: number; sessions: number; lastActiveAt: string | null }
    >
  > {
    if (userIds.length === 0) return new Map();
    const placeholders = userIds.map(() => "?").join(",");
    const result = await this.client.execute({
      sql: `SELECT u.id,
        (SELECT COUNT(*) FROM api_keys k
          WHERE k.user_id = u.id AND k.revoked_at IS NULL AND k.status = 'active') AS api_keys,
        (SELECT COUNT(*) FROM sessions s
          WHERE s.user_id = u.id AND s.revoked_at IS NULL
            AND s.expires_at > ? AND s.idle_expires_at > ?) AS sessions,
        CASE
          WHEN (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) IS NULL
            THEN (SELECT MAX(k.last_used_at) FROM api_keys k WHERE k.user_id = u.id)
          WHEN (SELECT MAX(k.last_used_at) FROM api_keys k WHERE k.user_id = u.id) IS NULL
            THEN (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id)
          ELSE MAX(
            (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id),
            (SELECT MAX(k.last_used_at) FROM api_keys k WHERE k.user_id = u.id)
          )
        END AS last_active_at
        FROM users u WHERE u.id IN (${placeholders})`,
      args: [now.toISOString(), now.toISOString(), ...userIds],
    });
    return new Map(
      result.rows.map((row) => [
        stringColumn(row, "id"),
        {
          apiKeys: Number(row.api_keys),
          sessions: Number(row.sessions),
          lastActiveAt:
            typeof row.last_active_at === "string" ? row.last_active_at : null,
        },
      ]),
    );
  }

  async getUser(id: string): Promise<User | null> {
    const result = await this.client.execute({
      sql: "SELECT id, username, role, active, created_at, updated_at, password_changed_at, temporary_password_expires_at FROM users WHERE id = ?",
      args: [id],
    });
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  private async assertCurrentAdmin(
    executor: Pick<Client, "execute">,
    actorUserId: string | null | undefined,
  ): Promise<void> {
    if (actorUserId == null) return;
    const actor = await executor.execute({
      sql: "SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND active = 1",
      args: [actorUserId],
    });
    if (!actor.rows[0]) {
      throw new AppError(
        403,
        "admin_revoked",
        "Administrator access is no longer valid",
      );
    }
  }

  async setActive(
    id: string,
    active: boolean,
    actorUserId?: string | null,
  ): Promise<User> {
    return this.runExclusive(async () => {
      const now = new Date().toISOString();
      const transaction = await beginWriteTransaction(this.client);
      try {
        await this.assertCurrentAdmin(transaction, actorUserId);
        const lookup = await transaction.execute({
          sql: "SELECT id, username, role, active, created_at, updated_at, password_changed_at, temporary_password_expires_at FROM users WHERE id = ?",
          args: [id],
        });
        const row = lookup.rows[0];
        if (!row) {
          throw new AppError(404, "user_not_found", "User not found");
        }
        const current = userFromRow(row);
        const result = await transaction.execute({
          sql: `UPDATE users SET active = ?, updated_at = ?
            WHERE id = ? AND (
              ? = 1 OR role <> 'admin' OR active = 0 OR EXISTS (
                SELECT 1 FROM users other
                WHERE other.role = 'admin' AND other.active = 1 AND other.id <> ?
              )
            )`,
          args: [active ? 1 : 0, now, id, active ? 1 : 0, id],
        });
        if (result.rowsAffected === 0) {
          throw new AppError(
            409,
            "last_active_admin",
            "The last active admin cannot be disabled or demoted",
          );
        }
        if (!active) {
          // Revocation and the active-state transition commit atomically. A
          // later re-enable can therefore never revive a pre-disable cookie.
          await transaction.execute({
            sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
            args: [now, id],
          });
        }
        await transaction.commit();
        return { ...current, active, updatedAt: now };
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  async setRole(
    id: string,
    role: UserRole,
    actorUserId?: string | null,
  ): Promise<User> {
    return this.runExclusive(async () => {
      const now = new Date().toISOString();
      const transaction = await beginWriteTransaction(this.client);
      try {
        await this.assertCurrentAdmin(transaction, actorUserId);
        const lookup = await transaction.execute({
          sql: "SELECT id, username, role, active, created_at, updated_at, password_changed_at, temporary_password_expires_at FROM users WHERE id = ?",
          args: [id],
        });
        const row = lookup.rows[0];
        if (!row) throw new AppError(404, "user_not_found", "User not found");
        const current = userFromRow(row);
        const result = await transaction.execute({
          sql: `UPDATE users SET role = ?, updated_at = ?
            WHERE id = ? AND (
              ? = 'admin' OR role <> 'admin' OR active = 0 OR EXISTS (
                SELECT 1 FROM users other
                WHERE other.role = 'admin' AND other.active = 1 AND other.id <> ?
              )
            )`,
          args: [role, now, id, role, id],
        });
        if (result.rowsAffected === 0) {
          throw new AppError(
            409,
            "last_active_admin",
            "The last active admin cannot be disabled or demoted",
          );
        }
        await transaction.commit();
        return { ...current, role, updatedAt: now };
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  async setPassword(
    id: string,
    password: string,
    now = new Date(),
    expectedPasswordHash?: string,
    actorUserId?: string | null,
  ): Promise<User> {
    const user = await this.getUser(id);
    if (!user) throw new AppError(404, "user_not_found", "User not found");
    const passwordHash = await hashPassword(password);
    const temporaryPasswordExpiresAt =
      actorUserId === undefined
        ? null
        : new Date(now.getTime() + TEMPORARY_PASSWORD_TTL_MS).toISOString();
    return this.runExclusive(async () => {
      const transaction = await beginWriteTransaction(this.client);
      try {
        await this.assertCurrentAdmin(transaction, actorUserId);
        const result = await transaction.execute({
          sql: `UPDATE users SET password_hash = ?, updated_at = ?, password_changed_at = ?, temporary_password_expires_at = ? WHERE id = ?${
            expectedPasswordHash ? " AND password_hash = ? AND active = 1" : ""
          }`,
          args: expectedPasswordHash
            ? [
                passwordHash,
                now.toISOString(),
                now.toISOString(),
                temporaryPasswordExpiresAt,
                id,
                expectedPasswordHash,
              ]
            : [
                passwordHash,
                now.toISOString(),
                now.toISOString(),
                temporaryPasswordExpiresAt,
                id,
              ],
        });
        if (result.rowsAffected === 0) {
          throw new AppError(
            401,
            "invalid_credentials",
            "Credentials changed; please try again",
          );
        }
        await transaction.execute({
          sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          args: [now.toISOString(), id],
        });
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
      return {
        ...user,
        updatedAt: now.toISOString(),
        passwordChangedAt: now.toISOString(),
        temporaryPasswordExpiresAt,
      };
    });
  }

  async changePassword(
    id: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<User> {
    const result = await this.client.execute({
      sql: "SELECT password_hash FROM users WHERE id = ? AND active = 1",
      args: [id],
    });
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        401,
        "invalid_credentials",
        "Current password is invalid",
      );
    }
    const passwordHash = stringColumn(row, "password_hash");
    if (!(await verifyPassword(currentPassword, passwordHash))) {
      throw new AppError(
        401,
        "invalid_credentials",
        "Current password is invalid",
      );
    }
    return this.setPassword(id, newPassword, new Date(), passwordHash);
  }

  async changePasswordAndRotateSession(
    id: string,
    currentPassword: string,
    newPassword: string,
    currentSessionToken: string,
    now = new Date(),
  ): Promise<{ user: User; token: string; expiresAt: string }> {
    const credential = await this.getUserCredential(id);
    if (
      !credential?.user.active ||
      !(await verifyPassword(currentPassword, credential.passwordHash))
    ) {
      throw new AppError(
        401,
        "invalid_credentials",
        "Current password is invalid",
      );
    }
    const passwordHash = await hashPassword(newPassword);
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const nowIso = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + SESSION_MAX_TTL_MS,
    ).toISOString();
    const idleExpiresAt = new Date(
      now.getTime() + SESSION_IDLE_TTL_MS,
    ).toISOString();
    return this.runExclusive(async () => {
      const transaction = await beginWriteTransaction(this.client);
      try {
        const currentSession = await transaction.execute({
          sql: `SELECT id FROM sessions
            WHERE token_digest = ? AND user_id = ? AND revoked_at IS NULL
              AND expires_at > ? AND idle_expires_at > ?`,
          args: [digest(currentSessionToken), id, nowIso, nowIso],
        });
        if (!currentSession.rows[0]) {
          throw new AppError(401, "unauthorized", "Session expired");
        }
        const changed = await transaction.execute({
          sql: `UPDATE users SET password_hash = ?, updated_at = ?, password_changed_at = ?, temporary_password_expires_at = NULL
            WHERE id = ? AND password_hash = ? AND active = 1`,
          args: [passwordHash, nowIso, nowIso, id, credential.passwordHash],
        });
        if (changed.rowsAffected === 0) {
          throw new AppError(
            401,
            "invalid_credentials",
            "Credentials changed; please try again",
          );
        }
        await transaction.execute({
          sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          args: [nowIso, id],
        });
        await transaction.execute({
          sql: `INSERT INTO sessions
            (id, user_id, token_digest, created_at, last_seen_at, idle_expires_at, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          args: [
            sessionId,
            id,
            digest(token),
            nowIso,
            nowIso,
            idleExpiresAt,
            expiresAt,
          ],
        });
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
      return {
        user: {
          ...credential.user,
          updatedAt: nowIso,
          passwordChangedAt: nowIso,
          temporaryPasswordExpiresAt: null,
        },
        token,
        expiresAt,
      };
    });
  }

  async authenticatePassword(
    usernameInput: string,
    password: string,
    remoteAddress: string | null,
    now = new Date(),
  ): Promise<PasswordAuthentication> {
    let username: string | null = null;
    try {
      username = normalizeUsername(usernameInput);
    } catch {
      // Continue through the same bcrypt path to avoid username enumeration.
    }
    const throttleIdentity = username ?? `invalid:${digest(usernameInput)}`;
    const identityThrottleKey = digest(`identity\0${throttleIdentity}`);
    const addressThrottleKey = remoteAddress
      ? digest(`address\0${remoteAddress}`)
      : null;
    const throttleBuckets = [
      { key: identityThrottleKey, limit: MAX_LOGIN_FAILURES },
      ...(addressThrottleKey
        ? [{ key: addressThrottleKey, limit: MAX_ADDRESS_LOGIN_ATTEMPTS }]
        : []),
    ];
    await this.safeExecute({
      sql: "DELETE FROM login_failures WHERE window_started_at <= ?",
      args: [new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString()],
    });

    const reservations = await this.safeBatch(
      throttleBuckets.map(({ key }) => ({
        sql: `INSERT INTO login_failures (throttle_key, failures, window_started_at)
          VALUES (?, 1, ?)
          ON CONFLICT(throttle_key) DO UPDATE SET failures = login_failures.failures + 1
          RETURNING failures, window_started_at`,
        args: [key, now.toISOString()],
      })),
      "write",
    );
    const blockingReservations = reservations.filter(
      (reservation, index) =>
        Number(reservation.rows[0]?.failures) > throttleBuckets[index]!.limit,
    );
    if (blockingReservations.length > 0) {
      const retryAfterSeconds = Math.max(
        1,
        ...blockingReservations.map((reservation) => {
          const raw = reservation.rows[0]?.window_started_at;
          const started =
            typeof raw === "string" ? Date.parse(raw) : now.getTime();
          return Math.ceil((started + LOGIN_WINDOW_MS - now.getTime()) / 1000);
        }),
      );
      throw new AppError(
        429,
        "login_throttled",
        "Too many login attempts; try again later",
        { headers: { "retry-after": String(retryAfterSeconds) } },
      );
    }

    const row = username
      ? (
          await this.client.execute({
            sql: "SELECT * FROM users WHERE username = ? COLLATE NOCASE",
            args: [username],
          })
        ).rows[0]
      : undefined;
    const dummyHash =
      "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5fMltXVrRjRQgIaY10beI7u1Y7Q5n6e";
    const matches = await this.verifyPasswordForLogin(
      password,
      row ? stringColumn(row, "password_hash") : dummyHash,
    );
    if (!row || !matches) {
      throw new AppError(
        401,
        "invalid_credentials",
        "Invalid username or password",
      );
    }
    const successfulCleanup = [
      {
        sql: "DELETE FROM login_failures WHERE throttle_key = ?",
        args: [identityThrottleKey],
      },
      ...(addressThrottleKey
        ? [
            {
              sql: `UPDATE login_failures
                SET failures = failures - 1
                WHERE throttle_key = ?`,
              args: [addressThrottleKey],
            },
            {
              sql: `DELETE FROM login_failures
                WHERE throttle_key = ? AND failures <= 0`,
              args: [addressThrottleKey],
            },
          ]
        : []),
    ];
    // Keep the aggregate address history intact: this verified attempt removes
    // only its own reservation. The write batch is one transaction, so an
    // overlapping failure cannot be lost between decrement and zero cleanup.
    await this.safeBatch(successfulCleanup, "write");
    if (Number(row.active) !== 1) {
      throw new AppError(403, "account_disabled", "Account is disabled");
    }
    if (
      typeof row.temporary_password_expires_at === "string" &&
      row.temporary_password_expires_at <= now.toISOString()
    ) {
      throw new AppError(
        401,
        "temporary_password_expired",
        "Temporary password expired",
      );
    }
    return {
      user: userFromRow(row),
      passwordHash: stringColumn(row, "password_hash"),
    };
  }

  async createSession(
    subject: string | PasswordAuthentication,
    now?: Date,
  ): Promise<{ token: string; expiresAt: string }> {
    const authentication = typeof subject === "string" ? null : subject;
    const userId = typeof subject === "string" ? subject : subject.user.id;
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    return this.runExclusive(async () => {
      const transaction = await beginWriteTransaction(this.client);
      let expiresAt = "";
      try {
        // Production callers intentionally resolve the clock only after this
        // writer reaches its committing transaction. Tests can inject an exact
        // boundary instant through `now`.
        const commitTime = now ?? new Date();
        const commitTimeIso = commitTime.toISOString();
        expiresAt = new Date(
          commitTime.getTime() + SESSION_MAX_TTL_MS,
        ).toISOString();
        const idleExpiresAt = new Date(
          commitTime.getTime() + SESSION_IDLE_TTL_MS,
        ).toISOString();
        await transaction.execute({
          sql: "DELETE FROM sessions WHERE expires_at <= ? OR idle_expires_at <= ? OR revoked_at IS NOT NULL",
          args: [commitTimeIso, commitTimeIso],
        });
        const result = await transaction.execute({
          sql: authentication
            ? `INSERT INTO sessions
              (id, user_id, token_digest, created_at, last_seen_at, idle_expires_at, expires_at, revoked_at)
              SELECT ?, id, ?, ?, ?, ?, ?, NULL FROM users
              WHERE id = ? AND password_hash = ? AND active = 1
                AND (temporary_password_expires_at IS NULL
                  OR temporary_password_expires_at > ?)`
            : `INSERT INTO sessions
              (id, user_id, token_digest, created_at, last_seen_at, idle_expires_at, expires_at, revoked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          args: authentication
            ? [
                sessionId,
                digest(token),
                commitTimeIso,
                commitTimeIso,
                idleExpiresAt,
                expiresAt,
                userId,
                authentication.passwordHash,
                commitTimeIso,
              ]
            : [
                sessionId,
                userId,
                digest(token),
                commitTimeIso,
                commitTimeIso,
                idleExpiresAt,
                expiresAt,
              ],
        });
        if (authentication && result.rowsAffected === 0) {
          const current = await transaction.execute({
            sql: `SELECT temporary_password_expires_at FROM users
              WHERE id = ? AND password_hash = ? AND active = 1`,
            args: [userId, authentication.passwordHash],
          });
          const temporaryExpiry =
            current.rows[0]?.temporary_password_expires_at;
          if (
            typeof temporaryExpiry === "string" &&
            temporaryExpiry <= commitTimeIso
          ) {
            throw new AppError(
              401,
              "temporary_password_expired",
              "Temporary password expired",
            );
          }
          throw new AppError(
            401,
            "invalid_credentials",
            "Credentials changed; please log in again",
          );
        }
        if (authentication) {
          await transaction.execute({
            sql: `UPDATE users SET temporary_password_expires_at = NULL
              WHERE id = ? AND password_hash = ? AND active = 1
                AND temporary_password_expires_at IS NOT NULL`,
            args: [userId, authentication.passwordHash],
          });
        }
        await transaction.execute({
          sql: `DELETE FROM sessions WHERE id IN (
            SELECT id FROM sessions
            WHERE user_id = ? AND revoked_at IS NULL AND id <> ?
            ORDER BY created_at DESC, id DESC
            LIMIT -1 OFFSET 9
          )`,
          args: [userId, sessionId],
        });
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
      return { token, expiresAt };
    });
  }

  async resolveSession(
    token: string,
    now = new Date(),
    { slide = true }: { slide?: boolean } = {},
  ): Promise<User | null> {
    const nowIso = now.toISOString();
    const idleExpiresAt = new Date(
      now.getTime() + SESSION_IDLE_TTL_MS,
    ).toISOString();
    const selectLiveUser = async (): Promise<User | null> => {
      const result = await this.client.execute({
        sql: `SELECT u.* FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.token_digest = ? AND s.revoked_at IS NULL
            AND s.expires_at > ? AND s.idle_expires_at > ? AND u.active = 1`,
        args: [digest(token), nowIso, nowIso],
      });
      return result.rows[0] ? userFromRow(result.rows[0]) : null;
    };
    if (!slide) return selectLiveUser();
    return this.runExclusive(async () => {
      await this.safeExecute({
        sql: `UPDATE sessions
          SET last_seen_at = ?,
              idle_expires_at = CASE WHEN expires_at < ? THEN expires_at ELSE ? END
          WHERE token_digest = ?
            AND revoked_at IS NULL
            AND expires_at > ?
            AND idle_expires_at > ?
            AND last_seen_at <= ?
            AND EXISTS (
              SELECT 1 FROM users
              WHERE users.id = sessions.user_id AND users.active = 1
            )`,
        args: [
          nowIso,
          idleExpiresAt,
          idleExpiresAt,
          digest(token),
          nowIso,
          nowIso,
          nowIso,
        ],
      });
      return selectLiveUser();
    });
  }

  async sessionInfo(
    token: string,
    now = new Date(),
  ): Promise<{
    createdAt: string;
    lastSeenAt: string;
    idleExpiresAt: string;
    expiresAt: string;
  } | null> {
    const result = await this.client.execute({
      sql: `SELECT created_at, last_seen_at, idle_expires_at, expires_at FROM sessions
        WHERE token_digest = ? AND revoked_at IS NULL
          AND expires_at > ? AND idle_expires_at > ?`,
      args: [digest(token), now.toISOString(), now.toISOString()],
    });
    const row = result.rows[0];
    return row
      ? {
          createdAt: stringColumn(row, "created_at"),
          lastSeenAt: stringColumn(row, "last_seen_at"),
          idleExpiresAt: stringColumn(row, "idle_expires_at"),
          expiresAt: stringColumn(row, "expires_at"),
        }
      : null;
  }

  async revokeSession(token: string, now = new Date()): Promise<void> {
    await this.safeExecute({
      sql: "UPDATE sessions SET revoked_at = ? WHERE token_digest = ? AND revoked_at IS NULL",
      args: [now.toISOString(), digest(token)],
    });
  }

  private async validateKeyOwnerAndName(
    userId: string,
    nameInput: string,
  ): Promise<string> {
    if (!(await this.getUser(userId))) {
      throw new AppError(404, "user_not_found", "User not found");
    }
    const name = nameInput.trim();
    if (!name || Buffer.byteLength(name, "utf8") > 100) {
      throw new AppError(
        400,
        "invalid_api_key_name",
        "API key name must be 1-100 UTF-8 bytes",
      );
    }
    return name;
  }

  // Prune only (a) revoked records outside the documented retention
  // bounds (age, then count) for this owner and (b) expired pending rows
  // globally; recent revoked context stays listed for audit.
  private async pruneApiKeys(
    executor: Pick<Client, "execute">,
    userId: string,
    now: Date,
  ): Promise<void> {
    const nowIso = now.toISOString();
    const ageCutoff = new Date(
      now.getTime() - REVOKED_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const retainedOverflow = `SELECT id FROM api_keys
      WHERE user_id = ? AND revoked_at IS NOT NULL AND (
        revoked_at <= ?
        OR id IN (
          SELECT id FROM api_keys
          WHERE user_id = ? AND revoked_at IS NOT NULL
          ORDER BY revoked_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      )`;
    const retainedArgs = [
      userId,
      ageCutoff,
      userId,
      REVOKED_KEY_RETENTION_COUNT,
    ];
    await executor.execute({
      sql: `UPDATE api_key_idempotent_operations
        SET terminal_code = 'api_key_not_found', terminal_at = COALESCE(terminal_at, ?)
        WHERE key_id IN (${retainedOverflow})`,
      args: [nowIso, ...retainedArgs],
    });
    await executor.execute({
      sql: `DELETE FROM api_keys WHERE id IN (${retainedOverflow})`,
      args: retainedArgs,
    });
    await executor.execute({
      sql: `UPDATE api_key_idempotent_operations
        SET terminal_code = 'pending_expired', terminal_at = COALESCE(terminal_at, ?)
        WHERE key_id IN (
          SELECT id FROM api_keys
          WHERE status = 'pending' AND pending_expires_at <= ?
        )`,
      args: [nowIso, nowIso],
    });
    await executor.execute({
      sql: `DELETE FROM api_keys
        WHERE status = 'pending' AND pending_expires_at <= ?`,
      args: [nowIso],
    });
    await AuthRepository.pruneApiKeyIdempotencyTombstones(executor, now);
  }

  private newSecret(): { secret: string; id: string } {
    return {
      secret: `fsk_${randomBytes(32).toString("base64url")}`,
      id: randomUUID(),
    };
  }

  async createApiKey(
    userId: string,
    nameInput: string,
    now = new Date(),
    actorUserId?: string | null,
  ): Promise<{ id: string; secret: string }> {
    const name = await this.validateKeyOwnerAndName(userId, nameInput);
    return this.runExclusive(async () => {
      const transaction = await beginWriteTransaction(this.client);
      try {
        if (actorUserId != null) {
          const actor = await transaction.execute({
            sql: `SELECT 1 FROM users WHERE id = ? AND active = 1
              AND (id = ? OR role = 'admin')`,
            args: [actorUserId, userId],
          });
          if (!actor.rows[0]) {
            throw new AppError(404, "user_not_found", "User not found");
          }
        }
        const owner = await transaction.execute({
          sql: "SELECT 1 FROM users WHERE id = ? AND active = 1",
          args: [userId],
        });
        if (!owner.rows[0]) {
          throw new AppError(404, "user_not_found", "User not found");
        }
        await this.pruneApiKeys(transaction, userId, now);
        const counts = await transaction.execute({
          sql: `SELECT COUNT(*) AS reserved_count FROM api_keys
            WHERE user_id = ? AND revoked_at IS NULL
              AND status IN ('pending', 'active')`,
          args: [userId],
        });
        if (
          Number(counts.rows[0]?.reserved_count ?? 0) >= MAX_ACTIVE_API_KEYS
        ) {
          throw new AppError(
            409,
            "api_key_limit",
            `A user can have at most ${MAX_ACTIVE_API_KEYS} active API keys`,
          );
        }

        const { secret, id } = this.newSecret();
        const result = await transaction.execute({
          sql: `INSERT INTO api_keys
            (id, user_id, name, key_digest, key_prefix, last_four, created_at, last_used_at, expires_at, revoked_at, status, request_id, pending_expires_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'active', NULL, NULL
            WHERE (SELECT COUNT(*) FROM api_keys
              WHERE user_id = ? AND revoked_at IS NULL
                AND status IN ('pending', 'active')) < ?
              AND EXISTS (
                SELECT 1 FROM users owner WHERE owner.id = ? AND owner.active = 1
              )
              AND (? IS NULL OR EXISTS (
                SELECT 1 FROM users actor WHERE actor.id = ? AND actor.active = 1
                  AND (actor.id = ? OR actor.role = 'admin')
              ))`,
          args: [
            id,
            userId,
            name,
            digest(secret),
            secret.slice(0, 12),
            secret.slice(-4),
            now.toISOString(),
            userId,
            MAX_ACTIVE_API_KEYS,
            userId,
            actorUserId ?? null,
            actorUserId ?? null,
            userId,
          ],
        });
        if (result.rowsAffected !== 1) {
          throw new AppError(
            409,
            "api_key_state_changed",
            "API key creation state changed; try again",
          );
        }
        await transaction.commit();
        return { id, secret };
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  private async findKeyByRequestId(
    requestId: string,
    executor: Pick<Client, "execute"> = this.client,
  ): Promise<{
    ownerUserId: string;
    intentName: string;
    pendingExpiresAt: string | null;
    terminalCode: "pending_expired" | "api_key_not_found" | null;
    terminalAt: string | null;
    result: BeginApiKeyCreationResult | null;
  } | null> {
    const existing = await executor.execute({
      sql: `SELECT operation.user_id, operation.intent_name,
          operation.pending_expires_at, operation.terminal_code,
          operation.terminal_at,
          key.id, key.name, key.status, key.pending_expires_at AS key_pending_expires_at
        FROM api_key_idempotent_operations operation
        LEFT JOIN api_keys key ON key.id = operation.key_id
        WHERE operation.request_id = ?`,
      args: [requestId],
    });
    const row = existing.rows[0];
    if (!row) return null;
    const keyId = typeof row.id === "string" ? row.id : null;
    return {
      ownerUserId: stringColumn(row, "user_id"),
      intentName: stringColumn(row, "intent_name"),
      pendingExpiresAt:
        typeof row.pending_expires_at === "string"
          ? row.pending_expires_at
          : null,
      terminalCode:
        row.terminal_code === "pending_expired" ||
        row.terminal_code === "api_key_not_found"
          ? row.terminal_code
          : null,
      terminalAt: typeof row.terminal_at === "string" ? row.terminal_at : null,
      result: keyId
        ? {
            created: false,
            id: keyId,
            name: stringColumn(row, "name"),
            // Idempotent retries NEVER re-expose the plaintext secret.
            secret: null,
            status: stringColumn(row, "status") as ApiKeyStatus,
            pendingExpiresAt:
              typeof row.key_pending_expires_at === "string"
                ? row.key_pending_expires_at
                : null,
          }
        : null,
    };
  }

  // Phase 1 of browser key creation: commit a PENDING, non-authenticating
  // row under the caller's idempotency request id and return the
  // show-once secret exactly once.
  async beginApiKeyCreation(
    userId: string,
    nameInput: string,
    requestId: string,
    now = new Date(),
    actorUserId?: string | null,
  ): Promise<BeginApiKeyCreationResult> {
    if (!requestId || requestId.length > 128) {
      throw new AppError(
        400,
        "invalid_request_id",
        "request_id must be 1-128 characters",
      );
    }
    const name = await this.validateKeyOwnerAndName(userId, nameInput);
    const nowIso = now.toISOString();
    const terminalCutoff = new Date(
      now.getTime() - API_KEY_IDEMPOTENCY_RETENTION_MS,
    ).toISOString();
    const assertMatchingIntent = (
      existing: {
        ownerUserId: string;
        intentName: string;
        pendingExpiresAt: string | null;
        terminalCode: "pending_expired" | "api_key_not_found" | null;
        terminalAt: string | null;
        result: BeginApiKeyCreationResult | null;
      } | null,
    ): BeginApiKeyCreationResult | null => {
      if (
        existing?.terminalCode &&
        existing.terminalAt &&
        existing.terminalAt <= terminalCutoff
      ) {
        // Treat an expired terminal binding as absent only provisionally. The
        // authorized write transaction below must delete it before a new row
        // can claim this request id; unauthorized/failed attempts roll back.
        return null;
      }
      if (
        existing &&
        (existing.ownerUserId !== userId || existing.intentName !== name)
      ) {
        throw new AppError(
          409,
          "request_id_conflict",
          "request_id is already bound to another API key creation",
        );
      }
      if (existing?.terminalCode === "pending_expired") {
        throw new AppError(
          410,
          "pending_expired",
          "Pending API key expired; create a new key",
        );
      }
      if (existing?.terminalCode === "api_key_not_found") {
        throw new AppError(
          410,
          "api_key_not_found",
          "API key no longer exists; create a new key",
        );
      }
      if (
        existing?.result?.status === "pending" &&
        (!existing.pendingExpiresAt || existing.pendingExpiresAt <= nowIso)
      ) {
        throw new AppError(
          410,
          "pending_expired",
          "Pending API key expired; create a new key",
        );
      }
      if (existing && !existing.result) {
        throw new AppError(
          410,
          "api_key_not_found",
          "API key no longer exists; create a new key",
        );
      }
      return existing?.result ?? null;
    };
    const existing = assertMatchingIntent(
      await this.findKeyByRequestId(requestId),
    );
    if (existing) return existing;
    return this.runExclusive(async () => {
      const transaction = await beginWriteTransaction(this.client);
      try {
        const reconciled = assertMatchingIntent(
          await this.findKeyByRequestId(requestId, transaction),
        );
        if (reconciled) {
          await transaction.commit();
          return reconciled;
        }
        const owner = await transaction.execute({
          sql: "SELECT 1 FROM users WHERE id = ? AND active = 1",
          args: [userId],
        });
        if (!owner.rows[0]) {
          throw new AppError(404, "user_not_found", "User not found");
        }
        if (actorUserId != null) {
          const actor = await transaction.execute({
            sql: `SELECT 1 FROM users WHERE id = ? AND active = 1
              AND (id = ? OR role = 'admin')`,
            args: [actorUserId, userId],
          });
          if (!actor.rows[0]) {
            throw new AppError(404, "user_not_found", "User not found");
          }
        }
        await this.pruneApiKeys(transaction, userId, now);
        const counts = await transaction.execute({
          sql: `SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
            COUNT(*) AS reserved_count
            FROM api_keys
            WHERE user_id = ? AND revoked_at IS NULL
              AND status IN ('pending', 'active')`,
          args: [userId],
        });
        const pendingCount = Number(counts.rows[0]?.pending_count ?? 0);
        const reservedCount = Number(counts.rows[0]?.reserved_count ?? 0);
        if (reservedCount >= MAX_ACTIVE_API_KEYS) {
          throw new AppError(
            409,
            "api_key_limit",
            `A user can have at most ${MAX_ACTIVE_API_KEYS} active API keys`,
          );
        }
        if (pendingCount >= MAX_PENDING_API_KEYS) {
          throw new AppError(
            409,
            "pending_key_limit",
            `A user can have at most ${MAX_PENDING_API_KEYS} pending API keys`,
          );
        }

        // The write transaction reserves capacity before any secret is minted.
        // The INSERT repeats every owner/actor/cap predicate in the committing
        // statement so the invariant remains local and auditable.
        const { secret, id } = this.newSecret();
        const pendingExpiresAt = new Date(
          now.getTime() + PENDING_API_KEY_TTL_MS,
        ).toISOString();
        const result = await transaction.execute({
          sql: `INSERT INTO api_keys
            (id, user_id, name, key_digest, key_prefix, last_four, created_at, last_used_at, expires_at, revoked_at, status, request_id, pending_expires_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'pending', ?, ?
            WHERE (SELECT COUNT(*) FROM api_keys
              WHERE user_id = ? AND status = 'pending') < ?
              AND (SELECT COUNT(*) FROM api_keys
                WHERE user_id = ? AND revoked_at IS NULL
                  AND status IN ('pending', 'active')) < ?
              AND EXISTS (
                SELECT 1 FROM users owner WHERE owner.id = ? AND owner.active = 1
              )
              AND (? IS NULL OR EXISTS (
                SELECT 1 FROM users actor WHERE actor.id = ? AND actor.active = 1
                  AND (actor.id = ? OR actor.role = 'admin')
              ))`,
          args: [
            id,
            userId,
            name,
            digest(secret),
            secret.slice(0, 12),
            secret.slice(-4),
            nowIso,
            requestId,
            pendingExpiresAt,
            userId,
            MAX_PENDING_API_KEYS,
            userId,
            MAX_ACTIVE_API_KEYS,
            userId,
            actorUserId ?? null,
            actorUserId ?? null,
            userId,
          ],
        });
        if (result.rowsAffected !== 1) {
          throw new AppError(
            409,
            "api_key_state_changed",
            "API key creation state changed; try again",
          );
        }
        await transaction.execute({
          sql: `INSERT INTO api_key_idempotent_operations
            (request_id, user_id, intent_version, intent_name, key_id,
              pending_expires_at, terminal_code, created_at)
            VALUES (?, ?, 1, ?, ?, ?, NULL, ?)`,
          args: [requestId, userId, name, id, pendingExpiresAt, nowIso],
        });
        await transaction.commit();
        return {
          created: true,
          id,
          name,
          secret,
          status: "pending" as const,
          pendingExpiresAt,
        };
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  // Phase 2: activate a pending key only after the client confirmed it
  // received the secret. Idempotent — re-activating an active key
  // reconciles a lost activation response.
  async activateApiKey(
    id: string,
    actorUserId: string | null,
    _actorWasAdmin: boolean,
    now = new Date(),
  ): Promise<{ id: string; status: ApiKeyStatus }> {
    return this.runExclusive(async () => {
      const transaction = await beginWriteTransaction(this.client, {
        retryBusy: true,
        foreignKeys: true,
      });
      const readRow = async () => {
        const lookup = await transaction.execute({
          sql: `SELECT id, user_id, status, revoked_at, pending_expires_at
            FROM api_keys WHERE id = ? AND (
              ? IS NULL OR EXISTS (
                SELECT 1 FROM users actor WHERE actor.id = ? AND actor.active = 1
                  AND (actor.id = api_keys.user_id OR actor.role = 'admin')
              )
            ) AND EXISTS (
              SELECT 1 FROM users owner
              WHERE owner.id = api_keys.user_id AND owner.active = 1
            )`,
          args: [id, actorUserId, actorUserId],
        });
        return lookup.rows[0];
      };
      const assertNotRevokedOrMissing = (row: Row | undefined): Row => {
        if (!row) {
          throw new AppError(404, "api_key_not_found", "API key not found");
        }
        if (typeof row.revoked_at === "string") {
          throw new AppError(
            409,
            "api_key_revoked",
            "This API key has been revoked",
          );
        }
        return row;
      };
      const assertNotExpired = (row: Row): void => {
        const expiresAt =
          typeof row.pending_expires_at === "string"
            ? row.pending_expires_at
            : null;
        if (!expiresAt || expiresAt <= now.toISOString()) {
          throw new AppError(
            410,
            "pending_expired",
            "This pending API key has expired; create a new key",
          );
        }
      };
      try {
        let row = assertNotRevokedOrMissing(await readRow());
        if (stringColumn(row, "status") !== "active") {
          assertNotExpired(row);
        }
        await AuthRepository.pruneApiKeyIdempotencyTombstones(transaction, now);
        if (stringColumn(row, "status") === "active") {
          await transaction.commit();
          return { id, status: "active" };
        }
        const userId = stringColumn(row, "user_id");
        const result = await transaction.execute({
          sql: `UPDATE api_keys SET status = 'active', pending_expires_at = NULL
            WHERE id = ? AND status = 'pending' AND revoked_at IS NULL
              AND pending_expires_at > ?
              AND (SELECT COUNT(*) FROM api_keys
                WHERE user_id = ? AND revoked_at IS NULL AND status = 'active') < ?
              AND EXISTS (
                SELECT 1 FROM users owner
                WHERE owner.id = api_keys.user_id AND owner.active = 1
              )
              AND (? IS NULL OR EXISTS (
                SELECT 1 FROM users actor WHERE actor.id = ? AND actor.active = 1
                  AND (actor.id = api_keys.user_id OR actor.role = 'admin')
              ))`,
          args: [
            id,
            now.toISOString(),
            userId,
            MAX_ACTIVE_API_KEYS,
            actorUserId,
            actorUserId,
          ],
        });
        if (result.rowsAffected === 0) {
          row = assertNotRevokedOrMissing(await readRow());
          if (stringColumn(row, "status") !== "active") {
            assertNotExpired(row);
            throw new AppError(
              409,
              "api_key_limit",
              `A user can have at most ${MAX_ACTIVE_API_KEYS} active API keys`,
            );
          }
        }
        await transaction.commit();
        return { id, status: "active" };
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction, {
          foreignKeys: true,
        });
      }
    });
  }

  async resolveApiKey(secret: string, now = new Date()): Promise<User | null> {
    const keyDigest = digest(secret);
    const nowIso = now.toISOString();
    return this.runExclusive(async () => {
      const transaction = await beginWriteTransaction(this.client, {
        retryBusy: true,
        foreignKeys: true,
      });
      try {
        const result = await transaction.execute({
          sql: `SELECT k.id AS key_id, u.id, u.username, u.role, u.active, u.created_at, u.updated_at, u.password_changed_at, u.temporary_password_expires_at
            FROM api_keys k JOIN users u ON u.id = k.user_id
            WHERE k.key_digest = ? AND k.revoked_at IS NULL
              AND k.status = 'active'
              AND (k.expires_at IS NULL OR k.expires_at > ?) AND u.active = 1`,
          args: [keyDigest, nowIso],
        });
        const row = result.rows[0];
        if (!row) {
          await transaction.commit();
          return null;
        }
        const recorded = await transaction.execute({
          sql: `UPDATE api_keys SET last_used_at = ?
            WHERE id = ? AND key_digest = ? AND revoked_at IS NULL
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > ?)
              AND EXISTS (
                SELECT 1 FROM users
                WHERE users.id = api_keys.user_id AND users.active = 1
              )`,
          args: [nowIso, stringColumn(row, "key_id"), keyDigest, nowIso],
        });
        if (recorded.rowsAffected !== 1) {
          await transaction.commit();
          return null;
        }
        await transaction.commit();
        return userFromRow(row);
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction, {
          foreignKeys: true,
        });
      }
    });
  }

  async listApiKeys(
    userId?: string,
    now = new Date(),
  ): Promise<ApiKeyMetadata[]> {
    const nowIso = now.toISOString();
    const cutoff = new Date(
      now.getTime() - REVOKED_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = await this.client.execute({
      sql: `SELECT id, user_id, name, key_prefix, last_four, created_at, last_used_at, revoked_at, status, pending_expires_at
        FROM api_keys
        WHERE ${userId ? "user_id = ? AND" : ""}
          (status != 'pending' OR pending_expires_at > ?) AND (
          revoked_at IS NULL OR (
            revoked_at > ? AND (
              SELECT COUNT(*) FROM api_keys newer
              WHERE newer.user_id = api_keys.user_id
                AND newer.revoked_at IS NOT NULL
                AND (newer.revoked_at > api_keys.revoked_at
                  OR (newer.revoked_at = api_keys.revoked_at
                    AND newer.id > api_keys.id))
            ) < ?
          )
        )
        ORDER BY created_at, id`,
      args: [
        ...(userId ? [userId] : []),
        nowIso,
        cutoff,
        REVOKED_KEY_RETENTION_COUNT,
      ],
    });
    return result.rows.map((row) => ({
      id: stringColumn(row, "id"),
      userId: stringColumn(row, "user_id"),
      name: stringColumn(row, "name"),
      prefix: stringColumn(row, "key_prefix"),
      lastFour: stringColumn(row, "last_four"),
      createdAt: stringColumn(row, "created_at"),
      lastUsedAt:
        typeof row.last_used_at === "string" ? row.last_used_at : null,
      revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
      status: stringColumn(row, "status") as ApiKeyStatus,
      pendingExpiresAt:
        typeof row.pending_expires_at === "string"
          ? row.pending_expires_at
          : null,
    }));
  }

  // Single-query aggregate for the admin key view: every user's keys with
  // owner identity, keyset-paginated in SQL. Replaces the O(users) client
  // fan-out and cannot be poisoned by one owner's failure. The optional
  // search is applied in SQL before pagination, so an empty result is a
  // truthful global claim, never a page-local one.
  async listAllApiKeys(options: {
    limit: number;
    cursor?: ApiKeyCursor;
    q?: string;
    now?: Date;
  }): Promise<ApiKeyPage> {
    const limit = Math.min(Math.max(options.limit, 1), 200);
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const cutoff = new Date(
      now.getTime() - REVOKED_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const clauses: string[] = [
      "(k.status != 'pending' OR k.pending_expires_at > ?)",
      `(k.revoked_at IS NULL OR (
        k.revoked_at > ? AND (
          SELECT COUNT(*) FROM api_keys newer
          WHERE newer.user_id = k.user_id AND newer.revoked_at IS NOT NULL
            AND (newer.revoked_at > k.revoked_at
              OR (newer.revoked_at = k.revoked_at AND newer.id > k.id))
        ) < ?
      ))`,
    ];
    const args: (string | number)[] = [
      nowIso,
      cutoff,
      REVOKED_KEY_RETENTION_COUNT,
    ];
    const query = options.q?.trim();
    if (query) {
      // Parameterized case-insensitive contains-match on key name and
      // owner username; LIKE wildcards in the query are escaped so they
      // match literally.
      const escaped = query.replace(/([\\%_])/gu, "\\$1");
      const pattern = `%${escaped}%`;
      clauses.push(
        "(k.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')",
      );
      args.push(pattern, pattern);
    }
    const countWhere = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const countArgs = [...args];
    if (options.cursor) {
      clauses.push("(k.created_at < ? OR (k.created_at = ? AND k.id < ?))");
      args.push(
        options.cursor.createdAt,
        options.cursor.createdAt,
        options.cursor.id,
      );
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    args.push(limit + 1);
    const batchResults = await this.client.batch(
      [
        {
          sql: `SELECT COUNT(*) AS total,
            SUM(CASE WHEN k.status = 'active' AND k.revoked_at IS NULL THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN k.status = 'pending' THEN 1 ELSE 0 END) AS pending
            FROM api_keys k JOIN users u ON u.id = k.user_id ${countWhere}`,
          args: countArgs,
        },
        {
          sql: `SELECT k.id, k.user_id, k.name, k.key_prefix, k.last_four,
          k.created_at, k.last_used_at, k.revoked_at, k.status,
          k.pending_expires_at,
          u.username AS owner_username
        FROM api_keys k JOIN users u ON u.id = k.user_id
        ${where}
        ORDER BY k.created_at DESC, k.id DESC
        LIMIT ?`,
          args,
        },
      ],
      "read",
    );
    const totalsResult = batchResults[0]!;
    const result = batchResults[1]!;
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const apiKeys = rows.map((row) => ({
      id: stringColumn(row, "id"),
      userId: stringColumn(row, "user_id"),
      name: stringColumn(row, "name"),
      prefix: stringColumn(row, "key_prefix"),
      lastFour: stringColumn(row, "last_four"),
      createdAt: stringColumn(row, "created_at"),
      lastUsedAt:
        typeof row.last_used_at === "string" ? row.last_used_at : null,
      revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
      status: stringColumn(row, "status") as ApiKeyStatus,
      pendingExpiresAt:
        typeof row.pending_expires_at === "string"
          ? row.pending_expires_at
          : null,
      ownerUsername: stringColumn(row, "owner_username"),
    }));
    const last = apiKeys.at(-1);
    return {
      apiKeys,
      totals: {
        total: Number(totalsResult.rows[0]?.total ?? 0),
        active: Number(totalsResult.rows[0]?.active ?? 0),
        pending: Number(totalsResult.rows[0]?.pending ?? 0),
      },
      nextCursor:
        hasMore && last
          ? encodeApiKeyCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async revokeApiKey(
    id: string,
    actorUserId: string | null,
    _actorWasAdmin: boolean,
    now = new Date(),
  ): Promise<void> {
    const nowIso = now.toISOString();
    return this.runExclusive(async () => {
      const transaction = await beginWriteTransaction(this.client, {
        retryBusy: true,
        foreignKeys: true,
      });
      try {
        const lookup = await transaction.execute({
          sql: `SELECT user_id, status, pending_expires_at FROM api_keys
            WHERE id = ? AND revoked_at IS NULL AND (
              ? IS NULL OR EXISTS (
                SELECT 1 FROM users actor
                WHERE actor.id = ? AND actor.active = 1
                  AND (actor.id = api_keys.user_id OR actor.role = 'admin')
              )
            )`,
          args: [id, actorUserId, actorUserId],
        });
        const row = lookup.rows[0];
        if (!row) {
          throw new AppError(404, "api_key_not_found", "API key not found");
        }
        const userId = stringColumn(row, "user_id");
        await AuthRepository.pruneApiKeyIdempotencyTombstones(transaction, now);
        if (stringColumn(row, "status") === "pending") {
          if (
            typeof row.pending_expires_at !== "string" ||
            row.pending_expires_at <= nowIso
          ) {
            throw new AppError(
              410,
              "pending_expired",
              "Pending API key expired; create a new key",
            );
          }
          await transaction.execute({
            sql: `UPDATE api_key_idempotent_operations
              SET terminal_code = 'api_key_not_found', terminal_at = COALESCE(terminal_at, ?)
              WHERE key_id = ?`,
            args: [nowIso, id],
          });
          const cancelled = await transaction.execute({
            sql: `DELETE FROM api_keys
              WHERE id = ? AND status = 'pending' AND revoked_at IS NULL AND (
                ? IS NULL OR EXISTS (
                  SELECT 1 FROM users actor
                  WHERE actor.id = ? AND actor.active = 1
                    AND (actor.id = api_keys.user_id OR actor.role = 'admin')
                )
              )`,
            args: [id, actorUserId, actorUserId],
          });
          if (cancelled.rowsAffected !== 1) {
            throw new AppError(404, "api_key_not_found", "API key not found");
          }
        } else {
          const revoked = await transaction.execute({
            sql: `UPDATE api_keys SET revoked_at = ?
              WHERE id = ? AND revoked_at IS NULL AND (
                ? IS NULL OR EXISTS (
                  SELECT 1 FROM users actor
                  WHERE actor.id = ? AND actor.active = 1
                    AND (actor.id = api_keys.user_id OR actor.role = 'admin')
                )
              )`,
            args: [nowIso, id, actorUserId, actorUserId],
          });
          if (revoked.rowsAffected !== 1) {
            throw new AppError(404, "api_key_not_found", "API key not found");
          }
        }
        await this.pruneApiKeys(transaction, userId, now);
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction, {
          foreignKeys: true,
        });
      }
    });
  }
}
