import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient, type Client, type Row } from "@libsql/client";

import { prepareLocalDatabaseDirectory } from "../files/database-url";
import { AppError } from "../files/errors";
import { hashPassword, normalizeUsername, verifyPassword } from "./password";

export type UserRole = "admin" | "member";

export interface User {
  id: string;
  username: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PasswordAuthentication {
  user: User;
  passwordHash: string;
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

const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS users_role_active_idx ON users(role, active);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE CHECK(length(token_digest) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON sessions(user_id, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_revoked_idx ON sessions(revoked_at);

CREATE TABLE IF NOT EXISTS api_keys (${API_KEYS_COLUMNS});
CREATE INDEX IF NOT EXISTS api_keys_user_active_idx ON api_keys(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS idempotent_operations (
  operation TEXT NOT NULL CHECK(operation IN ('user_create', 'password_reset')),
  actor_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation, actor_key, request_id)
);
CREATE INDEX IF NOT EXISTS idempotent_operations_created_idx ON idempotent_operations(created_at);
CREATE INDEX IF NOT EXISTS idempotent_operations_user_idx ON idempotent_operations(user_id);

CREATE TABLE IF NOT EXISTS login_failures (
  throttle_key TEXT PRIMARY KEY NOT NULL,
  failures INTEGER NOT NULL,
  window_started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_window_idx ON login_failures(window_started_at);
`;

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
  };
}

export class AuthRepository {
  private constructor(private readonly client: Client) {}

  static async create(databaseUrl: string): Promise<AuthRepository> {
    await prepareLocalDatabaseDirectory(databaseUrl);
    const client = createClient({ url: databaseUrl, intMode: "number" });
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.executeMultiple(AUTH_SCHEMA);
    await AuthRepository.migrateApiKeysSchema(client);
    await client.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS api_keys_request_idx
        ON api_keys(request_id) WHERE request_id IS NOT NULL`,
    );
    return new AuthRepository(client);
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
    const transaction = await client.transaction("write");
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
      transaction.close();
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
    const transaction = await this.client.transaction("write");
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
          (id, username, password_hash, role, active, created_at, updated_at)
          VALUES (?, ?, ?, 'admin', 1, ?, ?)`,
        args: [id, username, passwordHash, now, now],
      });
      await transaction.commit();
      return {
        id,
        username,
        role: "admin",
        active: true,
        createdAt: now,
        updatedAt: now,
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
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
    try {
      const result = await this.client.execute({
        sql: `INSERT INTO users
          (id, username, password_hash, role, active, created_at, updated_at)
          SELECT ?, ?, ?, ?, 1, ?, ?
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
          actorUserId ?? null,
          actorUserId ?? null,
        ],
      });
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
    };
  }

  // Serializes this repository's multi-statement write transactions: the
  // local libsql client rejects an overlapping BEGIN on one connection
  // with SQLITE_BUSY instead of queueing. Cross-process writers still
  // serialize through BEGIN IMMEDIATE + busy_timeout.
  private writeQueue: Promise<unknown> = Promise.resolve();
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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

  private async pruneIdempotentOperations(now: Date): Promise<void> {
    await this.client.execute({
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
  ): Promise<string | null> {
    const result = await this.client.execute({
      sql: `SELECT user_id FROM idempotent_operations
        WHERE operation = ? AND actor_key = ? AND request_id = ?`,
      args: [operation, actorKey, requestId],
    });
    const row = result.rows[0];
    return row ? stringColumn(row, "user_id") : null;
  }

  private async getUserCredential(
    id: string,
  ): Promise<{ user: User; passwordHash: string } | null> {
    const result = await this.client.execute({
      sql: `SELECT id, username, password_hash, role, active, created_at, updated_at
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
    await this.pruneIdempotentOperations(now);
    const replay = async (): Promise<{ user: User; created: false } | null> => {
      const userId = await this.findIdempotentOperation(
        "user_create",
        actorKey,
        requestId,
      );
      if (!userId) return null;
      const credential = await this.getUserCredential(userId);
      if (!credential) return null;
      if (credential.user.username !== username) {
        throw new AppError(
          409,
          "request_id_conflict",
          "request_id is already bound to another user creation",
        );
      }
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
      const transaction = await this.client.transaction("write");
      try {
        const result = await transaction.execute({
          sql: `INSERT INTO users
            (id, username, password_hash, role, active, created_at, updated_at)
            SELECT ?, ?, ?, ?, 1, ?, ?
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
            (operation, actor_key, request_id, user_id, created_at)
            VALUES ('user_create', ?, ?, ?, ?)`,
          args: [actorKey, requestId, id, nowIso],
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
        transaction.close();
      }
      return {
        user: {
          id,
          username,
          role: input.role,
          active: true,
          createdAt: nowIso,
          updatedAt: nowIso,
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
    await this.pruneIdempotentOperations(now);
    const replay = async (): Promise<{ user: User; applied: false } | null> => {
      const userId = await this.findIdempotentOperation(
        "password_reset",
        actorKey,
        requestId,
      );
      if (!userId) return null;
      if (userId !== id) {
        throw new AppError(
          409,
          "request_id_conflict",
          "request_id is already bound to another password reset",
        );
      }
      const current = await this.getUserCredential(userId);
      if (!current) return null;
      if (!(await verifyPassword(password, current.passwordHash))) {
        throw new AppError(
          409,
          "credential_superseded",
          "A newer password is active; start a new reset",
        );
      }
      return { user: current.user, applied: false };
    };
    const existing = await replay();
    if (existing) return existing;
    return this.runExclusive(async () => {
      const reconciled = await replay();
      if (reconciled) return reconciled;
      const nowIso = now.toISOString();
      const transaction = await this.client.transaction("write");
      try {
        await transaction.execute({
          sql: `INSERT INTO idempotent_operations
            (operation, actor_key, request_id, user_id, created_at)
            VALUES ('password_reset', ?, ?, ?, ?)`,
          args: [actorKey, requestId, id, nowIso],
        });
        const result = await transaction.execute({
          sql: `UPDATE users SET password_hash = ?, updated_at = ?
            WHERE id = ? AND password_hash = ?`,
          args: [passwordHash, nowIso, id, expectedPasswordHash],
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
      } catch (cause) {
        await transaction.rollback();
        if (String(cause).toLocaleLowerCase("en-US").includes("unique")) {
          const raced = await replay();
          if (raced) return raced;
        }
        throw cause;
      } finally {
        transaction.close();
      }
      return { user: { ...user, updatedAt: nowIso }, applied: true };
    });
  }

  async listUsers(): Promise<User[]> {
    const result = await this.client.execute(
      "SELECT id, username, role, active, created_at, updated_at FROM users ORDER BY created_at, id",
    );
    return result.rows.map(userFromRow);
  }

  async getUser(id: string): Promise<User | null> {
    const result = await this.client.execute({
      sql: "SELECT id, username, role, active, created_at, updated_at FROM users WHERE id = ?",
      args: [id],
    });
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  async setActive(id: string, active: boolean): Promise<User> {
    const current = await this.getUser(id);
    if (!current) throw new AppError(404, "user_not_found", "User not found");
    const now = new Date().toISOString();
    const result = await this.client.execute({
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
    return { ...current, active, updatedAt: now };
  }

  async setRole(id: string, role: UserRole): Promise<User> {
    const current = await this.getUser(id);
    if (!current) throw new AppError(404, "user_not_found", "User not found");
    const now = new Date().toISOString();
    const result = await this.client.execute({
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
    return { ...current, role, updatedAt: now };
  }

  async setPassword(
    id: string,
    password: string,
    now = new Date(),
    expectedPasswordHash?: string,
  ): Promise<User> {
    const user = await this.getUser(id);
    if (!user) throw new AppError(404, "user_not_found", "User not found");
    const passwordHash = await hashPassword(password);
    const transaction = await this.client.transaction("write");
    try {
      const result = await transaction.execute({
        sql: `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?${
          expectedPasswordHash ? " AND password_hash = ? AND active = 1" : ""
        }`,
        args: expectedPasswordHash
          ? [passwordHash, now.toISOString(), id, expectedPasswordHash]
          : [passwordHash, now.toISOString(), id],
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
      transaction.close();
    }
    return { ...user, updatedAt: now.toISOString() };
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

  async authenticatePassword(
    usernameInput: string,
    password: string,
    remoteAddress: string,
    now = new Date(),
  ): Promise<PasswordAuthentication> {
    let username: string | null = null;
    try {
      username = normalizeUsername(usernameInput);
    } catch {
      // Continue through the same bcrypt path to avoid username enumeration.
    }
    const throttleIdentity = username ?? `invalid:${digest(usernameInput)}`;
    const throttleKeys = [
      digest(`identity\0${remoteAddress}\0${throttleIdentity}`),
      digest(`address\0${remoteAddress}`),
    ];
    await this.client.execute({
      sql: "DELETE FROM login_failures WHERE window_started_at <= ?",
      args: [new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString()],
    });
    const reservations = await this.client.batch(
      throttleKeys.map((throttleKey) => ({
        sql: `INSERT INTO login_failures (throttle_key, failures, window_started_at)
          VALUES (?, 1, ?)
          ON CONFLICT(throttle_key) DO UPDATE SET failures = login_failures.failures + 1
          RETURNING failures`,
        args: [throttleKey, now.toISOString()],
      })),
      "write",
    );
    if (
      reservations.some(
        (reservation, index) =>
          Number(reservation.rows[0]?.failures) >
          (index === 0 ? MAX_LOGIN_FAILURES : MAX_ADDRESS_LOGIN_ATTEMPTS),
      )
    ) {
      throw new AppError(
        429,
        "login_throttled",
        "Too many login attempts; try again later",
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
    const matches = await verifyPassword(
      password,
      row ? stringColumn(row, "password_hash") : dummyHash,
    );
    if (!row || !matches || Number(row.active) !== 1) {
      throw new AppError(
        401,
        "invalid_credentials",
        "Invalid username or password",
      );
    }
    await this.client.execute({
      sql: "DELETE FROM login_failures WHERE throttle_key = ?",
      args: [throttleKeys[0]!],
    });
    return {
      user: userFromRow(row),
      passwordHash: stringColumn(row, "password_hash"),
    };
  }

  async createSession(
    subject: string | PasswordAuthentication,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: string }> {
    const authentication = typeof subject === "string" ? null : subject;
    const userId = typeof subject === "string" ? subject : subject.user.id;
    await this.client.execute({
      sql: "DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL",
      args: [now.toISOString()],
    });
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const transaction = await this.client.transaction("write");
    try {
      const result = await transaction.execute({
        sql: authentication
          ? `INSERT INTO sessions
            (id, user_id, token_digest, created_at, expires_at, revoked_at)
            SELECT ?, id, ?, ?, ?, NULL FROM users
            WHERE id = ? AND password_hash = ? AND active = 1`
          : `INSERT INTO sessions
            (id, user_id, token_digest, created_at, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, NULL)`,
        args: authentication
          ? [
              sessionId,
              digest(token),
              now.toISOString(),
              expiresAt,
              userId,
              authentication.passwordHash,
            ]
          : [sessionId, userId, digest(token), now.toISOString(), expiresAt],
      });
      if (authentication && result.rowsAffected === 0) {
        throw new AppError(
          401,
          "invalid_credentials",
          "Credentials changed; please log in again",
        );
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
      transaction.close();
    }
    return { token, expiresAt };
  }

  async resolveSession(token: string, now = new Date()): Promise<User | null> {
    const result = await this.client.execute({
      sql: `SELECT u.id, u.username, u.role, u.active, u.created_at, u.updated_at
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_digest = ? AND s.revoked_at IS NULL AND s.expires_at > ?
          AND u.active = 1`,
      args: [digest(token), now.toISOString()],
    });
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  async revokeSession(token: string, now = new Date()): Promise<void> {
    await this.client.execute({
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
  private async pruneApiKeys(userId: string, now: Date): Promise<void> {
    const ageCutoff = new Date(
      now.getTime() - REVOKED_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    await this.client.execute({
      sql: `DELETE FROM api_keys
        WHERE user_id = ? AND revoked_at IS NOT NULL AND (
          revoked_at <= ?
          OR id IN (
            SELECT id FROM api_keys
            WHERE user_id = ? AND revoked_at IS NOT NULL
            ORDER BY revoked_at DESC, id DESC
            LIMIT -1 OFFSET ?
          )
        )`,
      args: [userId, ageCutoff, userId, REVOKED_KEY_RETENTION_COUNT],
    });
    await this.client.execute({
      sql: `DELETE FROM api_keys
        WHERE status = 'pending' AND pending_expires_at <= ?`,
      args: [now.toISOString()],
    });
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
  ): Promise<{ id: string; secret: string }> {
    const name = await this.validateKeyOwnerAndName(userId, nameInput);
    const { secret, id } = this.newSecret();
    await this.pruneApiKeys(userId, now);
    const result = await this.client.execute({
      sql: `INSERT INTO api_keys
        (id, user_id, name, key_digest, key_prefix, last_four, created_at, last_used_at, expires_at, revoked_at, status, request_id, pending_expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'active', NULL, NULL
        WHERE (SELECT COUNT(*) FROM api_keys
          WHERE user_id = ? AND revoked_at IS NULL AND status = 'active') < ?`,
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
      ],
    });
    if (result.rowsAffected === 0) {
      throw new AppError(
        409,
        "api_key_limit",
        `A user can have at most ${MAX_ACTIVE_API_KEYS} active API keys`,
      );
    }
    return { id, secret };
  }

  private async findKeyByRequestId(
    userId: string,
    requestId: string,
  ): Promise<BeginApiKeyCreationResult | null> {
    const existing = await this.client.execute({
      sql: `SELECT id, name, status, pending_expires_at FROM api_keys
        WHERE user_id = ? AND request_id = ?`,
      args: [userId, requestId],
    });
    const row = existing.rows[0];
    if (!row) return null;
    return {
      created: false,
      id: stringColumn(row, "id"),
      name: stringColumn(row, "name"),
      // Idempotent retries NEVER re-expose the plaintext secret.
      secret: null,
      status: stringColumn(row, "status") as ApiKeyStatus,
      pendingExpiresAt:
        typeof row.pending_expires_at === "string"
          ? row.pending_expires_at
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
  ): Promise<BeginApiKeyCreationResult> {
    if (!requestId || requestId.length > 128) {
      throw new AppError(
        400,
        "invalid_request_id",
        "request_id must be 1-128 characters",
      );
    }
    const name = await this.validateKeyOwnerAndName(userId, nameInput);
    await this.pruneApiKeys(userId, now);
    const existing = await this.findKeyByRequestId(userId, requestId);
    if (existing) return existing;
    const { secret, id } = this.newSecret();
    const pendingExpiresAt = new Date(
      now.getTime() + PENDING_API_KEY_TTL_MS,
    ).toISOString();
    let result;
    try {
      result = await this.client.execute({
        sql: `INSERT INTO api_keys
          (id, user_id, name, key_digest, key_prefix, last_four, created_at, last_used_at, expires_at, revoked_at, status, request_id, pending_expires_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'pending', ?, ?
          WHERE (SELECT COUNT(*) FROM api_keys
            WHERE user_id = ? AND status = 'pending') < ?`,
        args: [
          id,
          userId,
          name,
          digest(secret),
          secret.slice(0, 12),
          secret.slice(-4),
          now.toISOString(),
          requestId,
          pendingExpiresAt,
          userId,
          MAX_PENDING_API_KEYS,
        ],
      });
    } catch (cause) {
      if (String(cause).toLocaleLowerCase("en-US").includes("unique")) {
        // A concurrent duplicate begin won the insert; reconcile to its
        // committed row without minting a second credential.
        const raced = await this.findKeyByRequestId(userId, requestId);
        if (raced) return raced;
        throw new AppError(
          409,
          "request_id_conflict",
          "request_id is already used by another key",
          { cause },
        );
      }
      throw cause;
    }
    if (result.rowsAffected === 0) {
      throw new AppError(
        409,
        "pending_key_limit",
        `A user can have at most ${MAX_PENDING_API_KEYS} pending API keys`,
      );
    }
    return {
      created: true,
      id,
      name,
      secret,
      status: "pending",
      pendingExpiresAt,
    };
  }

  // Phase 2: activate a pending key only after the client confirmed it
  // received the secret. Idempotent — re-activating an active key
  // reconciles a lost activation response.
  async activateApiKey(
    id: string,
    actorUserId: string,
    actorIsAdmin: boolean,
    now = new Date(),
  ): Promise<{ id: string; status: ApiKeyStatus }> {
    const readRow = async () => {
      const lookup = await this.client.execute({
        sql: `SELECT id, user_id, status, revoked_at, pending_expires_at
          FROM api_keys WHERE id = ?${actorIsAdmin ? "" : " AND user_id = ?"}`,
        args: actorIsAdmin ? [id] : [id, actorUserId],
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
    let row = assertNotRevokedOrMissing(await readRow());
    if (stringColumn(row, "status") === "active") {
      return { id, status: "active" };
    }
    assertNotExpired(row);
    const userId = stringColumn(row, "user_id");
    // The pending→active flip is one atomic conditional statement, so
    // overlapping activations serialize at the database: exactly one
    // affects a row; the other observes rowsAffected === 0.
    const result = await this.client.execute({
      sql: `UPDATE api_keys SET status = 'active', pending_expires_at = NULL
        WHERE id = ? AND status = 'pending' AND revoked_at IS NULL
          AND pending_expires_at > ?
          AND (SELECT COUNT(*) FROM api_keys
            WHERE user_id = ? AND revoked_at IS NULL AND status = 'active') < ?`,
      args: [id, now.toISOString(), userId, MAX_ACTIVE_API_KEYS],
    });
    if (result.rowsAffected === 0) {
      // Zero rows means the row changed after the read above — the losing
      // update only observes state another call already committed. Re-read
      // and report that state truthfully: idempotent active if an overlap
      // activated it, pending_expired if it lapsed, and a limit conflict
      // only when it is genuinely still pending under a full active cap.
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
    return { id, status: "active" };
  }

  async resolveApiKey(secret: string, now = new Date()): Promise<User | null> {
    const result = await this.client.execute({
      sql: `SELECT k.id AS key_id, u.id, u.username, u.role, u.active, u.created_at, u.updated_at
        FROM api_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_digest = ? AND k.revoked_at IS NULL
          AND k.status = 'active'
          AND (k.expires_at IS NULL OR k.expires_at > ?) AND u.active = 1`,
      args: [digest(secret), now.toISOString()],
    });
    const row = result.rows[0];
    if (!row) return null;
    await this.client.execute({
      sql: "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
      args: [now.toISOString(), stringColumn(row, "key_id")],
    });
    return userFromRow(row);
  }

  async listApiKeys(userId?: string): Promise<ApiKeyMetadata[]> {
    const result = await this.client.execute({
      sql: `SELECT id, user_id, name, key_prefix, last_four, created_at, last_used_at, revoked_at, status, pending_expires_at
        FROM api_keys ${userId ? "WHERE user_id = ?" : ""} ORDER BY created_at, id`,
      args: userId ? [userId] : [],
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
  }): Promise<ApiKeyPage> {
    const limit = Math.min(Math.max(options.limit, 1), 200);
    const clauses: string[] = [];
    const args: (string | number)[] = [];
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
    if (options.cursor) {
      clauses.push("(k.created_at > ? OR (k.created_at = ? AND k.id > ?))");
      args.push(
        options.cursor.createdAt,
        options.cursor.createdAt,
        options.cursor.id,
      );
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    args.push(limit + 1);
    const result = await this.client.execute({
      sql: `SELECT k.id, k.user_id, k.name, k.key_prefix, k.last_four,
          k.created_at, k.last_used_at, k.revoked_at, k.status,
          k.pending_expires_at,
          u.username AS owner_username
        FROM api_keys k JOIN users u ON u.id = k.user_id
        ${where}
        ORDER BY k.created_at, k.id
        LIMIT ?`,
      args,
    });
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
      nextCursor:
        hasMore && last
          ? encodeApiKeyCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async revokeApiKey(
    id: string,
    actorUserId: string,
    actorIsAdmin: boolean,
    now = new Date(),
  ): Promise<void> {
    // Cancelling a pending (never-active) key removes the row entirely —
    // there is no credential history worth auditing.
    const cancelled = await this.client.execute({
      sql: `DELETE FROM api_keys
        WHERE id = ? AND status = 'pending' ${actorIsAdmin ? "" : "AND user_id = ?"}`,
      args: actorIsAdmin ? [id] : [id, actorUserId],
    });
    if (cancelled.rowsAffected > 0) return;
    const result = await this.client.execute({
      sql: `UPDATE api_keys SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL ${actorIsAdmin ? "" : "AND user_id = ?"}`,
      args: actorIsAdmin
        ? [now.toISOString(), id]
        : [now.toISOString(), id, actorUserId],
    });
    if (result.rowsAffected === 0) {
      throw new AppError(404, "api_key_not_found", "API key not found");
    }
  }
}
