import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient, type Client, type Row } from "@libsql/client";

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

export interface ApiKeyMetadata {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  lastFour: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

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

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_digest TEXT NOT NULL UNIQUE CHECK(length(key_digest) = 64),
  key_prefix TEXT NOT NULL,
  last_four TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_user_active_idx ON api_keys(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS login_failures (
  throttle_key TEXT PRIMARY KEY NOT NULL,
  failures INTEGER NOT NULL,
  window_started_at TEXT NOT NULL
);
`;

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

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
    const client = createClient({ url: databaseUrl, intMode: "number" });
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.executeMultiple(AUTH_SCHEMA);
    return new AuthRepository(client);
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

  async createUser(input: {
    username: string;
    password: string;
    role: UserRole;
  }): Promise<User> {
    const username = normalizeUsername(input.username);
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      await this.client.execute({
        sql: `INSERT INTO users
          (id, username, password_hash, role, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)`,
        args: [id, username, passwordHash, input.role, now, now],
      });
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
  ): Promise<User> {
    const user = await this.getUser(id);
    if (!user) throw new AppError(404, "user_not_found", "User not found");
    const passwordHash = await hashPassword(password);
    await this.client.batch(
      [
        {
          sql: "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
          args: [passwordHash, now.toISOString(), id],
        },
        {
          sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          args: [now.toISOString(), id],
        },
      ],
      "write",
    );
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
    if (
      !row ||
      !(await verifyPassword(
        currentPassword,
        stringColumn(row, "password_hash"),
      ))
    ) {
      throw new AppError(
        401,
        "invalid_credentials",
        "Current password is invalid",
      );
    }
    return this.setPassword(id, newPassword);
  }

  async authenticatePassword(
    usernameInput: string,
    password: string,
    remoteAddress: string,
    now = new Date(),
  ): Promise<User> {
    let username = "invalid-user";
    try {
      username = normalizeUsername(usernameInput);
    } catch {
      // Continue through the same bcrypt path to avoid username enumeration.
    }
    const throttleKey = digest(`${remoteAddress}\0${username}`);
    const failure = await this.client.execute({
      sql: "SELECT failures, window_started_at FROM login_failures WHERE throttle_key = ?",
      args: [throttleKey],
    });
    const failureRow = failure.rows[0];
    if (
      failureRow &&
      Number(failureRow.failures) >= MAX_LOGIN_FAILURES &&
      now.getTime() -
        Date.parse(stringColumn(failureRow, "window_started_at")) <
        LOGIN_WINDOW_MS
    ) {
      throw new AppError(
        429,
        "login_throttled",
        "Too many login attempts; try again later",
      );
    }

    const result = await this.client.execute({
      sql: "SELECT * FROM users WHERE username = ? COLLATE NOCASE",
      args: [username],
    });
    const row = result.rows[0];
    const dummyHash =
      "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5fMltXVrRjRQgIaY10beI7u1Y7Q5n6e";
    const matches = await verifyPassword(
      password,
      row ? stringColumn(row, "password_hash") : dummyHash,
    );
    if (!row || !matches || Number(row.active) !== 1) {
      const startedAt = failureRow
        ? stringColumn(failureRow, "window_started_at")
        : now.toISOString();
      const expired = now.getTime() - Date.parse(startedAt) >= LOGIN_WINDOW_MS;
      await this.client.execute({
        sql: `INSERT INTO login_failures (throttle_key, failures, window_started_at)
          VALUES (?, 1, ?)
          ON CONFLICT(throttle_key) DO UPDATE SET
            failures = CASE WHEN ? THEN 1 ELSE login_failures.failures + 1 END,
            window_started_at = CASE WHEN ? THEN excluded.window_started_at ELSE login_failures.window_started_at END`,
        args: [
          throttleKey,
          now.toISOString(),
          expired ? 1 : 0,
          expired ? 1 : 0,
        ],
      });
      throw new AppError(
        401,
        "invalid_credentials",
        "Invalid username or password",
      );
    }
    await this.client.execute({
      sql: "DELETE FROM login_failures WHERE throttle_key = ?",
      args: [throttleKey],
    });
    return userFromRow(row);
  }

  async createSession(
    userId: string,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    await this.client.execute({
      sql: `INSERT INTO sessions
        (id, user_id, token_digest, created_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, NULL)`,
      args: [randomUUID(), userId, digest(token), now.toISOString(), expiresAt],
    });
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

  async createApiKey(
    userId: string,
    nameInput: string,
    now = new Date(),
  ): Promise<{ id: string; secret: string }> {
    const name = nameInput.trim();
    if (!name || Buffer.byteLength(name, "utf8") > 100) {
      throw new AppError(
        400,
        "invalid_api_key_name",
        "API key name must be 1-100 UTF-8 bytes",
      );
    }
    const secret = `fsk_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    await this.client.execute({
      sql: `INSERT INTO api_keys
        (id, user_id, name, key_digest, key_prefix, last_four, created_at, last_used_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      args: [
        id,
        userId,
        name,
        digest(secret),
        secret.slice(0, 12),
        secret.slice(-4),
        now.toISOString(),
      ],
    });
    return { id, secret };
  }

  async resolveApiKey(secret: string, now = new Date()): Promise<User | null> {
    const result = await this.client.execute({
      sql: `SELECT k.id AS key_id, u.id, u.username, u.role, u.active, u.created_at, u.updated_at
        FROM api_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_digest = ? AND k.revoked_at IS NULL
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
      sql: `SELECT id, user_id, name, key_prefix, last_four, created_at, last_used_at, revoked_at
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
    }));
  }

  async revokeApiKey(
    id: string,
    actorUserId: string,
    actorIsAdmin: boolean,
    now = new Date(),
  ): Promise<void> {
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
