import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createClient,
  type Client,
  type TransactionMode,
} from "@libsql/client";

import { loadConfig } from "../files/config";
import { AppError } from "../files/errors";
import { runDatabaseWrite } from "../database/write-transaction";
import {
  AuthRepository,
  API_KEY_IDEMPOTENCY_RETENTION_MS,
  type BeginApiKeyCreationResult,
  decodeApiKeyCursor,
  IDEMPOTENT_OPERATION_RETENTION_MS,
  MAX_PENDING_API_KEYS,
  PENDING_API_KEY_TTL_MS,
  REVOKED_KEY_RETENTION_COUNT,
  REVOKED_KEY_RETENTION_DAYS,
} from "./database";
import {
  hashPassword,
  normalizeUsername,
  validatePassword,
  verifyPassword,
} from "./password";

function credentialFixture(label: string): string {
  return ["fixture", label, "credential", "value"].join("-");
}

const HASH_CREDENTIAL = credentialFixture("hash");
const WRONG_CREDENTIAL = credentialFixture("wrong");
const ADMIN_CREDENTIAL = credentialFixture("admin");
const MEMBER_CREDENTIAL = credentialFixture("member");
const SECOND_ADMIN_CREDENTIAL = credentialFixture("second-admin");
const OTHER_CREDENTIAL = credentialFixture("other");

describe("password security", () => {
  it("normalizes usernames and enforces a 12-character password minimum", async () => {
    assert.equal(normalizeUsername("  Alice.Example  "), "alice.example");
    assert.throws(() => normalizeUsername("bad name"), /username/iu);
    assert.throws(() => validatePassword("short"), /12 characters/u);
    assert.throws(() => validatePassword("😀".repeat(6)), /12 characters/u);
    assert.equal(validatePassword(HASH_CREDENTIAL), HASH_CREDENTIAL);

    const encoded = await hashPassword(HASH_CREDENTIAL);
    assert.match(encoded, /^\$2[aby]\$12\$/u);
    assert.equal(await verifyPassword(HASH_CREDENTIAL, encoded), true);
    assert.equal(await verifyPassword(WRONG_CREDENTIAL, encoded), false);
    assert.doesNotMatch(encoded, new RegExp(HASH_CREDENTIAL, "u"));
  });

  it("rejects passwords beyond bcrypt's 72-byte UTF-8 limit", async () => {
    const ascii72 = "a".repeat(72);
    const ascii73 = `${ascii72}b`;
    const multibyte72 = "界".repeat(24);
    const multibyte73 = `${multibyte72}a`;

    assert.equal(validatePassword(ascii72), ascii72);
    assert.equal(Buffer.byteLength(multibyte72, "utf8"), 72);
    assert.equal(validatePassword(multibyte72), multibyte72);
    assert.throws(() => validatePassword(ascii73), /72 UTF-8 bytes/u);
    assert.throws(() => validatePassword(multibyte73), /72 UTF-8 bytes/u);

    const encoded = await hashPassword(ascii72);
    assert.equal(await verifyPassword(ascii72, encoded), true);
    assert.equal(await verifyPassword(ascii73, encoded), false);
  });

  it("requires bootstrap username and password to be configured together", () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "test",
          FS_TOKEN: "legacy-token",
          FS_BOOTSTRAP_USERNAME: "admin",
        }),
      /bootstrap.*together/iu,
    );
  });

  it("accepts only a canonical absolute HTTP or HTTPS deploy origin", () => {
    const base: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      FS_TOKEN: "legacy-token",
    };
    assert.equal(
      loadConfig({
        ...base,
        FS_PUBLIC_URL: "HtTpS://EXAMPLE.Test:443/",
      }).publicUrl,
      "https://example.test",
    );
    assert.equal(
      loadConfig({
        ...base,
        FS_PUBLIC_URL: "HTTP://EXAMPLE.Test:80/",
      }).publicUrl,
      "http://example.test",
    );

    const invalid = [
      "not an absolute URL",
      "ftp://example.test",
      "https://user@example.test",
      "https://user:password@example.test",
      "https://example.test/files",
      "https://example.test/.",
      "https://example.test/%2e",
      "https://example.test/?secret=query-value",
      "https://example.test/#secret-fragment",
    ];
    for (const publicUrl of invalid) {
      assert.throws(
        () => loadConfig({ ...base, FS_PUBLIC_URL: publicUrl }),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "invalid_configuration" &&
          !error.message.includes(publicUrl) &&
          !error.message.includes("password") &&
          !error.message.includes("query-value") &&
          !error.message.includes("secret-fragment"),
        publicUrl,
      );
    }
  });

  it("requires the complete trusted-ingress contract and validates its headers and secret", () => {
    const base: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      FS_TOKEN: "legacy-token",
    };
    for (const partial of [
      { FS_TRUSTED_INGRESS_IP_HEADER: "x-fs-client-ip" },
      { FS_TRUSTED_INGRESS_SECRET_HEADER: "x-fs-proxy-secret" },
      { FS_TRUSTED_INGRESS_SECRET: "s".repeat(32) },
    ]) {
      assert.throws(
        () => loadConfig({ ...base, ...partial }),
        /trusted ingress.*configured together/iu,
      );
    }

    assert.throws(
      () =>
        loadConfig({
          ...base,
          FS_TRUSTED_INGRESS_IP_HEADER: "not a header",
          FS_TRUSTED_INGRESS_SECRET_HEADER: "x-fs-proxy-secret",
          FS_TRUSTED_INGRESS_SECRET: "s".repeat(32),
        }),
      /trusted ingress.*header/iu,
    );
    assert.throws(
      () =>
        loadConfig({
          ...base,
          FS_TRUSTED_INGRESS_IP_HEADER: "x-fs-client-ip",
          FS_TRUSTED_INGRESS_SECRET_HEADER: "x-fs-client-ip",
          FS_TRUSTED_INGRESS_SECRET: "s".repeat(32),
        }),
      /trusted ingress.*distinct/iu,
    );
    assert.throws(
      () =>
        loadConfig({
          ...base,
          FS_TRUSTED_INGRESS_IP_HEADER: "x-fs-client-ip",
          FS_TRUSTED_INGRESS_SECRET_HEADER: "x-fs-proxy-secret",
          FS_TRUSTED_INGRESS_SECRET: "too-short",
        }),
      /trusted ingress.*32 bytes/iu,
    );
    assert.throws(
      () =>
        loadConfig({
          ...base,
          FS_TOKEN: "s".repeat(32),
          FS_TRUSTED_INGRESS_IP_HEADER: "x-fs-client-ip",
          FS_TRUSTED_INGRESS_SECRET_HEADER: "x-fs-proxy-secret",
          FS_TRUSTED_INGRESS_SECRET: "s".repeat(32),
        }),
      /trusted ingress.*distinct from FS_TOKEN/iu,
    );

    const configured = loadConfig({
      ...base,
      FS_TRUSTED_INGRESS_IP_HEADER: "X-FS-Client-IP",
      FS_TRUSTED_INGRESS_SECRET_HEADER: "X-FS-Proxy-Secret",
      FS_TRUSTED_INGRESS_SECRET: "s".repeat(32),
    });
    assert.deepEqual(configured.trustedIngress, {
      ipHeader: "x-fs-client-ip",
      secretHeader: "x-fs-proxy-secret",
      secret: "s".repeat(32),
    });
  });
});

// Upgraded databases must end with the exact fresh-schema semantic
// constraint on api_keys.status.
const CANONICAL_STATUS_CHECK = /CHECK\(status IN \('pending', 'active'\)\)/u;

const LEGACY_USERS_TABLE = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

// Original PR #7 schema: api_keys has no status/request_id/pending columns.
async function seedLegacySchema(url: string): Promise<void> {
  const legacy = createClient({ url });
  await legacy.executeMultiple(`
    ${LEGACY_USERS_TABLE}
    CREATE TABLE api_keys (
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
    INSERT INTO users VALUES ('legacy-user', 'legacy.user', 'x', 'member', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO api_keys VALUES ('legacy-key', 'legacy-user', 'legacy-cli', '${"a".repeat(64)}', 'fsk_legacy00', 'zzzz', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL);
  `);
  legacy.close();
}

async function apiKeysTableSql(url: string): Promise<string> {
  const probe = createClient({ url });
  try {
    const result = await probe.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'",
    );
    return typeof result.rows[0]?.sql === "string" ? result.rows[0].sql : "";
  } finally {
    probe.close();
  }
}

async function schemaSnapshot(
  url: string,
  names: string[],
): Promise<Record<string, string>> {
  const probe = createClient({ url });
  try {
    const placeholders = names.map(() => "?").join(", ");
    const result = await probe.execute({
      sql: `SELECT name, sql FROM sqlite_master
        WHERE name IN (${placeholders}) ORDER BY name`,
      args: names,
    });
    return Object.fromEntries(
      result.rows.map((row) => [
        typeof row.name === "string" ? row.name : "",
        (typeof row.sql === "string" ? row.sql : "")
          .replace(/\bIF NOT EXISTS\b/giu, "")
          .replaceAll('"', "")
          .replaceAll("`", "")
          .replaceAll("[", "")
          .replaceAll("]", "")
          .replace(/\s+/gu, " ")
          .replace(/\s*([(),])\s*/gu, "$1")
          .trim()
          .toLocaleLowerCase("en-US"),
      ]),
    );
  } finally {
    probe.close();
  }
}

describe("shared database write queue", () => {
  it("serializes one database, recovers after rejection, and isolates distinct URLs", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = runDatabaseWrite("file:shared.db", async () => {
      events.push("first:start");
      firstStarted();
      await firstHeld;
      events.push("first:end");
    });
    await started;
    const queuedFailure = runDatabaseWrite("file:shared.db", async () => {
      events.push("failure:start");
      throw new Error("expected queue failure");
    });
    const isolated = runDatabaseWrite("file:other.db", async () => {
      events.push("isolated");
    });
    await isolated;
    assert.deepEqual(events, ["first:start", "isolated"]);

    releaseFirst();
    await first;
    await assert.rejects(queuedFailure, /expected queue failure/u);
    await runDatabaseWrite("file:shared.db", async () => {
      events.push("recovered");
    });
    assert.deepEqual(events, [
      "first:start",
      "isolated",
      "first:end",
      "failure:start",
      "recovered",
    ]);
  });
});

describe("user repository", () => {
  it("waits for a plain write while the same client transaction is open", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-same-client-plain-write-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const admin = await repository.bootstrapAdmin({
        username: "same-client.admin",
        password: ADMIN_CREDENTIAL,
      });
      const client = (repository as unknown as { client: Client }).client;
      const blocker = await client.transaction("write");
      await blocker.execute({
        sql: "UPDATE users SET updated_at = updated_at WHERE id = ?",
        args: [admin.id],
      });

      let configuredReplacement = false;
      let markInsertReached!: () => void;
      let allowInsert!: () => void;
      const insertReached = new Promise<void>((resolve) => {
        markInsertReached = resolve;
      });
      const insertAllowed = new Promise<void>((resolve) => {
        allowInsert = resolve;
      });
      const originalExecute = client.execute.bind(client);
      client.execute = (async (statement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (/^PRAGMA busy_timeout\b/u.test(sql)) configuredReplacement = true;
        if (/^INSERT INTO users\b/u.test(sql)) {
          assert.equal(configuredReplacement, true);
          markInsertReached();
          await insertAllowed;
        }
        return originalExecute(statement);
      }) as Client["execute"];
      const plainWrite = repository.createUser({
        username: "same-client.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      await insertReached;
      await blocker.commit();
      blocker.close();
      allowInsert();

      assert.equal((await plainWrite).username, "same-client.member");
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for an independent file repository writer before a plain auth write", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-file-client-contention-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "shared.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    let writer: ReturnType<typeof spawn> | null = null;
    try {
      const admin = await repository.bootstrapAdmin({
        username: "cross-client.admin",
        password: ADMIN_CREDENTIAL,
      });
      writer = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { FileRepository } from "./src/server/files/database.ts";
           const repository = await FileRepository.create(process.argv[1]);
           const transaction = await repository.client.transaction("write");
           await transaction.execute({ sql: "UPDATE users SET updated_at = updated_at WHERE id = ?", args: [process.argv[2]] });
           process.stdout.write("LOCKED\\n");
           await new Promise((resolve) => setTimeout(resolve, 500));
           await transaction.commit();
           transaction.close();
           process.stdout.write("COMMITTED\\n");
           await repository.close();`,
          databaseUrl,
          admin.id,
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        writer!.stderr!.on("data", (chunk) => {
          stderr += String(chunk);
        });
        writer!.stdout!.on("data", (chunk) => {
          if (String(chunk).includes("LOCKED")) resolve();
        });
        writer!.once("exit", (code) => {
          if (code !== 0) reject(new Error(`writer exited ${code}: ${stderr}`));
        });
      });

      let busyAttempts = 0;
      const authClient = (repository as unknown as { client: Client }).client;
      const originalExecute = authClient.execute.bind(authClient);
      authClient.execute = (async (statement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (/^INSERT INTO users\b/u.test(sql) && busyAttempts++ === 0) {
          throw Object.assign(new Error("independent writer is busy"), {
            code: "SQLITE_BUSY",
          });
        }
        return originalExecute(statement);
      }) as Client["execute"];
      const plainWrite = repository.createUser({
        username: "cross-client.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const startedAt = Date.now();
      assert.equal((await plainWrite).username, "cross-client.member");
      assert.ok(Date.now() - startedAt >= 400);
      if (writer.exitCode === null) {
        await new Promise<void>((resolve, reject) => {
          writer!.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)),
          );
        });
      }
      assert.equal(writer.exitCode, 0);
    } finally {
      writer?.kill("SIGTERM");
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for a real competing writer after a transaction replaces the client connection", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-post-transaction-busy-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    let blocker: ReturnType<typeof spawn> | null = null;
    try {
      const admin = await repository.bootstrapAdmin({
        username: "busy.admin",
        password: ADMIN_CREDENTIAL,
      });
      blocker = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { createClient } from "@libsql/client";
           const client = createClient({ url: process.argv[1] });
           const transaction = await client.transaction("write");
           await transaction.execute({ sql: "UPDATE users SET updated_at = updated_at WHERE id = ?", args: [process.argv[2]] });
           process.stdout.write("LOCKED\\n");
           await new Promise((resolve) => setTimeout(resolve, 250));
           await transaction.commit();
           transaction.close();
           client.close();`,
          databaseUrl,
          admin.id,
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        blocker!.stderr!.on("data", (chunk) => {
          stderr += String(chunk);
        });
        blocker!.stdout!.on("data", (chunk) => {
          if (String(chunk).includes("LOCKED")) resolve();
        });
        blocker!.once("exit", (code) => {
          if (code !== 0)
            reject(new Error(`blocker exited ${code}: ${stderr}`));
        });
      });

      const startedAt = Date.now();
      const updated = await repository.setActive(admin.id, true);
      assert.equal(updated.id, admin.id);
      assert.ok(
        Date.now() - startedAt >= 150,
        "runtime write returned before the competing lock was released",
      );
      if (blocker.exitCode === null) {
        await new Promise<void>((resolve, reject) => {
          blocker!.once("exit", (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`blocker exited ${code}`)),
          );
        });
      }
      assert.equal(blocker.exitCode, 0);
    } finally {
      blocker?.kill("SIGTERM");
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const outcome of ["committed", "rolled-back"] as const) {
    it(`restores foreign keys and busy timeout after a ${outcome} auth transaction`, async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `fs-auth-${outcome}-fk-test-`),
      );
      const databaseUrl = `file:${path.join(directory, "auth.db")}`;
      const repository = await AuthRepository.create(databaseUrl);
      try {
        const client = (repository as unknown as { client: Client }).client;
        const configuredForeignKeys: string[] = [];
        const originalExecute = client.execute.bind(client);
        client.execute = (async (statement) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (/^PRAGMA foreign_keys = ON$/u.test(sql)) {
            configuredForeignKeys.push(sql);
          }
          return originalExecute(statement);
        }) as Client["execute"];
        const admin = await repository.bootstrapAdmin({
          username: `${outcome}.admin`,
          password: ADMIN_CREDENTIAL,
        });
        if (outcome === "rolled-back") {
          configuredForeignKeys.length = 0;
          await assert.rejects(
            repository.setActive(admin.id, false),
            (error: unknown) =>
              error instanceof AppError && error.code === "last_active_admin",
          );
        }

        assert.equal(
          configuredForeignKeys.length,
          2,
          "ordinary auth transactions must explicitly configure both the current and lazy replacement connections",
        );
        assert.equal(
          Number(
            (await client.execute("PRAGMA foreign_keys")).rows[0]?.foreign_keys,
          ),
          1,
        );
        assert.equal(
          Number(
            (await client.execute("PRAGMA busy_timeout")).rows[0]?.timeout,
          ),
          5_000,
        );
        await assert.rejects(
          client.execute({
            sql: "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
            args: [
              `orphan-${outcome}`,
              "missing-user",
              `${outcome === "committed" ? "a" : "b"}`.repeat(64),
              "2026-08-04T00:00:00.000Z",
              "2026-08-04T00:00:00.000Z",
              "2026-08-04T12:00:00.000Z",
              "2026-08-11T00:00:00.000Z",
            ],
          }),
          /foreign key/iu,
        );

        const sessionId = `cascade-${outcome}`;
        await client.execute({
          sql: "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
          args: [
            sessionId,
            admin.id,
            `${outcome === "committed" ? "c" : "d"}`.repeat(64),
            "2026-08-04T00:00:00.000Z",
            "2026-08-04T00:00:00.000Z",
            "2026-08-04T12:00:00.000Z",
            "2026-08-11T00:00:00.000Z",
          ],
        });
        await client.execute({
          sql: "DELETE FROM users WHERE id = ?",
          args: [admin.id],
        });
        assert.equal(
          Number(
            (
              await client.execute({
                sql: "SELECT COUNT(*) AS count FROM sessions WHERE id = ?",
                args: [sessionId],
              })
            ).rows[0]?.count,
          ),
          0,
        );
      } finally {
        await repository.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("rebuilds marker-complete unconstrained users and sessions to exact fresh-schema parity under concurrent startup", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-marker-schema-test-"),
    );
    const freshUrl = `file:${path.join(directory, "fresh.db")}`;
    const migratedUrl = `file:${path.join(directory, "migrated.db")}`;
    const schemaNames = [
      "users",
      "users_role_active_idx",
      "sessions",
      "sessions_user_active_idx",
      "sessions_expires_idx",
      "sessions_revoked_idx",
    ];
    const fresh = await AuthRepository.create(freshUrl);
    await fresh.close();

    const seed = createClient({ url: migratedUrl });
    await seed.executeMultiple(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT,
        password_hash TEXT,
        role TEXT,
        active INTEGER DEFAULT 1,
        created_at TEXT,
        updated_at TEXT,
        password_changed_at TEXT NOT NULL,
        temporary_password_expires_at TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        token_digest TEXT,
        created_at TEXT,
        last_seen_at TEXT NOT NULL,
        idle_expires_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );
      INSERT INTO users VALUES (
        'marker-user', 'marker.user', 'x', 'member', 1,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', NULL
      );
      INSERT INTO sessions VALUES (
        'marker-session', 'marker-user', '${"7".repeat(64)}',
        '2026-01-02T00:00:00.000Z', '2026-01-02T01:00:00.000Z',
        '2026-01-02T13:00:00.000Z', '2026-01-09T00:00:00.000Z', NULL
      );
    `);
    seed.close();

    const repositories = await Promise.all(
      Array.from({ length: 4 }, () => AuthRepository.create(migratedUrl)),
    );
    try {
      assert.deepEqual(
        await schemaSnapshot(migratedUrl, schemaNames),
        await schemaSnapshot(freshUrl, schemaNames),
      );
      const migratedProbe = createClient({ url: migratedUrl });
      try {
        const row = await migratedProbe.execute(
          "SELECT last_seen_at, idle_expires_at FROM sessions WHERE id = 'marker-session'",
        );
        assert.equal(row.rows[0]?.last_seen_at, "2026-01-02T01:00:00.000Z");
        assert.equal(row.rows[0]?.idle_expires_at, "2026-01-02T13:00:00.000Z");
      } finally {
        migratedProbe.close();
      }
      assert.equal(
        await repositories[0]!.resolveSession("not-the-token"),
        null,
      );
      const probe = createClient({ url: migratedUrl });
      try {
        const preserved = await probe.execute(
          "SELECT COUNT(*) AS count FROM users WHERE id = 'marker-user'",
        );
        assert.equal(Number(preserved.rows[0]?.count), 1);
        await probe.execute("PRAGMA foreign_keys = ON");
        await assert.rejects(
          probe.execute(
            "INSERT INTO sessions VALUES ('bad-fk', 'missing', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x', 'x', 'x', 'x', NULL)",
          ),
          /foreign key/iu,
        );
      } finally {
        probe.close();
      }
    } finally {
      await Promise.all(repositories.map((repository) => repository.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates legacy idempotency metadata to fresh parity without unsafe user-create replay", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-idempotency-schema-test-"),
    );
    const migratedUrl = `file:${path.join(directory, "migrated.db")}`;
    const freshUrl = `file:${path.join(directory, "fresh.db")}`;
    let repositories: AuthRepository[] = [];
    try {
      const seeded = await AuthRepository.create(migratedUrl);
      const admin = await seeded.createUser({
        username: "idempotency-migration.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      const created = await seeded.createUserIdempotent(
        {
          username: "idempotency-migration.created",
          password: MEMBER_CREDENTIAL,
          role: "member",
        },
        { userId: admin.id },
        "legacy-user-create-request",
      );
      const resetTarget = await seeded.createUser({
        username: "idempotency-migration.reset",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const resetCandidate = credentialFixture("idempotency-migration-reset");
      const migrationNow = new Date("2026-08-04T12:00:00.000Z");
      await seeded.resetPasswordIdempotent(
        resetTarget.id,
        resetCandidate,
        admin.id,
        "legacy-password-reset-request",
        migrationNow,
      );
      await seeded.close();

      const legacy = createClient({ url: migratedUrl });
      try {
        await legacy.execute("PRAGMA foreign_keys = OFF");
        await legacy.executeMultiple(`
          CREATE TABLE idempotent_operations_legacy (
            operation TEXT NOT NULL CHECK(operation IN ('user_create', 'password_reset')),
            actor_key TEXT NOT NULL,
            request_id TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (operation, actor_key, request_id)
          );
          INSERT INTO idempotent_operations_legacy
            SELECT operation, actor_key, request_id, user_id, created_at
            FROM idempotent_operations;
          DROP TABLE idempotent_operations;
          ALTER TABLE idempotent_operations_legacy RENAME TO idempotent_operations;
          CREATE INDEX idempotent_operations_created_idx
            ON idempotent_operations(created_at);
          CREATE INDEX idempotent_operations_user_idx
            ON idempotent_operations(user_id);
        `);
      } finally {
        legacy.close();
      }

      repositories = await Promise.all(
        Array.from({ length: 4 }, () => AuthRepository.create(migratedUrl)),
      );
      const fresh = await AuthRepository.create(freshUrl);
      await fresh.close();
      const schemaNames = [
        "idempotent_operations",
        "idempotent_operations_created_idx",
        "idempotent_operations_user_idx",
      ];
      assert.deepEqual(
        await schemaSnapshot(migratedUrl, schemaNames),
        await schemaSnapshot(freshUrl, schemaNames),
      );
      await assert.rejects(
        repositories[0]!.createUserIdempotent(
          {
            username: "idempotency-migration.created",
            password: MEMBER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "legacy-user-create-request",
        ),
        (error) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );
      const resetReplay = await repositories[1]!.resetPasswordIdempotent(
        resetTarget.id,
        resetCandidate,
        admin.id,
        "legacy-password-reset-request",
        migrationNow,
      );
      assert.equal(resetReplay.applied, false);
      assert.equal(resetReplay.user.id, resetTarget.id);
      const probe = createClient({ url: migratedUrl });
      try {
        const rows = await probe.execute(
          "SELECT operation, intent_version, intent_credential_hash FROM idempotent_operations ORDER BY operation",
        );
        assert.deepEqual(
          rows.rows.map((row) => [row.operation, row.intent_version]),
          [
            ["password_reset", 1],
            ["user_create", 0],
          ],
        );
        const upgradedReset = rows.rows.find(
          (row) => row.operation === "password_reset",
        );
        assert.equal(typeof upgradedReset?.intent_credential_hash, "string");
        assert.notEqual(upgradedReset?.intent_credential_hash, resetCandidate);
        assert.equal(
          await verifyPassword(
            resetCandidate,
            upgradedReset?.intent_credential_hash as string,
          ),
          true,
        );

        const staleTarget = await repositories[0]!.createUser({
          username: "idempotency-migration.stale-reset",
          password: OTHER_CREDENTIAL,
          role: "member",
        });
        await probe.execute({
          sql: `INSERT INTO idempotent_operations
            (operation, actor_key, request_id, user_id, created_at)
            VALUES ('password_reset', ?, ?, ?, ?)`,
          args: [
            admin.id,
            "stale-legacy-password-reset-request",
            staleTarget.id,
            new Date(
              migrationNow.getTime() - IDEMPOTENT_OPERATION_RETENTION_MS - 1,
            ).toISOString(),
          ],
        });
        await assert.rejects(
          repositories[0]!.resetPasswordIdempotent(
            staleTarget.id,
            OTHER_CREDENTIAL,
            admin.id,
            "stale-legacy-password-reset-request",
            migrationNow,
          ),
          (error) =>
            error instanceof AppError && error.code === "request_id_conflict",
        );
        assert.equal(
          (await probe.execute("PRAGMA foreign_key_check")).rows.length,
          0,
        );
        assert.equal(created.user.username, "idempotency-migration.created");
      } finally {
        probe.close();
      }
    } finally {
      await Promise.all(repositories.map((repository) => repository.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates missing parent directories for a local SQLite database", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-create-test-"),
    );
    const databasePath = path.join(directory, "nested", "data", "files.db");
    let repository: AuthRepository | undefined;
    try {
      repository = await AuthRepository.create(`file:${databasePath}`);
      const admin = await repository.bootstrapAdmin({
        username: "bootstrap.admin",
        password: ADMIN_CREDENTIAL,
      });
      assert.equal(admin.role, "admin");
    } finally {
      await repository?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function assertConcurrentValidCredentialPreservesAddressFailures(
    label: string,
    prepare: (repository: AuthRepository) => Promise<{
      username: string;
      expectedCode?: string;
      now?: Date;
    }>,
  ) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), `fs-auth-address-${label}-test-`),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    let releaseVerification!: () => void;
    let reportVerificationStarted!: () => void;
    const verificationRelease = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const verificationStarted = new Promise<void>((resolve) => {
      reportVerificationStarted = resolve;
    });
    const repository = await AuthRepository.create(databaseUrl, {
      verifyPassword: async (password, encoded) => {
        const matches = await verifyPassword(password, encoded);
        if (matches && password === MEMBER_CREDENTIAL) {
          reportVerificationStarted();
          await verificationRelease;
        }
        return matches;
      },
    });
    try {
      const { username, expectedCode, now } = await prepare(repository);
      const address = "198.51.100.44";
      for (let attempt = 0; attempt < 9; attempt += 1) {
        await assert.rejects(
          repository.authenticatePassword(
            `missing.${label}.${attempt}`,
            WRONG_CREDENTIAL,
            address,
            now,
          ),
          (error: unknown) =>
            error instanceof AppError && error.code === "invalid_credentials",
        );
      }

      const validAttempt = repository.authenticatePassword(
        username,
        MEMBER_CREDENTIAL,
        address,
        now,
      );
      await verificationStarted;
      await assert.rejects(
        repository.authenticatePassword(
          `overlap.${label}`,
          WRONG_CREDENTIAL,
          address,
          now,
        ),
        (error: unknown) =>
          error instanceof AppError && error.code === "login_throttled",
      );
      releaseVerification();
      if (expectedCode) {
        await assert.rejects(
          validAttempt,
          (error: unknown) =>
            error instanceof AppError && error.code === expectedCode,
        );
      } else {
        await validAttempt;
      }

      const inspection = createClient({ url: databaseUrl, intMode: "number" });
      try {
        const result = await inspection.execute(
          "SELECT MAX(failures) AS failures FROM login_failures",
        );
        assert.equal(Number(result.rows[0]?.failures), 10);
      } finally {
        inspection.close();
      }
      await assert.rejects(
        repository.authenticatePassword(
          `after.${label}`,
          WRONG_CREDENTIAL,
          address,
          now,
        ),
        (error: unknown) =>
          error instanceof AppError && error.code === "login_throttled",
      );
    } finally {
      releaseVerification();
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("atomically removes only an active credential's concurrent address reservation", async () => {
    await assertConcurrentValidCredentialPreservesAddressFailures(
      "active",
      async (repository) => {
        const user = await repository.bootstrapAdmin({
          username: "active.account",
          password: MEMBER_CREDENTIAL,
        });
        return { username: user.username };
      },
    );
  });

  it("atomically removes only a disabled credential's concurrent address reservation", async () => {
    await assertConcurrentValidCredentialPreservesAddressFailures(
      "disabled",
      async (repository) => {
        const user = await repository.createUser({
          username: "disabled.account",
          password: MEMBER_CREDENTIAL,
          role: "member",
        });
        await repository.setActive(user.id, false);
        return { username: user.username, expectedCode: "account_disabled" };
      },
    );
  });

  it("atomically removes only an expired temporary credential's concurrent address reservation", async () => {
    await assertConcurrentValidCredentialPreservesAddressFailures(
      "expired",
      async (repository) => {
        const user = await repository.createUser({
          username: "expired.account",
          password: MEMBER_CREDENTIAL,
          role: "member",
        });
        return {
          username: user.username,
          expectedCode: "temporary_password_expired",
          now: new Date(Date.parse(user.temporaryPasswordExpiresAt!) + 1),
        };
      },
    );
  });

  it("rejects connection-local in-memory database URLs", async () => {
    await assert.rejects(
      AuthRepository.create("file::memory:"),
      /connection-local in-memory databases are not supported/iu,
    );
  });

  it("limits varied usernames from the same known remote address", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-address-throttle-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await assert.rejects(
          repository.authenticatePassword(
            `missing.user.${attempt}`,
            WRONG_CREDENTIAL,
            "203.0.113.90",
          ),
          (error: unknown) =>
            error instanceof AppError && error.code === "invalid_credentials",
        );
      }
      await assert.rejects(
        repository.authenticatePassword(
          "another.missing.user",
          WRONG_CREDENTIAL,
          "203.0.113.90",
        ),
        (error: unknown) => {
          if (!(error instanceof AppError) || error.code !== "login_throttled")
            return false;
          const retryAfter = Number(error.headers?.get("retry-after"));
          return retryAfter >= 890 && retryAfter <= 900;
        },
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports retry-after from only the old blocking address window", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-truthful-retry-after-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    const now = new Date("2026-08-04T12:00:00.000Z");
    const oldAnchor = new Date(now.getTime() - 14 * 60 * 1000);
    const address = "203.0.113.91";
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await assert.rejects(
          repository.authenticatePassword(
            `old-window.${attempt}`,
            WRONG_CREDENTIAL,
            address,
            oldAnchor,
          ),
          (error: unknown) =>
            error instanceof AppError && error.code === "invalid_credentials",
        );
      }
      await assert.rejects(
        repository.authenticatePassword(
          "fresh-identity",
          WRONG_CREDENTIAL,
          address,
          now,
        ),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "login_throttled" &&
          error.headers?.get("retry-after") === "60",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes a disabled account only after the supplied password verifies", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-disabled-login-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const disabled = await repository.createUser({
        username: "disabled.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      await repository.setActive(disabled.id, false);
      await assert.rejects(
        repository.authenticatePassword(
          disabled.username,
          WRONG_CREDENTIAL,
          "192.0.2.71",
        ),
        (error: unknown) =>
          error instanceof AppError && error.code === "invalid_credentials",
      );
      await assert.rejects(
        repository.authenticatePassword(
          disabled.username,
          MEMBER_CREDENTIAL,
          "192.0.2.72",
        ),
        (error: unknown) =>
          error instanceof AppError && error.code === "account_disabled",
      );
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await assert.rejects(
          repository.authenticatePassword(
            disabled.username,
            MEMBER_CREDENTIAL,
            "192.0.2.72",
          ),
          (error: unknown) =>
            error instanceof AppError && error.code === "account_disabled",
        );
      }
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never maps malformed usernames onto a valid account", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-invalid-username-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      await repository.bootstrapAdmin({
        username: "invalid-user",
        password: ADMIN_CREDENTIAL,
      });

      await assert.rejects(
        repository.authenticatePassword("$", ADMIN_CREDENTIAL, "192.0.2.50"),
        /invalid username or password/iu,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not issue a password session after the verified hash changes", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-session-race-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const user = await repository.bootstrapAdmin({
        username: "race.admin",
        password: ADMIN_CREDENTIAL,
      });
      const authentication = await repository.authenticatePassword(
        user.username,
        ADMIN_CREDENTIAL,
        "192.0.2.30",
      );
      await repository.setPassword(user.id, OTHER_CREDENTIAL);

      await assert.rejects(
        repository.createSession(authentication),
        /credentials changed/iu,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("revalidates current administrators for every privileged identity mutation", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-commit-actor-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const actor = await repository.createUser({
        username: "race.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      await repository.createUser({
        username: "race.keeper.admin",
        password: SECOND_ADMIN_CREDENTIAL,
        role: "admin",
      });
      const target = await repository.createUser({
        username: "race.target",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const pending = await repository.beginApiKeyCreation(
        target.id,
        "pending-before-disable",
        "pending-before-disable",
        new Date(),
        actor.id,
      );
      await repository.setActive(actor.id, false);

      for (const operation of [
        () => repository.setActive(target.id, false, actor.id),
        () => repository.setRole(target.id, "admin", actor.id),
        () =>
          repository.setPassword(
            target.id,
            OTHER_CREDENTIAL,
            new Date(),
            undefined,
            actor.id,
          ),
        () =>
          repository.resetPasswordIdempotent(
            target.id,
            OTHER_CREDENTIAL,
            actor.id,
            "disabled-actor-reset",
          ),
      ]) {
        await assert.rejects(
          operation(),
          (error) =>
            error instanceof AppError && error.code === "admin_revoked",
        );
      }
      await assert.rejects(
        repository.beginApiKeyCreation(
          target.id,
          "denied-pending",
          "denied-pending",
          new Date(),
          actor.id,
        ),
        (error) => error instanceof AppError && error.status === 404,
      );
      await assert.rejects(
        repository.createApiKey(
          target.id,
          "denied-active",
          new Date(),
          actor.id,
        ),
        (error) => error instanceof AppError && error.status === 404,
      );
      await assert.rejects(
        repository.activateApiKey(pending.id, actor.id, true),
        (error) => error instanceof AppError && error.status === 404,
      );
      await assert.rejects(
        repository.revokeApiKey(pending.id, actor.id, true),
        (error) => error instanceof AppError && error.status === 404,
      );
      const unchanged = await repository.getUser(target.id);
      assert.equal(unchanged?.active, true);
      assert.equal(unchanged?.role, "member");
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps cross-user key maintenance rows when an actor is disabled or demoted immediately before pruning", async () => {
    for (const scenario of ["active-disabled", "pending-demoted"] as const) {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `fs-auth-key-prune-${scenario}-test-`),
      );
      const databaseUrl = `file:${path.join(directory, "auth.db")}`;
      const repository = await AuthRepository.create(databaseUrl);
      const guard = await AuthRepository.create(databaseUrl);
      try {
        const actor = await repository.createUser({
          username: `prune.${scenario}.actor`,
          password: ADMIN_CREDENTIAL,
          role: "admin",
        });
        await repository.createUser({
          username: `prune.${scenario}.keeper`,
          password: SECOND_ADMIN_CREDENTIAL,
          role: "admin",
        });
        const owner = await repository.createUser({
          username: `prune.${scenario}.owner`,
          password: MEMBER_CREDENTIAL,
          role: "member",
        });
        const other = await repository.createUser({
          username: `prune.${scenario}.other`,
          password: OTHER_CREDENTIAL,
          role: "member",
        });
        const now = new Date("2026-08-04T12:00:00.000Z");
        const old = new Date(
          now.getTime() -
            (REVOKED_KEY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
        );
        const revoked = await repository.createApiKey(
          owner.id,
          `seed-revoked-${scenario}`,
          old,
        );
        await repository.revokeApiKey(revoked.id, owner.id, false, old);
        const pending = await repository.beginApiKeyCreation(
          other.id,
          `seed-pending-${scenario}`,
          `seed-pending-${scenario}`,
          old,
        );
        const internal = repository as unknown as { client: Client };
        const snapshot = async () => {
          const rows = await internal.client.execute({
            sql: `SELECT id, user_id, name, status, revoked_at, pending_expires_at
              FROM api_keys WHERE id IN (?, ?) ORDER BY id`,
            args: [revoked.id, pending.id],
          });
          return rows.rows.map((row) => ({ ...row }));
        };
        const before = await snapshot();
        assert.equal(before.length, 2);

        const originalExecute = internal.client.execute.bind(internal.client);
        const originalTransaction = internal.client.transaction.bind(
          internal.client,
        );
        let changed = false;
        const changeActor = async () => {
          if (changed) return;
          changed = true;
          if (scenario === "active-disabled") {
            await guard.setActive(actor.id, false);
          } else {
            await guard.setRole(actor.id, "member");
          }
        };
        internal.client.execute = async (statement) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (sql.includes("DELETE FROM api_keys")) await changeActor();
          return originalExecute(statement);
        };
        internal.client.transaction = async (mode?: TransactionMode) => {
          await changeActor();
          return originalTransaction(mode);
        };
        try {
          const operation =
            scenario === "active-disabled"
              ? repository.createApiKey(
                  owner.id,
                  "denied-active-prune",
                  now,
                  actor.id,
                )
              : repository.beginApiKeyCreation(
                  owner.id,
                  "denied-pending-prune",
                  "denied-pending-prune",
                  now,
                  actor.id,
                );
          await assert.rejects(
            operation,
            (error) => error instanceof AppError && error.status === 404,
          );
          assert.equal(changed, true);
        } finally {
          internal.client.execute = originalExecute;
          internal.client.transaction = originalTransaction;
        }
        assert.deepEqual(await snapshot(), before);
      } finally {
        await guard.close();
        await repository.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("keeps cross-user idempotency rows when an actor is disabled or demoted immediately before pruning", async () => {
    for (const scenario of ["create-disabled", "reset-demoted"] as const) {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `fs-auth-idempotency-prune-${scenario}-test-`),
      );
      const databaseUrl = `file:${path.join(directory, "auth.db")}`;
      const repository = await AuthRepository.create(databaseUrl);
      const guard = await AuthRepository.create(databaseUrl);
      try {
        const actor = await repository.createUser({
          username: `idem.prune.${scenario}.actor`,
          password: ADMIN_CREDENTIAL,
          role: "admin",
        });
        await repository.createUser({
          username: `idem.prune.${scenario}.keeper`,
          password: SECOND_ADMIN_CREDENTIAL,
          role: "admin",
        });
        const target = await repository.createUser({
          username: `idem.prune.${scenario}.target`,
          password: MEMBER_CREDENTIAL,
          role: "member",
        });
        const other = await repository.createUser({
          username: `idem.prune.${scenario}.other`,
          password: OTHER_CREDENTIAL,
          role: "member",
        });
        const now = new Date("2026-08-04T12:00:00.000Z");
        const old = new Date(
          now.getTime() - IDEMPOTENT_OPERATION_RETENTION_MS - 1,
        ).toISOString();
        const internal = repository as unknown as { client: Client };
        for (const [index, userId] of [target.id, other.id].entries()) {
          await internal.client.execute({
            sql: `INSERT INTO idempotent_operations
              (operation, actor_key, request_id, user_id, created_at)
              VALUES (?, ?, ?, ?, ?)`,
            args: [
              index === 0 ? "user_create" : "password_reset",
              `seed-actor-${scenario}-${index}`,
              `seed-request-${scenario}-${index}`,
              userId,
              old,
            ],
          });
        }
        const snapshot = async () => {
          const rows = await internal.client.execute({
            sql: `SELECT operation, actor_key, request_id, user_id, created_at
              FROM idempotent_operations
              WHERE actor_key LIKE ? ORDER BY actor_key`,
            args: [`seed-actor-${scenario}-%`],
          });
          return rows.rows.map((row) => ({ ...row }));
        };
        const before = await snapshot();
        assert.equal(before.length, 2);

        const originalExecute = internal.client.execute.bind(internal.client);
        const originalTransaction = internal.client.transaction.bind(
          internal.client,
        );
        let changed = false;
        const changeActor = async () => {
          if (changed) return;
          changed = true;
          if (scenario === "create-disabled") {
            await guard.setActive(actor.id, false);
          } else {
            await guard.setRole(actor.id, "member");
          }
        };
        internal.client.execute = async (statement) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (sql.includes("DELETE FROM idempotent_operations")) {
            await changeActor();
          }
          return originalExecute(statement);
        };
        internal.client.transaction = async (mode?: TransactionMode) => {
          await changeActor();
          return originalTransaction(mode);
        };
        try {
          const operation =
            scenario === "create-disabled"
              ? repository.createUserIdempotent(
                  {
                    username: "denied.prune.user",
                    password: OTHER_CREDENTIAL,
                    role: "member",
                  },
                  { userId: actor.id },
                  "denied-prune-create",
                  now,
                )
              : repository.resetPasswordIdempotent(
                  target.id,
                  OTHER_CREDENTIAL,
                  actor.id,
                  "denied-prune-reset",
                  now,
                );
          await assert.rejects(
            operation,
            (error) =>
              error instanceof AppError && error.code === "admin_revoked",
          );
          assert.equal(changed, true);
        } finally {
          internal.client.execute = originalExecute;
          internal.client.transaction = originalTransaction;
        }
        assert.deepEqual(await snapshot(), before);
      } finally {
        await guard.close();
        await repository.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("rolls back key pruning with a failed authorized mutation and commits it with success", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-key-prune-transaction-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const admin = await repository.createUser({
        username: "prune.transaction.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      const owner = await repository.createUser({
        username: "prune.transaction.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const other = await repository.createUser({
        username: "prune.transaction.other",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const now = new Date("2026-08-04T12:00:00.000Z");
      for (let index = 0; index < 10; index += 1) {
        await repository.createApiKey(owner.id, `capacity-${index}`, now);
      }
      const old = new Date(
        now.getTime() - (REVOKED_KEY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
      ).toISOString();
      const internal = repository as unknown as { client: Client };
      await internal.client.batch([
        {
          sql: `INSERT INTO api_keys
            (id, user_id, name, key_digest, key_prefix, last_four, created_at, last_used_at, expires_at, revoked_at, status, request_id, pending_expires_at)
            VALUES ('rollback-revoked', ?, 'rollback-revoked', ?, 'fsk_rollback', 'aaaa', ?, NULL, NULL, ?, 'active', NULL, NULL)`,
          args: [owner.id, "a".repeat(64), old, old],
        },
        {
          sql: `INSERT INTO api_keys
            (id, user_id, name, key_digest, key_prefix, last_four, created_at, last_used_at, expires_at, revoked_at, status, request_id, pending_expires_at)
            VALUES ('rollback-pending', ?, 'rollback-pending', ?, 'fsk_rollback', 'bbbb', ?, NULL, NULL, NULL, 'pending', 'rollback-pending-request', ?)`,
          args: [other.id, "b".repeat(64), old, old],
        },
      ]);
      const maintenanceRows = async () => {
        const result = await internal.client.execute(
          "SELECT id FROM api_keys WHERE id LIKE 'rollback-%' ORDER BY id",
        );
        return result.rows.map((row) => {
          assert.equal(typeof row.id, "string");
          return row.id;
        });
      };
      assert.deepEqual(await maintenanceRows(), [
        "rollback-pending",
        "rollback-revoked",
      ]);

      await assert.rejects(
        repository.createApiKey(owner.id, "over-capacity", now, admin.id),
        (error) => error instanceof AppError && error.code === "api_key_limit",
      );
      assert.deepEqual(await maintenanceRows(), [
        "rollback-pending",
        "rollback-revoked",
      ]);

      const capacityKey = (await repository.listApiKeys(owner.id)).find(
        (key) => key.name === "capacity-0",
      )!;
      await repository.revokeApiKey(capacityKey.id, owner.id, false, now);
      await repository.createApiKey(
        owner.id,
        "authorized-prune",
        now,
        admin.id,
      );
      assert.deepEqual(await maintenanceRows(), []);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back idempotency pruning with a failed authorized mutation and commits it with success", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-idempotency-prune-transaction-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const admin = await repository.createUser({
        username: "idem.transaction.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      const existing = await repository.createUser({
        username: "idem.transaction.existing",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const other = await repository.createUser({
        username: "idem.transaction.other",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const now = new Date("2026-08-04T12:00:00.000Z");
      const old = new Date(
        now.getTime() - IDEMPOTENT_OPERATION_RETENTION_MS - 1,
      ).toISOString();
      const internal = repository as unknown as { client: Client };
      await internal.client.batch(
        [existing.id, other.id].map((userId, index) => ({
          sql: `INSERT INTO idempotent_operations
            (operation, actor_key, request_id, user_id, created_at)
            VALUES (?, ?, ?, ?, ?)`,
          args: [
            index === 0 ? "user_create" : "password_reset",
            `rollback-actor-${index}`,
            `rollback-request-${index}`,
            userId,
            old,
          ],
        })),
      );
      const maintenanceRows = async () => {
        const result = await internal.client.execute(
          "SELECT actor_key FROM idempotent_operations WHERE actor_key LIKE 'rollback-actor-%' ORDER BY actor_key",
        );
        return result.rows.map((row) => {
          assert.equal(typeof row.actor_key, "string");
          return row.actor_key;
        });
      };
      assert.deepEqual(await maintenanceRows(), [
        "rollback-actor-0",
        "rollback-actor-1",
      ]);

      await assert.rejects(
        repository.createUserIdempotent(
          {
            username: existing.username,
            password: OTHER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "rollback-duplicate",
          now,
        ),
        (error) =>
          error instanceof AppError && error.code === "username_exists",
      );
      assert.deepEqual(await maintenanceRows(), [
        "rollback-actor-0",
        "rollback-actor-1",
      ]);

      await repository.createUserIdempotent(
        {
          username: "idem.transaction.created",
          password: OTHER_CREDENTIAL,
          role: "member",
        },
        { userId: admin.id },
        "authorized-prune",
        now,
      );
      assert.deepEqual(await maintenanceRows(), []);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows administrators and legacy credentials to de-escalate disabled-owner keys", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-key-owner-active-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const admin = await repository.createUser({
        username: "owner.guard.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      const owner = await repository.createUser({
        username: "owner.guard.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const pending = await repository.beginApiKeyCreation(
        owner.id,
        "before-disable",
        "before-disable",
        new Date(),
        admin.id,
      );
      const active = await repository.createApiKey(
        owner.id,
        "active-before-disable",
        new Date(),
        admin.id,
      );
      const selfRevokeCandidate = await repository.createApiKey(
        owner.id,
        "self-revoke-after-disable",
        new Date(),
        admin.id,
      );
      await repository.setActive(owner.id, false, admin.id);

      for (const operation of [
        () =>
          repository.createApiKey(
            owner.id,
            "planted-active",
            new Date(),
            admin.id,
          ),
        () =>
          repository.beginApiKeyCreation(
            owner.id,
            "planted-pending",
            "planted-pending",
            new Date(),
            admin.id,
          ),
      ]) {
        await assert.rejects(
          operation(),
          (error) =>
            error instanceof AppError &&
            error.status === 404 &&
            error.code === "user_not_found",
        );
      }
      await assert.rejects(
        repository.activateApiKey(pending.id, admin.id, true),
        (error) =>
          error instanceof AppError &&
          error.status === 404 &&
          error.code === "api_key_not_found",
      );
      assert.equal(await repository.resolveApiKey(active.secret!), null);
      assert.equal(
        await repository.resolveApiKey(selfRevokeCandidate.secret!),
        null,
      );
      await assert.rejects(
        repository.revokeApiKey(selfRevokeCandidate.id, owner.id, false),
        (error) =>
          error instanceof AppError &&
          error.status === 404 &&
          error.code === "api_key_not_found",
      );
      await repository.revokeApiKey(pending.id, admin.id, true);
      await repository.revokeApiKey(active.id, null, true);
      await repository.revokeApiKey(selfRevokeCandidate.id, admin.id, true);
      assert.equal(await repository.resolveApiKey(pending.secret!), null);
      let keys = await repository.listApiKeys(owner.id);
      assert.equal(
        keys.some((key) => key.id === pending.id),
        false,
      );
      assert.notEqual(
        keys.find((key) => key.id === active.id)?.revokedAt,
        null,
      );
      await repository.setActive(owner.id, true, admin.id);
      assert.equal(await repository.resolveApiKey(active.secret!), null);
      assert.equal(
        await repository.resolveApiKey(selfRevokeCandidate.secret!),
        null,
      );
      assert.equal(await repository.resolveApiKey(pending.secret!), null);
      keys = await repository.listApiKeys(owner.id);
      assert.notEqual(
        keys.find((key) => key.id === active.id)?.revokedAt,
        null,
      );
      assert.equal(
        keys.some((key) => key.id === pending.id),
        false,
      );
      assert.equal(
        (await repository.listApiKeys(owner.id)).some(
          (key) =>
            key.name === "planted-active" || key.name === "planted-pending",
        ),
        false,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rechecks API-key owner activity for grants but not de-escalation", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-key-owner-race-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    const guard = await AuthRepository.create(databaseUrl);
    try {
      const admin = await repository.createUser({
        username: "owner.race.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      const owner = await repository.createUser({
        username: "owner.race.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const internal = repository as unknown as { client: Client };

      async function disableBeforeTransaction(
        operation: () => Promise<unknown>,
      ) {
        const originalTransaction = internal.client.transaction.bind(
          internal.client,
        );
        let intercepted = false;
        internal.client.transaction = async (mode?: TransactionMode) => {
          if (!intercepted) {
            intercepted = true;
            await guard.setActive(owner.id, false);
          }
          return originalTransaction(mode);
        };
        try {
          await assert.rejects(
            operation(),
            (error) =>
              error instanceof AppError &&
              error.status === 404 &&
              (error.code === "user_not_found" ||
                error.code === "api_key_not_found"),
          );
          assert.equal(intercepted, true);
        } finally {
          internal.client.transaction = originalTransaction;
        }
      }

      await disableBeforeTransaction(() =>
        repository.createApiKey(owner.id, "race-active", new Date(), admin.id),
      );
      await guard.setActive(owner.id, true);
      await disableBeforeTransaction(() =>
        repository.beginApiKeyCreation(
          owner.id,
          "race-pending",
          "race-pending",
          new Date(),
          admin.id,
        ),
      );
      await guard.setActive(owner.id, true);
      const pending = await repository.beginApiKeyCreation(
        owner.id,
        "activation-race",
        "activation-race",
        new Date(),
        admin.id,
      );
      await disableBeforeTransaction(() =>
        repository.activateApiKey(pending.id, admin.id, true),
      );

      await guard.setActive(owner.id, true);
      await repository.revokeApiKey(pending.id, admin.id, true);

      await guard.setActive(owner.id, true);
      const active = await repository.createApiKey(
        owner.id,
        "revocation-race",
        new Date(),
        admin.id,
      );
      await guard.setActive(owner.id, false);
      await repository.revokeApiKey(active.id, admin.id, true);

      await guard.setActive(owner.id, true);
      assert.equal(await repository.resolveApiKey(active.secret!), null);
      assert.equal(await repository.resolveApiKey(pending.secret!), null);
      const keys = await repository.listApiKeys(owner.id);
      const names = keys.map((key) => key.name);
      assert.notEqual(
        keys.find((key) => key.id === active.id)?.revokedAt,
        null,
      );
      assert.equal(names.includes("activation-race"), false);
      assert.equal(names.includes("race-active"), false);
      assert.equal(names.includes("race-pending"), false);
    } finally {
      await guard.close();
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves key state unchanged when an unauthorized administrator revokes", async () => {
    for (const scenario of ["disabled", "demoted"] as const) {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `fs-auth-revoke-actor-${scenario}-test-`),
      );
      const databaseUrl = `file:${path.join(directory, "auth.db")}`;
      const repository = await AuthRepository.create(databaseUrl);
      const guard = await AuthRepository.create(databaseUrl);
      try {
        const actor = await repository.createUser({
          username: `revoke.${scenario}.admin`,
          password: ADMIN_CREDENTIAL,
          role: "admin",
        });
        await repository.createUser({
          username: `revoke.${scenario}.keeper`,
          password: SECOND_ADMIN_CREDENTIAL,
          role: "admin",
        });
        const owner = await repository.createUser({
          username: `revoke.${scenario}.owner`,
          password: MEMBER_CREDENTIAL,
          role: "member",
        });
        const key =
          scenario === "disabled"
            ? await repository.beginApiKeyCreation(
                owner.id,
                "pending-before-actor-disable",
                "pending-before-actor-disable",
                new Date(),
                actor.id,
              )
            : await repository.createApiKey(
                owner.id,
                "active-before-actor-demotion",
                new Date(),
                actor.id,
              );
        await repository.setActive(owner.id, false, actor.id);

        if (scenario === "disabled") {
          await guard.setActive(actor.id, false);
        } else {
          await guard.setRole(actor.id, "member");
        }
        const before = await repository.listApiKeys(owner.id);
        await assert.rejects(
          repository.revokeApiKey(key.id, actor.id, true),
          (error) =>
            error instanceof AppError &&
            error.status === 404 &&
            error.code === "api_key_not_found",
        );
        const after = await repository.listApiKeys(owner.id);
        assert.deepEqual(after, before);

        const keys = await repository.listApiKeys(owner.id);
        const retained = keys.find((candidate) => candidate.id === key.id);
        assert.ok(retained);
        if (scenario === "disabled") {
          assert.equal(retained.status, "pending");
        } else {
          assert.equal(retained.revokedAt, null);
        }
      } finally {
        await guard.close();
        await repository.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("does not let a disabled administrator finish creating a user", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-admin-create-race-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      await repository.createUser({
        username: "guard.admin",
        password: SECOND_ADMIN_CREDENTIAL,
        role: "admin",
      });
      const actor = await repository.createUser({
        username: "creating.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      const creation = repository.createUser(
        {
          username: "replacement.admin",
          password: OTHER_CREDENTIAL,
          role: "admin",
        },
        actor.id,
      );
      await repository.setActive(actor.id, false);

      await assert.rejects(
        creation,
        (error: unknown) =>
          error instanceof AppError && error.code === "admin_revoked",
      );
      assert.equal(
        (await repository.listUsers()).some(
          (user) => user.username === "replacement.admin",
        ),
        false,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not complete a self-service password change after disablement", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-password-disable-race-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const member = await repository.createUser({
        username: "disabled.during.change",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const change = repository.changePassword(
        member.id,
        MEMBER_CREDENTIAL,
        OTHER_CREDENTIAL,
      );
      await repository.setActive(member.id, false);

      await assert.rejects(
        change,
        (error: unknown) =>
          error instanceof AppError && error.code === "invalid_credentials",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not overwrite an administrator reset with an in-flight self-service change", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-password-race-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const user = await repository.bootstrapAdmin({
        username: "recovery.admin",
        password: ADMIN_CREDENTIAL,
      });
      const inFlightChange = repository.changePassword(
        user.id,
        ADMIN_CREDENTIAL,
        OTHER_CREDENTIAL,
      );
      await repository.setPassword(user.id, SECOND_ADMIN_CREDENTIAL);

      await assert.rejects(inFlightChange, /credentials changed/iu);
      const recovered = await repository.authenticatePassword(
        user.username,
        SECOND_ADMIN_CREDENTIAL,
        "192.0.2.31",
      );
      assert.equal(recovered.user.id, user.id);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects concurrent and already-throttled attempts before bcrypt", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-concurrent-throttle-test-"),
    );
    let bcryptCalls = 0;
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
      {
        verifyPassword: async (password, encoded) => {
          bcryptCalls += 1;
          return verifyPassword(password, encoded);
        },
      },
    );
    try {
      await repository.bootstrapAdmin({
        username: "throttle.admin",
        password: ADMIN_CREDENTIAL,
      });
      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          repository.authenticatePassword(
            "throttle.admin",
            WRONG_CREDENTIAL,
            "192.0.2.40",
          ),
        ),
      );
      const codes = attempts.map((attempt) =>
        attempt.status === "rejected" &&
        typeof attempt.reason === "object" &&
        attempt.reason !== null &&
        "code" in attempt.reason
          ? String((attempt.reason as { code: unknown }).code)
          : "unexpected",
      );
      assert.equal(
        codes.filter((code) => code === "invalid_credentials").length,
        5,
      );
      assert.equal(
        codes.filter((code) => code === "login_throttled").length,
        5,
      );
      assert.equal(bcryptCalls, 5);

      await assert.rejects(
        repository.authenticatePassword(
          "throttle.admin",
          ADMIN_CREDENTIAL,
          "192.0.2.40",
        ),
        (error) =>
          error instanceof AppError && error.code === "login_throttled",
      );
      assert.equal(bcryptCalls, 5);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains revoked keys and enforces the per-owner count bound on the final revocation", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-api-key-retention-bounds-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const member = await repository.createUser({
        username: "retention.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const now = new Date("2026-07-31T12:00:00.000Z");

      // revoke -> create -> list keeps the revoked record.
      const first = await repository.createApiKey(member.id, "first", now);
      await repository.revokeApiKey(first.id, member.id, false, now);
      await repository.createApiKey(member.id, "second", now);
      const afterCreate = await repository.listApiKeys(member.id);
      assert.equal(
        afterCreate.filter((key) => key.revokedAt !== null).length,
        1,
      );

      // Count bound: the final revocation itself leaves only the most recent
      // REVOKED_KEY_RETENTION_COUNT records visible and stored.
      for (let index = 0; index < REVOKED_KEY_RETENTION_COUNT + 5; index += 1) {
        const later = new Date(now.getTime() + (index + 1) * 1000);
        const key = await repository.createApiKey(
          member.id,
          `churn-${index}`,
          later,
        );
        await repository.revokeApiKey(key.id, member.id, false, later);
      }
      const bounded = await repository.listApiKeys(member.id);
      assert.equal(
        bounded.filter((key) => key.revokedAt !== null).length,
        REVOKED_KEY_RETENTION_COUNT,
      );
      // The retained revoked records are the most recent ones.
      const revokedNames = bounded
        .filter((key) => key.revokedAt !== null)
        .map((key) => key.name);
      assert.equal(revokedNames.includes("first"), false);
      assert.equal(
        revokedNames.includes(`churn-${REVOKED_KEY_RETENTION_COUNT + 4}`),
        true,
      );
      const probe = createClient({ url: databaseUrl, intMode: "number" });
      try {
        const stored = await probe.execute({
          sql: "SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ? AND revoked_at IS NOT NULL",
          args: [member.id],
        });
        assert.equal(
          Number(stored.rows[0]?.count),
          REVOKED_KEY_RETENTION_COUNT,
        );
      } finally {
        probe.close();
      }
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hides revoked keys that age out without a later creation", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-api-key-retention-age-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const member = await repository.createUser({
        username: "retention.age.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const now = new Date("2026-07-31T12:00:00.000Z");
      const dayMs = 24 * 60 * 60 * 1000;
      const old = new Date(
        now.getTime() - (REVOKED_KEY_RETENTION_DAYS + 1) * dayMs,
      );
      const recent = new Date(
        now.getTime() - (REVOKED_KEY_RETENTION_DAYS - 1) * dayMs,
      );

      const ancient = await repository.createApiKey(member.id, "ancient", old);
      await repository.revokeApiKey(ancient.id, member.id, false, old);
      const fresh = await repository.createApiKey(member.id, "fresh", recent);
      await repository.revokeApiKey(fresh.id, member.id, false, recent);

      const retained = await repository.listApiKeys(member.id, now);
      const revokedNames = retained
        .filter((key) => key.revokedAt !== null)
        .map((key) => key.name);
      assert.deepEqual(revokedNames, ["fresh"]);

      const hiddenSearch = await repository.listAllApiKeys({
        limit: 1,
        q: "ancient",
        now,
      });
      assert.deepEqual(hiddenSearch.apiKeys, []);
      assert.deepEqual(hiddenSearch.totals, {
        total: 0,
        active: 0,
        pending: 0,
      });
      assert.equal(hiddenSearch.nextCursor, null);

      const visibleSearch = await repository.listAllApiKeys({
        limit: 1,
        q: "fresh",
        now,
      });
      assert.deepEqual(
        visibleSearch.apiKeys.map((key) => key.name),
        ["fresh"],
      );
      assert.deepEqual(visibleSearch.totals, {
        total: 1,
        active: 0,
        pending: 0,
      });
      assert.equal(visibleSearch.nextCursor, null);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cleans already-aged and excess revoked rows on startup", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-api-key-startup-retention-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    let repository = await AuthRepository.create(databaseUrl);
    try {
      const owner = await repository.createUser({
        username: "retention.startup.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const now = new Date();
      for (let index = 0; index < REVOKED_KEY_RETENTION_COUNT; index += 1) {
        const key = await repository.createApiKey(
          owner.id,
          `kept-${index}`,
          now,
        );
        await repository.revokeApiKey(key.id, owner.id, false, now);
      }
      await repository.close();

      const seed = createClient({ url: databaseUrl, intMode: "number" });
      try {
        const source = await seed.execute({
          sql: "SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NOT NULL LIMIT 1",
          args: [owner.id],
        });
        assert.ok(source.rows[0]);
        for (let index = 0; index < 3; index += 1) {
          await seed.execute({
            sql: `INSERT INTO api_keys
              (id, user_id, name, key_digest, key_prefix, last_four, created_at,
               last_used_at, expires_at, revoked_at, status, request_id, pending_expires_at)
              SELECT ?, user_id, ?, ?, key_prefix, last_four, created_at,
               last_used_at, expires_at, revoked_at, status, NULL, NULL
              FROM api_keys WHERE id = ?`,
            args: [
              `startup-excess-${index}`,
              `startup-excess-${index}`,
              `${index}`.repeat(64),
              source.rows[0].id as string,
            ],
          });
        }
        await seed.execute({
          sql: `UPDATE api_keys SET revoked_at = ?
            WHERE id = 'startup-excess-0'`,
          args: [
            new Date(
              now.getTime() -
                (REVOKED_KEY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
            ).toISOString(),
          ],
        });
      } finally {
        seed.close();
      }

      repository = await AuthRepository.create(databaseUrl);
      const probe = createClient({ url: databaseUrl, intMode: "number" });
      try {
        const stored = await probe.execute({
          sql: "SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ? AND revoked_at IS NOT NULL",
          args: [owner.id],
        });
        assert.equal(
          Number(stored.rows[0]?.count),
          REVOKED_KEY_RETENTION_COUNT,
        );
        const ancient = await probe.execute(
          "SELECT 1 FROM api_keys WHERE id = 'startup-excess-0'",
        );
        assert.equal(ancient.rows.length, 0);
      } finally {
        probe.close();
      }
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates and prunes terminal API-key tombstones on startup without touching live bindings", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-key-tombstone-startup-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const freshUrl = `file:${path.join(directory, "fresh.db")}`;
    let repository = await AuthRepository.create(databaseUrl);
    try {
      const ownerA = await repository.createUser({
        username: "tombstone.startup.a",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const ownerB = await repository.createUser({
        username: "tombstone.startup.b",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const now = new Date();
      const pending = await repository.beginApiKeyCreation(
        ownerA.id,
        "live pending",
        "startup-live-pending",
        now,
      );
      const active = await repository.beginApiKeyCreation(
        ownerB.id,
        "live active",
        "startup-live-active",
        now,
      );
      await repository.activateApiKey(active.id, ownerB.id, false, now);
      const internal = repository as unknown as { client: Client };
      await internal.client.batch([
        {
          sql: `INSERT INTO api_key_idempotent_operations
            (request_id, user_id, intent_version, intent_name, key_id,
              pending_expires_at, terminal_code, terminal_at, created_at)
            VALUES (?, ?, 1, ?, ?, NULL, 'pending_expired', ?, ?)`,
          args: [
            "startup-old-pending-expired",
            ownerA.id,
            "old pending",
            "missing-old-pending",
            new Date(
              now.getTime() - API_KEY_IDEMPOTENCY_RETENTION_MS - 60_000,
            ).toISOString(),
            new Date(
              now.getTime() - API_KEY_IDEMPOTENCY_RETENTION_MS - 60_000,
            ).toISOString(),
          ],
        },
        {
          sql: `INSERT INTO api_key_idempotent_operations
            (request_id, user_id, intent_version, intent_name, key_id,
              pending_expires_at, terminal_code, terminal_at, created_at)
            VALUES (?, ?, 1, ?, ?, NULL, 'api_key_not_found', ?, ?)`,
          args: [
            "startup-recent-not-found",
            ownerB.id,
            "recent missing",
            "missing-recent-key",
            new Date(now.getTime() - 60_000).toISOString(),
            new Date(now.getTime() - 60_000).toISOString(),
          ],
        },
      ]);
      await repository.close();

      // Simulate the pre-terminal_at table. Migration must preserve terminal
      // meaning, rebuild to exact fresh parity, and age old terminal rows from
      // their only available timestamp.
      const legacy = createClient({ url: databaseUrl, intMode: "number" });
      try {
        await legacy.execute("PRAGMA foreign_keys = OFF");
        await legacy.executeMultiple(`
          CREATE TABLE api_key_idempotent_operations_legacy (
            request_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            intent_version INTEGER NOT NULL CHECK(intent_version = 1),
            intent_name TEXT NOT NULL,
            key_id TEXT NOT NULL,
            pending_expires_at TEXT,
            terminal_code TEXT CHECK(terminal_code IS NULL OR terminal_code IN ('pending_expired', 'api_key_not_found')),
            created_at TEXT NOT NULL
          );
          INSERT INTO api_key_idempotent_operations_legacy
            SELECT request_id, user_id, intent_version, intent_name, key_id,
              pending_expires_at, terminal_code, created_at
            FROM api_key_idempotent_operations;
          DROP TABLE api_key_idempotent_operations;
          ALTER TABLE api_key_idempotent_operations_legacy
            RENAME TO api_key_idempotent_operations;
          CREATE INDEX api_key_idempotent_operations_user_idx
            ON api_key_idempotent_operations(user_id);
          CREATE INDEX api_key_idempotent_operations_created_idx
            ON api_key_idempotent_operations(created_at);
        `);
      } finally {
        legacy.close();
      }

      repository = await AuthRepository.create(databaseUrl);
      const fresh = await AuthRepository.create(freshUrl);
      await fresh.close();
      const schemaNames = [
        "api_key_idempotent_operations",
        "api_key_idempotent_operations_user_idx",
        "api_key_idempotent_operations_terminal_idx",
      ];
      assert.deepEqual(
        await schemaSnapshot(databaseUrl, schemaNames),
        await schemaSnapshot(freshUrl, schemaNames),
      );
      const probe = createClient({ url: databaseUrl, intMode: "number" });
      try {
        const rows = await probe.execute(
          `SELECT request_id, terminal_code FROM api_key_idempotent_operations
            ORDER BY request_id`,
        );
        assert.deepEqual(
          rows.rows.map((row) => [row.request_id, row.terminal_code]),
          [
            ["startup-live-active", null],
            ["startup-live-pending", null],
            ["startup-recent-not-found", "api_key_not_found"],
          ],
        );
        assert.equal(
          (await repository.listApiKeys(ownerA.id, now)).some(
            (key) => key.id === pending.id,
          ),
          true,
        );
        assert.equal(
          (await repository.listApiKeys(ownerB.id, now)).some(
            (key) => key.id === active.id,
          ),
          true,
        );
      } finally {
        probe.close();
      }
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps terminal API-key request ids for 24 hours, then permits clean reuse across owners", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-key-tombstone-horizon-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const ownerA = await repository.createUser({
        username: "tombstone.horizon.a",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const ownerB = await repository.createUser({
        username: "tombstone.horizon.b",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const start = new Date("2026-08-04T12:00:00.000Z");
      const expiring = await repository.beginApiKeyCreation(
        ownerA.id,
        "recover me",
        "horizon-expired-request",
        start,
      );
      const pendingReplay = await repository.beginApiKeyCreation(
        ownerA.id,
        "recover me",
        "horizon-expired-request",
        start,
      );
      assert.equal(pendingReplay.created, false);
      assert.equal(pendingReplay.secret, null);
      const expiryTouch = new Date(
        start.getTime() + PENDING_API_KEY_TTL_MS + 1,
      );
      await repository.beginApiKeyCreation(
        ownerB.id,
        "other owner touch",
        "horizon-other-owner-touch",
        expiryTouch,
      );
      await assert.rejects(
        repository.beginApiKeyCreation(
          ownerA.id,
          "recover me",
          "horizon-expired-request",
          new Date(
            expiryTouch.getTime() + API_KEY_IDEMPOTENCY_RETENTION_MS - 1,
          ),
        ),
        (error) =>
          error instanceof AppError && error.code === "pending_expired",
      );

      const cancelled = await repository.beginApiKeyCreation(
        ownerB.id,
        "cancelled request",
        "horizon-cancelled-request",
        expiryTouch,
      );
      await repository.revokeApiKey(
        cancelled.id,
        ownerB.id,
        false,
        expiryTouch,
      );
      await assert.rejects(
        repository.beginApiKeyCreation(
          ownerB.id,
          "cancelled request",
          "horizon-cancelled-request",
          new Date(expiryTouch.getTime() + 1),
        ),
        (error) =>
          error instanceof AppError && error.code === "api_key_not_found",
      );

      const active = await repository.beginApiKeyCreation(
        ownerB.id,
        "visible revoked history",
        "horizon-live-binding",
        expiryTouch,
      );
      await repository.activateApiKey(active.id, ownerB.id, false, expiryTouch);
      await repository.revokeApiKey(active.id, ownerB.id, false, expiryTouch);

      const afterHorizon = new Date(
        expiryTouch.getTime() + API_KEY_IDEMPOTENCY_RETENTION_MS + 1,
      );
      // The reused mutation itself may remove an expired terminal binding,
      // but only after its new owner/actor authorization succeeds in the same
      // transaction.
      const reused = await repository.beginApiKeyCreation(
        ownerA.id,
        "recover me",
        "horizon-expired-request",
        afterHorizon,
      );
      assert.equal(reused.created, true);
      assert.equal(typeof reused.secret, "string");
      assert.notEqual(reused.id, expiring.id);
      // Live active/revoked bindings and their visible 90-day/20-key history
      // are not terminal tombstones and remain outside this 24-hour cleanup.
      const retainedHistory = await repository.listApiKeys(
        ownerB.id,
        afterHorizon,
      );
      assert.equal(
        retainedHistory.some(
          (key) => key.id === active.id && key.revokedAt !== null,
        ),
        true,
      );
      const internal = repository as unknown as { client: Client };
      const liveBinding = await internal.client.execute({
        sql: `SELECT terminal_code FROM api_key_idempotent_operations
          WHERE request_id = 'horizon-live-binding'`,
        args: [],
      });
      assert.equal(liveBinding.rows[0]?.terminal_code, null);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prunes API-key tombstones only inside successful authorized mutations", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-key-tombstone-rollback-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owner = await repository.createUser({
        username: "tombstone.rollback.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const unauthorized = await repository.createUser({
        username: "tombstone.rollback.unauthorized",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const now = new Date("2026-08-04T12:00:00.000Z");
      const pending: BeginApiKeyCreationResult[] = [];
      for (let index = 0; index < MAX_PENDING_API_KEYS; index += 1) {
        pending.push(
          await repository.beginApiKeyCreation(
            owner.id,
            `capacity ${index}`,
            `rollback-capacity-${index}`,
            now,
          ),
        );
      }
      const internal = repository as unknown as { client: Client };
      await internal.client.execute({
        sql: `INSERT INTO api_key_idempotent_operations
          (request_id, user_id, intent_version, intent_name, key_id,
            pending_expires_at, terminal_code, terminal_at, created_at)
          VALUES (?, ?, 1, ?, ?, NULL, 'api_key_not_found', ?, ?)`,
        args: [
          "rollback-old-terminal",
          owner.id,
          "old terminal",
          "rollback-missing-key",
          new Date(
            now.getTime() - API_KEY_IDEMPOTENCY_RETENTION_MS - 1,
          ).toISOString(),
          new Date(
            now.getTime() - API_KEY_IDEMPOTENCY_RETENTION_MS - 1,
          ).toISOString(),
        ],
      });
      const tombstoneCount = async () =>
        Number(
          (
            await internal.client.execute(
              `SELECT COUNT(*) AS count FROM api_key_idempotent_operations
                WHERE request_id = 'rollback-old-terminal'`,
            )
          ).rows[0]?.count,
        );

      await assert.rejects(
        repository.beginApiKeyCreation(
          owner.id,
          "unauthorized touch",
          "rollback-old-terminal",
          now,
          unauthorized.id,
        ),
        (error) => error instanceof AppError && error.status === 404,
      );
      assert.equal(await tombstoneCount(), 1);

      await assert.rejects(
        repository.activateApiKey(pending[0]!.id, unauthorized.id, false, now),
        (error) => error instanceof AppError && error.status === 404,
      );
      assert.equal(await tombstoneCount(), 1);

      await assert.rejects(
        repository.beginApiKeyCreation(
          owner.id,
          "capacity failure",
          "rollback-old-terminal",
          now,
          owner.id,
        ),
        (error) =>
          error instanceof AppError && error.code === "pending_key_limit",
      );
      assert.equal(await tombstoneCount(), 1);

      await repository.activateApiKey(pending[0]!.id, owner.id, false, now);
      assert.equal(await tombstoneCount(), 0);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lists all users' keys in one paginated aggregate with owner identity", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-api-key-aggregate-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owners = [];
      const base = new Date("2026-07-01T00:00:00.000Z");
      for (let index = 0; index < 5; index += 1) {
        const owner = await repository.createUser({
          username: `aggregate.owner.${index}`,
          password: MEMBER_CREDENTIAL,
          role: "member",
        });
        owners.push(owner);
        for (let key = 0; key < 3; key += 1) {
          await repository.createApiKey(
            owner.id,
            `owner-${index}-key-${key}`,
            new Date(base.getTime() + (index * 3 + key) * 1000),
          );
        }
      }

      // Traverse every page with a small limit and verify completeness,
      // owner attribution, and cursor round-trips.
      const collected = [];
      let cursor;
      for (;;) {
        const page = await repository.listAllApiKeys({ limit: 4, cursor });
        assert.deepEqual(page.totals, { total: 15, active: 15, pending: 0 });
        collected.push(...page.apiKeys);
        if (!page.nextCursor) break;
        cursor = decodeApiKeyCursor(page.nextCursor);
      }
      assert.equal(collected.length, 15);
      assert.equal(new Set(collected.map((key) => key.id)).size, 15);
      assert.equal(collected[0]?.name, "owner-4-key-2");
      assert.equal(collected.at(-1)?.name, "owner-0-key-0");
      for (const key of collected) {
        assert.match(key.ownerUsername, /^aggregate\.owner\.[0-4]$/u);
      }
      // One slow/broken owner cannot poison the aggregate — it is a single
      // SQL join, not a fan-out; verify a mid-list page is stable.
      const single = await repository.listAllApiKeys({ limit: 100 });
      assert.equal(single.apiKeys.length, 15);
      assert.equal(single.nextCursor, null);
      assert.throws(
        () => decodeApiKeyCursor("not-a-cursor"),
        (error) => error instanceof AppError && error.code === "invalid_cursor",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("searches the aggregate by key name and owner username before pagination", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-api-key-search-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const base = new Date("2026-07-01T00:00:00.000Z");
      // 12 owners × 9 keys = 108 noise rows, so an unfiltered page of 100
      // cannot contain the needle placed at the very end.
      for (let index = 0; index < 12; index += 1) {
        const owner = await repository.createUser({
          username: `noise.owner.${index}`,
          password: MEMBER_CREDENTIAL,
          role: "member",
        });
        for (let key = 0; key < 9; key += 1) {
          await repository.createApiKey(
            owner.id,
            `noise-${index}-${key}`,
            new Date(base.getTime() + (index * 9 + key) * 1000),
          );
        }
      }
      const needleOwner = await repository.createUser({
        username: "needle.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      await repository.createApiKey(
        needleOwner.id,
        "NEEDLE-Laptop",
        new Date(base.getTime() + 3600_000),
      );
      await repository.createApiKey(
        needleOwner.id,
        "progress 100%_done",
        new Date(base.getTime() + 3601_000),
      );

      // Newest credentials are visible on the first unfiltered page.
      const unfiltered = await repository.listAllApiKeys({ limit: 100 });
      assert.equal(
        unfiltered.apiKeys.some((key) => key.name === "NEEDLE-Laptop"),
        true,
      );
      // …but a filtered search finds it on page 1, case-insensitively.
      const byName = await repository.listAllApiKeys({
        limit: 100,
        q: "needle-lap",
      });
      assert.equal(byName.apiKeys.length, 1);
      assert.equal(byName.apiKeys[0]?.name, "NEEDLE-Laptop");
      assert.equal(byName.nextCursor, null);

      // Owner-username matching covers all of that owner's keys.
      const byOwner = await repository.listAllApiKeys({
        limit: 100,
        q: "needle.owner",
      });
      assert.equal(byOwner.apiKeys.length, 2);

      // LIKE wildcards in the query are literals, not patterns.
      const percent = await repository.listAllApiKeys({
        limit: 100,
        q: "0%_d",
      });
      assert.deepEqual(
        percent.apiKeys.map((key) => key.name),
        ["progress 100%_done"],
      );
      const underscore = await repository.listAllApiKeys({
        limit: 100,
        q: "%",
      });
      assert.deepEqual(
        underscore.apiKeys.map((key) => key.name),
        ["progress 100%_done"],
      );

      // Cursor semantics stay deterministic under a search: small pages
      // are disjoint and complete.
      const collected = [];
      let cursor;
      for (;;) {
        const page = await repository.listAllApiKeys({
          limit: 5,
          cursor,
          q: "noise-3-",
        });
        collected.push(...page.apiKeys);
        if (!page.nextCursor) break;
        cursor = decodeApiKeyCursor(page.nextCursor);
      }
      assert.equal(collected.length, 9);
      assert.equal(new Set(collected.map((key) => key.id)).size, 9);
      for (const key of collected) {
        assert.match(key.name, /^noise-3-/u);
      }
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function assertApiKeyResolutionWaitsForCompetingCommit(
    label: "revoke" | "disable",
  ): Promise<void> {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), `fs-auth-api-key-${label}-race-test-`),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const resolver = await AuthRepository.create(databaseUrl);
    let writer: ReturnType<typeof spawn> | null = null;
    try {
      const owner = await resolver.bootstrapAdmin({
        username: `${label}.owner`,
        password: ADMIN_CREDENTIAL,
      });
      const key = await resolver.createApiKey(owner.id, `${label}-key`);
      writer = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { AuthRepository } from "./src/server/auth/database.ts";
           const repository = await AuthRepository.create(process.argv[1]);
           const transaction = await repository.client.transaction("write");
           if (process.argv[2] === "revoke") {
             await transaction.execute({ sql: "UPDATE api_keys SET revoked_at = ? WHERE id = ?", args: ["2026-08-04T12:00:00.000Z", process.argv[3]] });
           } else {
             await transaction.execute({ sql: "UPDATE users SET active = 0 WHERE id = ?", args: [process.argv[3]] });
           }
           process.stdout.write("LOCKED\\n");
           await new Promise((resolve) => setTimeout(resolve, 250));
           await transaction.commit();
           transaction.close();
           process.stdout.write("COMMITTED\\n");
           await repository.close();`,
          databaseUrl,
          label,
          label === "revoke" ? key.id : owner.id,
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        writer!.stderr!.on("data", (chunk) => {
          stderr += String(chunk);
        });
        writer!.stdout!.on("data", (chunk) => {
          if (String(chunk).includes("LOCKED")) resolve();
        });
        writer!.once("exit", (code) => {
          if (code !== 0) reject(new Error(`writer exited ${code}: ${stderr}`));
        });
      });

      assert.equal(
        await resolver.resolveApiKey(
          key.secret,
          new Date("2026-08-04T12:00:01.000Z"),
        ),
        null,
      );
      if (writer.exitCode === null) {
        await new Promise<void>((resolve, reject) => {
          writer!.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)),
          );
        });
      }
      assert.equal(writer.exitCode, 0);
    } finally {
      writer?.kill("SIGTERM");
      await resolver.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("returns no API-key principal after a competing revocation commits", async () => {
    await assertApiKeyResolutionWaitsForCompetingCommit("revoke");
  });

  it("returns no API-key principal after a competing owner disable commits", async () => {
    await assertApiKeyResolutionWaitsForCompetingCommit("disable");
  });

  it("two-phase creation: pending keys never authenticate until activated", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-two-phase-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owner = await repository.createUser({
        username: "twophase.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const begun = await repository.beginApiKeyCreation(
        owner.id,
        "browser-key",
        "req-11111111-1111-4111-8111-111111111111",
      );
      assert.equal(begun.created, true);
      assert.equal(begun.status, "pending");
      assert.match(begun.secret!, /^fsk_/u);
      assert.ok(begun.pendingExpiresAt);

      // The invariant: a pending key is NEVER a live credential.
      assert.equal(await repository.resolveApiKey(begun.secret!), null);

      // Activation flips it live, idempotently.
      const activated = await repository.activateApiKey(
        begun.id,
        owner.id,
        false,
      );
      assert.equal(activated.status, "active");
      const again = await repository.activateApiKey(begun.id, owner.id, false);
      assert.equal(again.status, "active");
      const resolved = await repository.resolveApiKey(begun.secret!);
      assert.equal(resolved?.id, owner.id);

      // The plaintext secret is never at rest: only its SHA-256 digest.
      const client = createClient({
        url: `file:${path.join(directory, "auth.db")}`,
      });
      const rows = await client.execute("SELECT * FROM api_keys");
      for (const row of rows.rows) {
        for (const value of Object.values(row)) {
          assert.ok(
            typeof value !== "string" || !value.includes(begun.secret!),
          );
        }
      }
      client.close();
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds API-key request ids to the sequential and concurrent owner", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-owner-request-id-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const firstOwner = await repository.createUser({
        username: "request.first",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const secondOwner = await repository.createUser({
        username: "request.second",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const requestId = "shared-opaque-request-id";
      const first = await repository.beginApiKeyCreation(
        firstOwner.id,
        "owner-bound-key",
        requestId,
      );
      assert.equal(first.created, true);
      await assert.rejects(
        repository.beginApiKeyCreation(
          secondOwner.id,
          "owner-bound-key",
          requestId,
        ),
        (error) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );

      const concurrent = await Promise.allSettled([
        repository.beginApiKeyCreation(
          firstOwner.id,
          "owner-race-key",
          "owner-race-request-id",
        ),
        repository.beginApiKeyCreation(
          secondOwner.id,
          "owner-race-key",
          "owner-race-request-id",
        ),
      ]);
      assert.equal(
        concurrent.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const rejected = concurrent.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      assert.ok(rejected);
      assert.ok(
        rejected.reason instanceof AppError &&
          rejected.reason.code === "request_id_conflict",
      );

      const inspection = createClient({ url: databaseUrl });
      try {
        const index = await inspection.execute(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'api_keys_request_idx'",
        );
        const sql = index.rows[0]?.sql;
        if (typeof sql !== "string")
          throw new Error("request index SQL missing");
        assert.match(
          sql,
          /ON api_keys\s*\(request_id\)\s*WHERE request_id IS NOT NULL/iu,
        );
      } finally {
        inspection.close();
      }
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retrying a create with the same request id is idempotent and never re-exposes the secret", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-idempotent-create-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owner = await repository.createUser({
        username: "retry.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const requestId = "req-22222222-2222-4222-8222-222222222222";
      const first = await repository.beginApiKeyCreation(
        owner.id,
        "lost-response-key",
        requestId,
      );
      assert.equal(first.created, true);
      assert.ok(first.secret);

      // The retry after a lost response: truthful metadata, no plaintext.
      const retry = await repository.beginApiKeyCreation(
        owner.id,
        "lost-response-key",
        requestId,
      );
      assert.equal(retry.created, false);
      assert.equal(retry.id, first.id);
      assert.equal(retry.secret, null);
      assert.equal(retry.status, "pending");
      assert.ok(retry.pendingExpiresAt);

      // Concurrent duplicate begins cannot mint two rows.
      const results = await Promise.all([
        repository.beginApiKeyCreation(owner.id, "dup", "req-dup-1"),
        repository.beginApiKeyCreation(owner.id, "dup", "req-dup-1"),
      ]);
      const createdCount = results.filter((result) => result.created).length;
      assert.equal(createdCount, 1);
      assert.equal(new Set(results.map((result) => result.id)).size, 1);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds API-key request ids to the sequential and concurrent normalized key name", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-key-name-intent-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owner = await repository.createUser({
        username: "key-name-intent.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const first = await repository.beginApiKeyCreation(
        owner.id,
        "  normalized-key  ",
        "req-key-name-sequential",
      );
      assert.equal(first.created, true);
      const exactReplay = await repository.beginApiKeyCreation(
        owner.id,
        "normalized-key",
        "req-key-name-sequential",
      );
      assert.equal(exactReplay.created, false);
      assert.equal(exactReplay.id, first.id);
      assert.equal(exactReplay.secret, null);
      await assert.rejects(
        repository.beginApiKeyCreation(
          owner.id,
          "different-key",
          "req-key-name-sequential",
        ),
        (error) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );

      const concurrent = await Promise.allSettled([
        repository.beginApiKeyCreation(
          owner.id,
          "concurrent-key-a",
          "req-key-name-concurrent",
        ),
        repository.beginApiKeyCreation(
          owner.id,
          "concurrent-key-b",
          "req-key-name-concurrent",
        ),
      ]);
      assert.equal(
        concurrent.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const rejected = concurrent.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      assert.ok(rejected);
      assert.ok(
        rejected.reason instanceof AppError &&
          rejected.reason.code === "request_id_conflict",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continuously excludes expired pending keys from member and admin reads without a write", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-pending-read-truth-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const firstOwner = await repository.createUser({
        username: "pending-truth.first",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const secondOwner = await repository.createUser({
        username: "pending-truth.second",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const start = new Date("2026-07-15T00:00:00.000Z");
      const active = await repository.createApiKey(
        firstOwner.id,
        "active-history",
        new Date(start.getTime() + 1_000),
      );
      const revoked = await repository.createApiKey(
        firstOwner.id,
        "revoked-history",
        new Date(start.getTime() + 2_000),
      );
      await repository.revokeApiKey(
        revoked.id,
        firstOwner.id,
        false,
        new Date(start.getTime() + 3_000),
      );
      const firstPending = await repository.beginApiKeyCreation(
        firstOwner.id,
        "stale-search-first",
        "req-stale-read-first",
        new Date(start.getTime() + 4_000),
      );
      const secondPending = await repository.beginApiKeyCreation(
        secondOwner.id,
        "stale-search-second",
        "req-stale-read-second",
        new Date(start.getTime() + 5_000),
      );
      assert.equal(firstPending.created, true);
      assert.equal(secondPending.created, true);

      const later = new Date(start.getTime() + PENDING_API_KEY_TTL_MS + 10_000);
      const firstMember = await repository.listApiKeys(firstOwner.id, later);
      assert.deepEqual(
        firstMember.map((key) => key.id),
        [active.id, revoked.id],
      );
      assert.deepEqual(await repository.listApiKeys(secondOwner.id, later), []);

      const hiddenSearch = await repository.listAllApiKeys({
        limit: 10,
        q: "stale-search",
        now: later,
      });
      assert.deepEqual(hiddenSearch.apiKeys, []);
      assert.deepEqual(hiddenSearch.totals, {
        total: 0,
        active: 0,
        pending: 0,
      });
      assert.equal(hiddenSearch.nextCursor, null);

      const seen: string[] = [];
      let cursor: ReturnType<typeof decodeApiKeyCursor> | undefined;
      let firstPageTotals: {
        total: number;
        active: number;
        pending: number;
      } | null = null;
      do {
        const page = await repository.listAllApiKeys({
          limit: 1,
          cursor,
          now: later,
        });
        firstPageTotals ??= page.totals;
        seen.push(...page.apiKeys.map((key) => key.id));
        cursor = page.nextCursor
          ? decodeApiKeyCursor(page.nextCursor)
          : undefined;
      } while (cursor);
      assert.deepEqual(firstPageTotals, { total: 2, active: 1, pending: 0 });
      assert.deepEqual(new Set(seen), new Set([active.id, revoked.id]));
      assert.equal(seen.includes(firstPending.id), false);
      assert.equal(seen.includes(secondPending.id), false);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles an expired pending request id without stale metadata or secret", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-pending-replay-expiry-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owner = await repository.createUser({
        username: "pending-replay-expiry.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const start = new Date("2026-07-16T00:00:00.000Z");
      const begun = await repository.beginApiKeyCreation(
        owner.id,
        "lost-response-expired",
        "req-lost-response-expired",
        start,
      );
      assert.equal(begun.created, true);
      assert.ok(begun.secret);
      const later = new Date(start.getTime() + PENDING_API_KEY_TTL_MS);
      await assert.rejects(
        repository.beginApiKeyCreation(
          owner.id,
          "lost-response-expired",
          "req-lost-response-expired",
          later,
        ),
        (error) =>
          error instanceof AppError &&
          error.status === 410 &&
          error.code === "pending_expired" &&
          error.message === "Pending API key expired; create a new key",
      );
      assert.equal(
        (await repository.listApiKeys(owner.id, later)).some(
          (key) => key.id === begun.id,
        ),
        false,
      );

      // A later authorized write may physically clean the expired pending row,
      // but its canonical request intent must remain non-replayable.
      await repository.beginApiKeyCreation(
        owner.id,
        "cleanup-trigger",
        "req-cleanup-trigger",
        later,
      );
      await assert.rejects(
        repository.beginApiKeyCreation(
          owner.id,
          "lost-response-expired",
          "req-lost-response-expired",
          later,
        ),
        (error) =>
          error instanceof AppError &&
          error.status === 410 &&
          error.code === "pending_expired",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports expired pending activation and cancellation truthfully without cross-owner disclosure", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-pending-expired-actions-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owner = await repository.createUser({
        username: "pending-actions.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const outsider = await repository.createUser({
        username: "pending-actions.outsider",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const start = new Date("2026-07-17T00:00:00.000Z");
      const activation = await repository.beginApiKeyCreation(
        owner.id,
        "expired-activation",
        "req-expired-activation",
        start,
      );
      const cancellation = await repository.beginApiKeyCreation(
        owner.id,
        "expired-cancellation",
        "req-expired-cancellation",
        start,
      );
      const later = new Date(start.getTime() + PENDING_API_KEY_TTL_MS);
      await assert.rejects(
        repository.activateApiKey(activation.id, owner.id, false, later),
        (error) =>
          error instanceof AppError &&
          error.status === 410 &&
          error.code === "pending_expired",
      );
      await assert.rejects(
        repository.revokeApiKey(cancellation.id, owner.id, false, later),
        (error) =>
          error instanceof AppError &&
          error.status === 410 &&
          error.code === "pending_expired",
      );
      await assert.rejects(
        repository.revokeApiKey(cancellation.id, outsider.id, false, later),
        (error) =>
          error instanceof AppError &&
          error.status === 404 &&
          error.code === "api_key_not_found",
      );
      assert.deepEqual(await repository.listApiKeys(owner.id, later), []);
      assert.deepEqual(await repository.listApiKeys(outsider.id, later), []);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pending keys expire, are pruned, cancellable, and bounded", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-pending-bounds-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owner = await repository.createUser({
        username: "pending.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const start = new Date("2026-07-01T00:00:00.000Z");
      const expired = new Date(start.getTime() + PENDING_API_KEY_TTL_MS + 1000);

      // Expiry: an aged pending key can no longer be activated.
      const stale = await repository.beginApiKeyCreation(
        owner.id,
        "stale-pending",
        "req-stale",
        start,
      );
      await assert.rejects(
        repository.activateApiKey(stale.id, owner.id, false, expired),
        (error) =>
          error instanceof AppError && error.code === "pending_expired",
      );
      // …and its secret still never authenticates.
      assert.equal(
        await repository.resolveApiKey(stale.secret!, expired),
        null,
      );

      // Pruning: the next begin clears expired pending rows.
      await repository.beginApiKeyCreation(
        owner.id,
        "fresh-pending",
        "req-fresh",
        expired,
      );
      const listed = await repository.listApiKeys(owner.id, expired);
      assert.equal(
        listed.some((key) => key.name === "stale-pending"),
        false,
      );

      // Cancel: revoking a pending key removes the never-active row.
      const fresh = listed.find((key) => key.name === "fresh-pending");
      const freshRow = await repository.listApiKeys(owner.id, expired);
      assert.equal(freshRow.length >= 1 || fresh !== undefined, true);
      const cancelTarget = (
        await repository.listApiKeys(owner.id, expired)
      ).find((key) => key.name === "fresh-pending")!;
      await repository.revokeApiKey(cancelTarget.id, owner.id, false, expired);
      assert.equal(
        (await repository.listApiKeys(owner.id)).some(
          (key) => key.name === "fresh-pending",
        ),
        false,
      );

      // Bound: at most MAX_PENDING_API_KEYS pending rows per user.
      for (let index = 0; index < MAX_PENDING_API_KEYS; index += 1) {
        await repository.beginApiKeyCreation(
          owner.id,
          `pending-${index}`,
          `req-cap-${index}`,
          expired,
        );
      }
      await assert.rejects(
        repository.beginApiKeyCreation(
          owner.id,
          "one-too-many",
          "req-cap-overflow",
          expired,
        ),
        (error) =>
          error instanceof AppError && error.code === "pending_key_limit",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("activation enforces the active-key limit and ownership", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-activation-limits-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owner = await repository.createUser({
        username: "capped.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      for (let index = 0; index < 10; index += 1) {
        await repository.createApiKey(owner.id, `active-${index}`);
      }
      // One-step creation still enforces the active cap…
      await assert.rejects(
        repository.createApiKey(owner.id, "over-active-cap"),
        (error) => error instanceof AppError && error.code === "api_key_limit",
      );
      // Phase 1 enforces the active cap before minting or returning a secret.
      await assert.rejects(
        repository.beginApiKeyCreation(
          owner.id,
          "pending-at-cap",
          "req-at-cap",
        ),
        (error) => error instanceof AppError && error.code === "api_key_limit",
      );
      assert.equal(
        (await repository.listApiKeys(owner.id)).some(
          (key) => key.name === "pending-at-cap",
        ),
        false,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reserves the last active-key slot atomically before returning a pending secret", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-begin-cap-race-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owner = await repository.createUser({
        username: "reservation.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      for (let index = 0; index < 9; index += 1) {
        await repository.createApiKey(owner.id, `active-${index}`);
      }
      const secretFactory = repository as unknown as {
        newSecret: () => { secret: string; id: string };
      };
      const originalNewSecret = secretFactory.newSecret.bind(repository);
      let mintedSecrets = 0;
      secretFactory.newSecret = () => {
        mintedSecrets += 1;
        return originalNewSecret();
      };

      const outcomes = await Promise.allSettled([
        repository.beginApiKeyCreation(owner.id, "candidate-a", "reserve-a"),
        repository.beginApiKeyCreation(owner.id, "candidate-b", "reserve-b"),
      ]);
      const fulfilled = outcomes.filter(
        (
          outcome,
        ): outcome is PromiseFulfilledResult<BeginApiKeyCreationResult> =>
          outcome.status === "fulfilled",
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );

      assert.equal(fulfilled.length, 1);
      assert.match(fulfilled[0]!.value.secret!, /^fsk_/u);
      assert.equal(mintedSecrets, 1);
      assert.equal(rejected.length, 1);
      assert.equal(
        rejected[0]!.reason instanceof AppError
          ? rejected[0]!.reason.code
          : null,
        "api_key_limit",
      );
      const keys = await repository.listApiKeys(owner.id);
      assert.equal(keys.filter((key) => key.status === "active").length, 9);
      assert.equal(keys.filter((key) => key.status === "pending").length, 1);
      await assert.rejects(
        repository.createApiKey(owner.id, "cannot-take-reserved-slot"),
        (error) => error instanceof AppError && error.code === "api_key_limit",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("user creation with a request id is idempotent and never duplicates", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-idempotent-create-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const admin = await repository.createUser({
        username: "idem.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });

      const first = await repository.createUserIdempotent(
        {
          username: "idem.member",
          password: MEMBER_CREDENTIAL,
          role: "member",
        },
        { userId: admin.id },
        "req-create-1",
      );
      assert.equal(first.created, true);
      assert.equal(first.user.username, "idem.member");

      // A retry with the same request id resolves to the SAME user —
      // never a duplicate, never a 409 — so the client that retained the
      // candidate password can truthfully finish the show-once flow.
      const retry = await repository.createUserIdempotent(
        {
          username: "idem.member",
          password: MEMBER_CREDENTIAL,
          role: "member",
        },
        { userId: admin.id },
        "req-create-1",
      );
      assert.equal(retry.created, false);
      assert.equal(retry.user.id, first.user.id);
      assert.equal(
        (await repository.listUsers()).filter(
          (user) => user.username === "idem.member",
        ).length,
        1,
      );
      // The original committed password still authenticates (bcrypt only;
      // the replay applied nothing).
      await repository.authenticatePassword(
        "idem.member",
        MEMBER_CREDENTIAL,
        "10.9.9.1",
      );

      // Reconciliation must never tell a client to show a candidate that
      // has since been superseded by another password mutation.
      await repository.setPassword(first.user.id, OTHER_CREDENTIAL);
      await assert.rejects(
        repository.createUserIdempotent(
          {
            username: "idem.member",
            password: MEMBER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-create-1",
        ),
        (error) =>
          error instanceof AppError && error.code === "credential_superseded",
      );

      // A different request id for the same username is a real duplicate.
      await assert.rejects(
        repository.createUserIdempotent(
          {
            username: "idem.member",
            password: OTHER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-create-2",
        ),
        (error) =>
          error instanceof AppError && error.code === "username_exists",
      );

      // Request ids are scoped per operation/actor: another actor reusing
      // the same id creates its own user rather than replaying.
      const legacyActor = await repository.createUserIdempotent(
        {
          username: "idem.legacy",
          password: OTHER_CREDENTIAL,
          role: "member",
        },
        { userId: null },
        "req-create-1",
      );
      assert.equal(legacyActor.created, true);
      assert.notEqual(legacyActor.user.id, first.user.id);

      // Concurrent duplicates commit exactly one user.
      const concurrent = await Promise.all([
        repository.createUserIdempotent(
          {
            username: "idem.race",
            password: MEMBER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-create-race",
        ),
        repository.createUserIdempotent(
          {
            username: "idem.race",
            password: MEMBER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-create-race",
        ),
      ]);
      assert.equal(concurrent[0].user.id, concurrent[1].user.id);
      assert.equal(
        (await repository.listUsers()).filter(
          (user) => user.username === "idem.race",
        ).length,
        1,
      );

      // Retained metadata is bounded: the next successful authorized mutation
      // past the retention window prunes it. A later duplicate then reports
      // definitively instead of replaying stale metadata.
      const later = new Date(
        Date.now() + IDEMPOTENT_OPERATION_RETENTION_MS + 60_000,
      );
      await repository.createUserIdempotent(
        {
          username: "idem.retention.trigger",
          password: MEMBER_CREDENTIAL,
          role: "member",
        },
        { userId: admin.id },
        "req-retention-trigger",
        later,
      );
      await assert.rejects(
        repository.createUserIdempotent(
          {
            username: "idem.member",
            password: MEMBER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-create-1",
          later,
        ),
        (error) =>
          error instanceof AppError && error.code === "username_exists",
      );

      // Request ids are validated like the API-key ones.
      await assert.rejects(
        repository.createUserIdempotent(
          { username: "idem.bad", password: MEMBER_CREDENTIAL, role: "member" },
          { userId: admin.id },
          "x".repeat(129),
        ),
        (error) =>
          error instanceof AppError && error.code === "invalid_request_id",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds user-create request ids to the sequential and concurrent normalized username", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-create-username-intent-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const admin = await repository.createUser({
        username: "username-intent.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      const first = await repository.createUserIdempotent(
        {
          username: "  Username.Intent.Member  ",
          password: MEMBER_CREDENTIAL,
          role: "member",
        },
        { userId: admin.id },
        "req-username-sequential",
      );
      const exactReplay = await repository.createUserIdempotent(
        {
          username: "username.intent.member",
          password: MEMBER_CREDENTIAL,
          role: "member",
        },
        { userId: admin.id },
        "req-username-sequential",
      );
      assert.equal(exactReplay.created, false);
      assert.equal(exactReplay.user.id, first.user.id);
      await assert.rejects(
        repository.createUserIdempotent(
          {
            username: "username.intent.different",
            password: MEMBER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-username-sequential",
        ),
        (error) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );

      const concurrent = await Promise.allSettled([
        repository.createUserIdempotent(
          {
            username: "username.intent.race-a",
            password: OTHER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-username-concurrent",
        ),
        repository.createUserIdempotent(
          {
            username: "username.intent.race-b",
            password: OTHER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-username-concurrent",
        ),
      ]);
      assert.equal(
        concurrent.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const rejected = concurrent.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      assert.ok(rejected);
      assert.ok(
        rejected.reason instanceof AppError &&
          rejected.reason.code === "request_id_conflict",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds user-create request ids to the sequential and concurrent requested role", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-create-role-intent-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const admin = await repository.createUser({
        username: "role-intent.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      const input = {
        username: "role-intent.member",
        password: MEMBER_CREDENTIAL,
        role: "member" as const,
      };
      const first = await repository.createUserIdempotent(
        input,
        { userId: admin.id },
        "req-role-sequential",
      );
      assert.equal(first.created, true);
      await repository.setRole(first.user.id, "admin", admin.id);
      const exactReplay = await repository.createUserIdempotent(
        input,
        { userId: admin.id },
        "req-role-sequential",
      );
      assert.equal(exactReplay.created, false);
      assert.equal(exactReplay.user.role, "admin");
      await assert.rejects(
        repository.createUserIdempotent(
          { ...input, role: "admin" },
          { userId: admin.id },
          "req-role-sequential",
        ),
        (error) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );

      const concurrent = await Promise.allSettled([
        repository.createUserIdempotent(
          {
            username: "role-intent.race",
            password: OTHER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-role-concurrent",
        ),
        repository.createUserIdempotent(
          {
            username: "role-intent.race",
            password: OTHER_CREDENTIAL,
            role: "admin",
          },
          { userId: admin.id },
          "req-role-concurrent",
        ),
      ]);
      assert.equal(
        concurrent.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const rejected = concurrent.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      assert.ok(rejected);
      assert.ok(
        rejected.reason instanceof AppError &&
          rejected.reason.code === "request_id_conflict",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds user-create request ids to the sequential and concurrent credential candidate", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-create-credential-intent-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const admin = await repository.createUser({
        username: "credential-intent.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      const first = await repository.createUserIdempotent(
        {
          username: "credential-intent.member",
          password: MEMBER_CREDENTIAL,
          role: "member",
        },
        { userId: admin.id },
        "req-credential-sequential",
      );
      assert.equal(first.created, true);
      await assert.rejects(
        repository.createUserIdempotent(
          {
            username: "credential-intent.member",
            password: OTHER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-credential-sequential",
        ),
        (error) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );

      const concurrent = await Promise.allSettled([
        repository.createUserIdempotent(
          {
            username: "credential-intent.race",
            password: MEMBER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-credential-concurrent",
        ),
        repository.createUserIdempotent(
          {
            username: "credential-intent.race",
            password: OTHER_CREDENTIAL,
            role: "member",
          },
          { userId: admin.id },
          "req-credential-concurrent",
        ),
      ]);
      assert.equal(
        concurrent.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const rejected = concurrent.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      assert.ok(rejected);
      assert.ok(
        rejected.reason instanceof AppError &&
          rejected.reason.code === "request_id_conflict",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("revalidates disabled and demoted administrators before every password-reset replay outcome", async () => {
    const cases = [
      { replay: "modern-exact", authority: "disabled" },
      { replay: "modern-exact", authority: "demoted" },
      { replay: "modern-mismatch", authority: "disabled" },
      { replay: "modern-mismatch", authority: "demoted" },
      { replay: "legacy-upgrade", authority: "disabled" },
      { replay: "legacy-upgrade", authority: "demoted" },
    ] as const;

    for (const testCase of cases) {
      const directory = await mkdtemp(
        path.join(
          os.tmpdir(),
          `fs-auth-reset-replay-${testCase.replay}-${testCase.authority}-`,
        ),
      );
      const repository = await AuthRepository.create(
        `file:${path.join(directory, "auth.db")}`,
      );
      try {
        const admin = await repository.createUser({
          username: `replay.${testCase.replay}.${testCase.authority}.admin`,
          password: ADMIN_CREDENTIAL,
          role: "admin",
        });
        const target = await repository.createUser({
          username: `replay.${testCase.replay}.${testCase.authority}.target`,
          password: MEMBER_CREDENTIAL,
          role: "member",
        });
        const candidate = credentialFixture(
          `${testCase.replay}-${testCase.authority}`,
        );
        const requestId = `request-${testCase.replay}-${testCase.authority}`;
        await repository.resetPasswordIdempotent(
          target.id,
          candidate,
          admin.id,
          requestId,
        );

        const internal = repository as unknown as { client: Client };
        if (testCase.replay === "legacy-upgrade") {
          await internal.client.execute({
            sql: `UPDATE idempotent_operations
              SET intent_version = NULL, intent_username = NULL,
                intent_role = NULL, intent_credential_hash = NULL
              WHERE operation = 'password_reset' AND actor_key = ?
                AND request_id = ?`,
            args: [admin.id, requestId],
          });
        }
        const readOperation = async () => {
          const result = await internal.client.execute({
            sql: `SELECT operation, actor_key, request_id, user_id, created_at,
                intent_version, intent_username, intent_role,
                intent_credential_hash
              FROM idempotent_operations
              WHERE operation = 'password_reset' AND actor_key = ?
                AND request_id = ?`,
            args: [admin.id, requestId],
          });
          return JSON.stringify(result.rows[0]);
        };
        const before = await readOperation();
        const originalTransaction = internal.client.transaction.bind(
          internal.client,
        );
        let revoked = false;
        internal.client.transaction = async (mode?: TransactionMode) => {
          if (!revoked) {
            revoked = true;
            await internal.client.execute({
              sql:
                testCase.authority === "disabled"
                  ? "UPDATE users SET active = 0 WHERE id = ?"
                  : "UPDATE users SET role = 'member' WHERE id = ?",
              args: [admin.id],
            });
          }
          return originalTransaction(mode);
        };

        await assert.rejects(
          repository.resetPasswordIdempotent(
            target.id,
            testCase.replay === "modern-mismatch"
              ? credentialFixture(`mismatch-${testCase.authority}`)
              : candidate,
            admin.id,
            requestId,
          ),
          (error: unknown) =>
            error instanceof AppError && error.code === "admin_revoked",
          `${testCase.authority} ${testCase.replay}`,
        );
        assert.equal(
          await readOperation(),
          before,
          `${testCase.replay} row changed`,
        );
      } finally {
        await repository.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("preserves exact replay semantics for the null legacy-service actor", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-reset-replay-legacy-service-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const target = await repository.createUser({
        username: "replay.legacy-service.target",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const candidate = credentialFixture("legacy-service-reset");
      const requestId = "request-legacy-service-reset";
      assert.equal(
        (
          await repository.resetPasswordIdempotent(
            target.id,
            candidate,
            null,
            requestId,
          )
        ).applied,
        true,
      );
      assert.equal(
        (
          await repository.resetPasswordIdempotent(
            target.id,
            candidate,
            null,
            requestId,
          )
        ).applied,
        false,
      );
      await assert.rejects(
        repository.resetPasswordIdempotent(
          target.id,
          credentialFixture("legacy-service-mismatch"),
          null,
          requestId,
        ),
        (error: unknown) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );

      const internal = repository as unknown as { client: Client };
      await internal.client.execute({
        sql: `UPDATE idempotent_operations
          SET intent_version = NULL, intent_username = NULL,
            intent_role = NULL, intent_credential_hash = NULL
          WHERE operation = 'password_reset' AND actor_key = 'legacy'
            AND request_id = ?`,
        args: [requestId],
      });
      assert.equal(
        (
          await repository.resetPasswordIdempotent(
            target.id,
            candidate,
            null,
            requestId,
          )
        ).applied,
        false,
      );
      const upgraded = await internal.client.execute({
        sql: `SELECT intent_version FROM idempotent_operations
          WHERE operation = 'password_reset' AND actor_key = 'legacy'
            AND request_id = ?`,
        args: [requestId],
      });
      assert.equal(upgraded.rows[0]?.intent_version, 1);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("password reset with a request id applies exactly once and never silently overwrites", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-idempotent-reset-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const admin = await repository.createUser({
        username: "reset.admin",
        password: ADMIN_CREDENTIAL,
        role: "admin",
      });
      const member = await repository.createUser({
        username: "reset.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const session = await repository.createSession(member.id);

      const firstCandidate = credentialFixture("reset-one");
      const first = await repository.resetPasswordIdempotent(
        member.id,
        firstCandidate,
        admin.id,
        "req-reset-1",
      );
      assert.equal(first.applied, true);
      // The reset revokes existing sessions and applies the candidate.
      assert.equal(await repository.resolveSession(session.token), null);
      await repository.authenticatePassword(
        "reset.member",
        firstCandidate,
        "10.9.9.2",
      );

      const internal = repository as unknown as { client: Client };
      const storedIntent = await internal.client.execute({
        sql: `SELECT intent_version, intent_credential_hash
          FROM idempotent_operations
          WHERE operation = 'password_reset' AND request_id = ?`,
        args: ["req-reset-1"],
      });
      assert.equal(storedIntent.rows[0]?.intent_version, 1);
      assert.equal(
        typeof storedIntent.rows[0]?.intent_credential_hash,
        "string",
      );
      assert.notEqual(
        storedIntent.rows[0]?.intent_credential_hash,
        firstCandidate,
      );
      assert.equal(
        await verifyPassword(
          firstCandidate,
          storedIntent.rows[0]?.intent_credential_hash as string,
        ),
        true,
      );

      await assert.rejects(
        repository.resetPasswordIdempotent(
          member.id,
          credentialFixture("reset-one-mismatch"),
          admin.id,
          "req-reset-1",
        ),
        (error) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );

      // A replayed reset applies NOTHING — no second password, no session
      // revocation storm — and reports the reconciliation truthfully.
      const replay = await repository.resetPasswordIdempotent(
        member.id,
        firstCandidate,
        admin.id,
        "req-reset-1",
      );
      assert.equal(replay.applied, false);
      await repository.authenticatePassword(
        "reset.member",
        firstCandidate,
        "10.9.9.3",
      );

      // A different, later reset wins…
      const secondCandidate = credentialFixture("reset-two");
      const second = await repository.resetPasswordIdempotent(
        member.id,
        secondCandidate,
        admin.id,
        "req-reset-2",
      );
      assert.equal(second.applied, true);

      // The later candidate is current, but it was never the intent bound to
      // req-reset-1. Current-state coincidence must not turn a mismatch into
      // a successful replay.
      await assert.rejects(
        repository.resetPasswordIdempotent(
          member.id,
          secondCandidate,
          admin.id,
          "req-reset-1",
        ),
        (error) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );

      // …and replaying the FIRST request id afterwards must not silently
      // re-apply OR falsely present the old candidate as current.
      await assert.rejects(
        repository.resetPasswordIdempotent(
          member.id,
          firstCandidate,
          admin.id,
          "req-reset-1",
        ),
        (error) =>
          error instanceof AppError && error.code === "credential_superseded",
      );
      await repository.authenticatePassword(
        "reset.member",
        secondCandidate,
        "10.9.9.4",
      );
      await assert.rejects(
        repository.authenticatePassword(
          "reset.member",
          firstCandidate,
          "10.9.9.5",
        ),
        (error) =>
          error instanceof AppError && error.code === "invalid_credentials",
      );

      // If a later independent reset deliberately returns to the exact same
      // candidate, the original request's intent still matches and the
      // current credential can be reconciled without applying it again.
      const samePasswordLater = await repository.resetPasswordIdempotent(
        member.id,
        firstCandidate,
        admin.id,
        "req-reset-same-password-later",
      );
      assert.equal(samePasswordLater.applied, true);
      const samePasswordReplay = await repository.resetPasswordIdempotent(
        member.id,
        firstCandidate,
        admin.id,
        "req-reset-1",
      );
      assert.equal(samePasswordReplay.applied, false);

      // A request id is bound to its original reset target within the
      // actor+operation scope; reusing it for another user is a conflict.
      const otherMember = await repository.createUser({
        username: "reset.other",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      await assert.rejects(
        repository.resetPasswordIdempotent(
          otherMember.id,
          firstCandidate,
          admin.id,
          "req-reset-1",
        ),
        (error) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );

      // Concurrent duplicates apply at most one reset.
      const concurrent = await Promise.all([
        repository.resetPasswordIdempotent(
          member.id,
          credentialFixture("reset-race"),
          admin.id,
          "req-reset-race",
        ),
        repository.resetPasswordIdempotent(
          member.id,
          credentialFixture("reset-race"),
          admin.id,
          "req-reset-race",
        ),
      ]);
      assert.equal(concurrent.filter((outcome) => outcome.applied).length, 1);

      const differingCandidateRace = await Promise.allSettled([
        repository.resetPasswordIdempotent(
          member.id,
          credentialFixture("reset-same-id-race-a"),
          admin.id,
          "req-reset-same-id-race",
        ),
        repository.resetPasswordIdempotent(
          member.id,
          credentialFixture("reset-same-id-race-b"),
          admin.id,
          "req-reset-same-id-race",
        ),
      ]);
      assert.equal(
        differingCandidateRace.filter(
          (outcome) => outcome.status === "fulfilled",
        ).length,
        1,
      );
      const differingCandidateRejection = differingCandidateRace.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      assert.ok(differingCandidateRejection);
      assert.ok(
        differingCandidateRejection.reason instanceof AppError &&
          differingCandidateRejection.reason.code === "request_id_conflict",
      );

      // Different requests that overlap are compare-and-set mutations: one
      // wins and the other reports a conflict instead of silently replacing
      // a password that changed after its request began.
      const candidateA = credentialFixture("reset-race-a");
      const candidateB = credentialFixture("reset-race-b");
      const competing = await Promise.allSettled([
        repository.resetPasswordIdempotent(
          member.id,
          candidateA,
          admin.id,
          "req-reset-race-a",
        ),
        repository.resetPasswordIdempotent(
          member.id,
          candidateB,
          admin.id,
          "req-reset-race-b",
        ),
      ]);
      assert.equal(
        competing.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const rejected = competing.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      assert.ok(rejected);
      assert.ok(
        rejected.reason instanceof AppError &&
          rejected.reason.code === "password_reset_conflict",
      );

      await assert.rejects(
        repository.resetPasswordIdempotent(
          "missing-user",
          firstCandidate,
          admin.id,
          "req-reset-missing",
        ),
        (error) => error instanceof AppError && error.code === "user_not_found",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("concurrent duplicate activations both report active, never a false limit", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-concurrent-activation-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const owner = await repository.createUser({
        username: "race.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      // Sol P3-1 regression: two overlapping activations of the same
      // pending key raced read-then-update and returned
      // [active, api_key_limit] even though the key ended active. Both
      // callers must observe the idempotent active outcome.
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const pending = await repository.beginApiKeyCreation(
          owner.id,
          `race-key-${iteration}`,
          `req-race-${iteration}`,
        );
        const outcomes = await Promise.all([
          repository.activateApiKey(pending.id, owner.id, false),
          repository.activateApiKey(pending.id, owner.id, false),
        ]);
        assert.deepEqual(
          outcomes.map((outcome) => outcome.status),
          ["active", "active"],
          `iteration ${iteration} returned ${JSON.stringify(outcomes)}`,
        );
        await repository.revokeApiKey(pending.id, owner.id, false);
      }
      // A key whose pending window truly lapsed still reports
      // pending_expired from the zero-row path, not a false limit.
      const stale = await repository.beginApiKeyCreation(
        owner.id,
        "race-stale",
        "req-race-stale",
      );
      const lapsed = new Date(Date.now() + PENDING_API_KEY_TTL_MS + 1000);
      await assert.rejects(
        repository.activateApiKey(stale.id, owner.id, false, lapsed),
        (error) =>
          error instanceof AppError && error.code === "pending_expired",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds populated legacy user and session schemas to fresh-schema parity", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-users-schema-parity-test-"),
    );
    const legacyUrl = `file:${path.join(directory, "legacy.db")}`;
    const legacy = createClient({ url: legacyUrl, intMode: "number" });
    await legacy.executeMultiple(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id TEXT PRIMARY KEY NOT NULL,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        password_changed_at TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_digest TEXT NOT NULL UNIQUE CHECK(length(token_digest) = 64),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `);
    await legacy.execute({
      sql: `INSERT INTO users VALUES (?, ?, ?, 'admin', 1, ?, ?, NULL)`,
      args: [
        "legacy-user",
        "legacy-admin",
        await hashPassword(ADMIN_CREDENTIAL),
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      ],
    });
    await legacy.execute({
      sql: `INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL)`,
      args: [
        "legacy-session",
        "legacy-user",
        "a".repeat(64),
        "2026-01-02T00:00:00.000Z",
        "2026-01-09T00:00:00.000Z",
      ],
    });
    legacy.close();

    const [first, second] = await Promise.all([
      AuthRepository.create(legacyUrl),
      AuthRepository.create(legacyUrl),
    ]);
    try {
      const inspection = createClient({ url: legacyUrl, intMode: "number" });
      try {
        const userColumns = await inspection.execute(
          "PRAGMA table_info(users)",
        );
        const sessionColumns = await inspection.execute(
          "PRAGMA table_info(sessions)",
        );
        for (const name of [
          "password_changed_at",
          "temporary_password_expires_at",
        ]) {
          const column = userColumns.rows.find((row) => row.name === name);
          assert.ok(column);
          if (name === "password_changed_at") assert.equal(column.notnull, 1);
        }
        for (const name of ["last_seen_at", "idle_expires_at"]) {
          const column = sessionColumns.rows.find((row) => row.name === name);
          assert.equal(column?.notnull, 1);
        }
        const retained = await inspection.execute(
          "SELECT password_changed_at FROM users WHERE id = 'legacy-user'",
        );
        assert.equal(
          retained.rows[0]?.password_changed_at,
          "2026-01-01T00:00:00.000Z",
        );
        const session = await inspection.execute(
          "SELECT last_seen_at, idle_expires_at FROM sessions WHERE id = 'legacy-session'",
        );
        assert.equal(session.rows[0]?.last_seen_at, "2026-01-02T00:00:00.000Z");
        assert.equal(
          session.rows[0]?.idle_expires_at,
          "2026-01-02T12:00:00.000Z",
        );
        assert.equal(
          (await inspection.execute("PRAGMA foreign_key_check")).rows.length,
          0,
        );
        const indexes = await inspection.execute("PRAGMA index_list(sessions)");
        assert.ok(
          indexes.rows.some((row) => row.name === "sessions_user_active_idx"),
        );
      } finally {
        inspection.close();
      }
    } finally {
      first.close();
      second.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates an existing api_keys table to the two-phase schema", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-migration-test-"),
    );
    const url = `file:${path.join(directory, "auth.db")}`;
    try {
      await seedLegacySchema(url);

      const repository = await AuthRepository.create(url);
      try {
        // Existing rows read as active credentials.
        const listed = await repository.listApiKeys("legacy-user");
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.status, "active");
        const migratedUser = await repository.getUser("legacy-user");
        assert.equal(migratedUser?.passwordChangedAt, migratedUser?.createdAt);
        // And the two-phase flow works on the migrated table.
        const begun = await repository.beginApiKeyCreation(
          "legacy-user",
          "migrated-pending",
          "req-migrated",
        );
        assert.equal(begun.status, "pending");
        // The upgraded table carries the exact fresh-schema semantic
        // constraint, not just the unconstrained added column.
        assert.match(await apiKeysTableSql(url), CANONICAL_STATUS_CHECK);
      } finally {
        await repository.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds an intermediate status-only schema to the canonical constrained one", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-migration-intermediate-test-"),
    );
    const url = `file:${path.join(directory, "auth.db")}`;
    try {
      // Intermediate shape: status exists (unconstrained) but the
      // request/pending columns never got added.
      const seeded = createClient({ url });
      await seeded.executeMultiple(`
        ${LEGACY_USERS_TABLE}
        CREATE TABLE api_keys (
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
          status TEXT NOT NULL DEFAULT 'active'
        );
        INSERT INTO users VALUES ('mid-user', 'mid.user', 'x', 'member', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO api_keys VALUES ('mid-key', 'mid-user', 'mid-cli', '${"b".repeat(64)}', 'fsk_mid00000', 'yyyy', '2026-01-02T03:04:05.000Z', NULL, NULL, NULL, 'active');
      `);
      seeded.close();

      const repository = await AuthRepository.create(url);
      try {
        assert.match(await apiKeysTableSql(url), CANONICAL_STATUS_CHECK);
        const listed = await repository.listApiKeys("mid-user");
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.status, "active");
        assert.equal(listed[0]?.createdAt, "2026-01-02T03:04:05.000Z");
        const begun = await repository.beginApiKeyCreation(
          "mid-user",
          "mid-pending",
          "req-mid",
        );
        assert.equal(begun.status, "pending");
      } finally {
        await repository.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds the current unconstrained schema, applies retention, and preserves indexes and FK behavior", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-migration-unconstrained-test-"),
    );
    const url = `file:${path.join(directory, "auth.db")}`;
    try {
      // The shape produced by the previous ALTER-based migration: all
      // three columns exist but status carries no CHECK.
      const seeded = createClient({ url });
      await seeded.executeMultiple(`
        ${LEGACY_USERS_TABLE}
        CREATE TABLE api_keys (
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
          status TEXT NOT NULL DEFAULT 'active',
          request_id TEXT,
          pending_expires_at TEXT
        );
        CREATE INDEX api_keys_user_active_idx ON api_keys(user_id, revoked_at);
        CREATE UNIQUE INDEX api_keys_request_idx ON api_keys(request_id) WHERE request_id IS NOT NULL;
        INSERT INTO users VALUES ('up-user', 'up.user', 'x', 'member', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO api_keys VALUES ('up-active', 'up-user', 'up-active-cli', '${"c".repeat(64)}', 'fsk_upact000', 'aaaa', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z', NULL, NULL, 'active', NULL, NULL);
        INSERT INTO api_keys VALUES ('up-revoked', 'up-user', 'up-revoked-cli', '${"d".repeat(64)}', 'fsk_uprev000', 'bbbb', '2026-02-03T00:00:00.000Z', NULL, NULL, '2026-02-04T00:00:00.000Z', 'active', NULL, NULL);
        INSERT INTO api_keys VALUES ('up-pending', 'up-user', 'up-pending-ui', '${"e".repeat(64)}', 'fsk_uppen000', 'cccc', '2026-02-05T00:00:00.000Z', NULL, NULL, NULL, 'pending', 'req-up-pending', '2099-01-01T00:00:00.000Z');
      `);
      seeded.close();

      const repository = await AuthRepository.create(url);
      try {
        assert.match(await apiKeysTableSql(url), CANONICAL_STATUS_CHECK);
        // Live and pending rows survive with identical metadata; startup
        // maintenance removes revoked rows already outside the 90-day bound.
        const listed = await repository.listApiKeys("up-user");
        assert.deepEqual(
          listed.map((key) => [
            key.id,
            key.status,
            key.createdAt,
            key.lastUsedAt,
            key.revokedAt,
            key.pendingExpiresAt,
          ]),
          [
            [
              "up-active",
              "active",
              "2026-02-01T00:00:00.000Z",
              "2026-02-02T00:00:00.000Z",
              null,
              null,
            ],

            [
              "up-pending",
              "pending",
              "2026-02-05T00:00:00.000Z",
              null,
              null,
              "2099-01-01T00:00:00.000Z",
            ],
          ],
        );
        // Request-id reconciliation metadata survives the rebuild.
        const reconciled = await repository.beginApiKeyCreation(
          "up-user",
          "up-pending-ui",
          "req-up-pending",
        );
        assert.equal(reconciled.created, false);
        assert.equal(reconciled.id, "up-pending");
        assert.equal(reconciled.secret, null);
      } finally {
        await repository.close();
      }

      const probe = createClient({ url });
      try {
        await probe.execute("PRAGMA foreign_keys = ON");
        // Both indexes (including the partial unique request index) exist.
        const indexes = await probe.execute(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_keys'",
        );
        const names = new Set(
          indexes.rows.map((row) =>
            typeof row.name === "string" ? row.name : "",
          ),
        );
        assert.equal(names.has("api_keys_user_active_idx"), true);
        assert.equal(names.has("api_keys_request_idx"), true);
        // The partial unique index still enforces request-id uniqueness…
        await assert.rejects(
          probe.execute(
            `INSERT INTO api_keys (id, user_id, name, key_digest, key_prefix, last_four, created_at, status, request_id, pending_expires_at)
             VALUES ('up-dup', 'up-user', 'dup', '${"f".repeat(64)}', 'fsk_updup000', 'dddd', '2026-02-06T00:00:00.000Z', 'pending', 'req-up-pending', '2099-01-01T00:00:00.000Z')`,
          ),
          /unique/iu,
        );
        // …the CHECK rejects invalid statuses…
        await assert.rejects(
          probe.execute(
            `INSERT INTO api_keys (id, user_id, name, key_digest, key_prefix, last_four, created_at, status)
             VALUES ('up-bad', 'up-user', 'bad', '${"a1".repeat(32)}', 'fsk_upbad000', 'eeee', '2026-02-06T00:00:00.000Z', 'revoked')`,
          ),
          /check/iu,
        );
        // …and ON DELETE CASCADE still applies to the rebuilt table.
        await probe.execute("DELETE FROM users WHERE id = 'up-user'");
        const remaining = await probe.execute(
          "SELECT COUNT(*) AS count FROM api_keys",
        );
        assert.equal(Number(remaining.rows[0]?.count), 0);
      } finally {
        probe.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on invalid legacy status values without coercing them", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-migration-invalid-test-"),
    );
    const url = `file:${path.join(directory, "auth.db")}`;
    try {
      const seeded = createClient({ url });
      await seeded.executeMultiple(`
        ${LEGACY_USERS_TABLE}
        CREATE TABLE api_keys (
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
          status TEXT NOT NULL DEFAULT 'active',
          request_id TEXT,
          pending_expires_at TEXT
        );
        INSERT INTO users VALUES ('bad-user', 'bad.user', 'x', 'member', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO api_keys VALUES ('bad-key', 'bad-user', 'bad-cli', '${"9".repeat(64)}', 'fsk_bad00000', 'ffff', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, 'revoked', NULL, NULL);
      `);
      seeded.close();

      await assert.rejects(
        AuthRepository.create(url),
        (error) =>
          error instanceof AppError && error.code === "invalid_api_key_status",
      );

      // Fail closed means untouched: the row keeps its original value and
      // the table was not rebuilt or coerced.
      const probe = createClient({ url });
      try {
        const row = await probe.execute(
          "SELECT status FROM api_keys WHERE id = 'bad-key'",
        );
        assert.equal(row.rows[0]?.status, "revoked");
        assert.doesNotMatch(await apiKeysTableSql(url), CANONICAL_STATUS_CHECK);
      } finally {
        probe.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on a NULL legacy status without coercing it", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-migration-null-status-test-"),
    );
    const url = `file:${path.join(directory, "auth.db")}`;
    try {
      const seeded = createClient({ url });
      await seeded.executeMultiple(`
        ${LEGACY_USERS_TABLE}
        CREATE TABLE api_keys (
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
          status TEXT,
          request_id TEXT,
          pending_expires_at TEXT
        );
        INSERT INTO users VALUES ('null-user', 'null.user', 'x', 'member', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO api_keys VALUES ('null-key', 'null-user', 'null-cli', '${"8".repeat(64)}', 'fsk_null0000', 'eeee', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL);
      `);
      seeded.close();

      await assert.rejects(
        AuthRepository.create(url),
        (error) =>
          error instanceof AppError && error.code === "invalid_api_key_status",
      );

      const probe = createClient({ url });
      try {
        const row = await probe.execute(
          "SELECT status FROM api_keys WHERE id = 'null-key'",
        );
        assert.equal(row.rows[0]?.status, null);
        assert.doesNotMatch(await apiKeysTableSql(url), CANONICAL_STATUS_CHECK);
      } finally {
        probe.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("is idempotent and safe under concurrent repository startup", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-migration-concurrent-test-"),
    );
    try {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const directory = path.join(root, String(iteration));
        await mkdir(directory);
        const url = `file:${path.join(directory, "auth.db")}`;
        await seedLegacySchema(url);

        const repositories = await Promise.all(
          Array.from({ length: 4 }, () => AuthRepository.create(url)),
        );
        try {
          assert.match(await apiKeysTableSql(url), CANONICAL_STATUS_CHECK);
          const listed = await repositories[0]!.listApiKeys("legacy-user");
          assert.equal(listed.length, 1);
          assert.equal(listed[0]?.id, "legacy-key");
          // A later open of the already-canonical database is a no-op.
          const later = await AuthRepository.create(url);
          await later.close();
          assert.equal(
            (await repositories[1]!.listApiKeys("legacy-user")).length,
            1,
          );
        } finally {
          await Promise.all(
            repositories.map((repository) => repository.close()),
          );
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("upgrades populated owner-scoped request ids safely under concurrent startup", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-request-index-migration-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const seeded = await AuthRepository.create(databaseUrl);
    let repositories: AuthRepository[] = [];
    try {
      const firstOwner = await seeded.createUser({
        username: "index.first",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const secondOwner = await seeded.createUser({
        username: "index.second",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const requestId = "legacy-global-request-id";
      await seeded.beginApiKeyCreation(
        firstOwner.id,
        "legacy-pending",
        requestId,
      );
      await seeded.close();

      const legacy = createClient({ url: databaseUrl });
      try {
        await legacy.execute("DROP TABLE api_key_idempotent_operations");
        await legacy.execute("DROP INDEX api_keys_request_idx");
        await legacy.execute(
          "CREATE UNIQUE INDEX api_keys_request_idx ON api_keys(user_id, request_id) WHERE request_id IS NOT NULL",
        );
        await legacy.execute({
          sql: `INSERT INTO api_keys
            (id, user_id, name, key_digest, key_prefix, last_four, created_at,
              status, request_id, pending_expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          args: [
            "legacy-second-binding",
            secondOwner.id,
            "independent-pending",
            "7".repeat(64),
            "fsk_legacy2",
            "two2",
            "2098-01-01T00:00:00.000Z",
            requestId,
            "2099-01-01T00:00:00.000Z",
          ],
        });
      } finally {
        legacy.close();
      }

      repositories = await Promise.all(
        Array.from({ length: 4 }, () => AuthRepository.create(databaseUrl)),
      );
      const firstReplay = await repositories[1]!.beginApiKeyCreation(
        firstOwner.id,
        "legacy-pending",
        requestId,
      );
      assert.equal(firstReplay.created, false);
      await assert.rejects(
        repositories[0]!.beginApiKeyCreation(
          secondOwner.id,
          "independent-pending",
          requestId,
        ),
        (error) =>
          error instanceof AppError && error.code === "request_id_conflict",
      );
      const secondRows = await repositories[2]!.listApiKeys(secondOwner.id);
      assert.equal(
        secondRows.some((key) => key.id === "legacy-second-binding"),
        true,
      );

      const inspection = createClient({ url: databaseUrl });
      try {
        const index = await inspection.execute(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'api_keys_request_idx'",
        );
        const sql = index.rows[0]?.sql;
        if (typeof sql !== "string")
          throw new Error("request index SQL missing");
        assert.match(
          sql,
          /ON api_keys\s*\(request_id\)\s*WHERE request_id IS NOT NULL/iu,
        );
        const bindings = await inspection.execute({
          sql: `SELECT request_id, user_id, intent_version, intent_name, key_id
            FROM api_key_idempotent_operations WHERE request_id = ?`,
          args: [requestId],
        });
        assert.deepEqual(
          bindings.rows.map((row) => ({
            requestId: row.request_id,
            userId: row.user_id,
            intentVersion: row.intent_version,
            intentName: row.intent_name,
            keyId: row.key_id,
          })),
          [
            {
              requestId,
              userId: firstOwner.id,
              intentVersion: 1,
              intentName: "legacy-pending",
              keyId: firstReplay.id,
            },
          ],
        );
      } finally {
        inspection.close();
      }
      const later = await AuthRepository.create(databaseUrl);
      await later.close();
    } finally {
      await Promise.all(repositories.map((repository) => repository.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not purge another user's revoked API-key audit record", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-api-key-owner-retention-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const first = await repository.createUser({
        username: "first.key.owner",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const second = await repository.createUser({
        username: "second.key.owner",
        password: OTHER_CREDENTIAL,
        role: "member",
      });
      const revoked = await repository.createApiKey(first.id, "revoked-audit");
      await repository.revokeApiKey(revoked.id, first.id, false);
      await repository.createApiKey(second.id, "second-owner-key");

      const retained = await repository.listApiKeys(first.id);
      assert.equal(retained.length, 1);
      assert.notEqual(retained[0]!.revokedAt, null);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("caps active API keys while retaining recent revoked records", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-api-key-cap-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const member = await repository.createUser({
        username: "api.key.cap.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const keys = [];
      for (let index = 0; index < 10; index += 1) {
        keys.push(await repository.createApiKey(member.id, `key-${index}`));
      }
      await assert.rejects(
        repository.createApiKey(member.id, "over-limit"),
        (error: unknown) =>
          error instanceof AppError && error.code === "api_key_limit",
      );

      await repository.revokeApiKey(keys[0]!.id, member.id, false);
      await repository.createApiKey(member.id, "replacement");
      const retained = await repository.listApiKeys(member.id);
      // The active cap counts active keys only; the revoked record stays
      // listed for audit context under bounded retention.
      assert.equal(retained.length, 11);
      assert.equal(retained.filter((key) => key.revokedAt === null).length, 10);
      assert.equal(retained.filter((key) => key.revokedAt !== null).length, 1);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("caps active sessions per user while keeping the newest login", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-session-cap-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const member = await repository.createUser({
        username: "session.cap.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const start = new Date("2026-01-01T00:00:00.000Z");
      const sessions = [];
      for (let offset = 0; offset < 12; offset += 1) {
        sessions.push(
          await repository.createSession(
            member.id,
            new Date(start.getTime() + offset * 1000),
          ),
        );
      }

      const inspection = createClient({ url: databaseUrl, intMode: "number" });
      try {
        const result = await inspection.execute({
          sql: "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL",
          args: [member.id],
        });
        assert.equal(Number(result.rows[0]?.count), 10);
      } finally {
        inspection.close();
      }
      assert.equal(
        await repository.resolveSession(sessions[0]!.token, start),
        null,
      );
      assert.equal(
        (await repository.resolveSession(sessions.at(-1)!.token, start))?.id,
        member.id,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("expires sessions after 12 hours idle without extending the fixed maximum", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-session-idle-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const user = await repository.bootstrapAdmin({
        username: "idle.admin",
        password: ADMIN_CREDENTIAL,
      });
      const start = new Date("2026-01-01T00:00:00.000Z");
      const session = await repository.createSession(user.id, start);
      const elevenHours = 11 * 60 * 60 * 1000;
      assert.equal(
        (
          await repository.resolveSession(
            session.token,
            new Date(start.getTime() + elevenHours),
          )
        )?.id,
        user.id,
      );
      assert.equal(
        await repository.resolveSession(
          session.token,
          new Date(start.getTime() + 23 * 60 * 60 * 1000),
        ),
        null,
      );

      const active = await repository.createSession(user.id, start);
      for (
        let offset = elevenHours;
        offset < 7 * 24 * 60 * 60 * 1000;
        offset += elevenHours
      ) {
        await repository.resolveSession(
          active.token,
          new Date(start.getTime() + offset),
        );
      }
      assert.equal(
        await repository.resolveSession(
          active.token,
          new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000),
        ),
        null,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not slide idle expiry for probes, but real activity slides within the absolute cap", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-session-probe-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const user = await repository.bootstrapAdmin({
        username: "probe.admin",
        password: ADMIN_CREDENTIAL,
      });
      const start = new Date("2026-01-01T00:00:00.000Z");
      const session = await repository.createSession(user.id, start);

      for (let minute = 1; minute < 12 * 60; minute += 1) {
        assert.equal(
          (
            await repository.resolveSession(
              session.token,
              new Date(start.getTime() + minute * 60_000),
              { slide: false },
            )
          )?.id,
          user.id,
        );
      }
      assert.equal(
        await repository.resolveSession(
          session.token,
          new Date(start.getTime() + 12 * 60 * 60 * 1000),
          { slide: false },
        ),
        null,
      );

      const active = await repository.createSession(user.id, start);
      const elevenHours = new Date(start.getTime() + 11 * 60 * 60 * 1000);
      assert.equal(
        (
          await repository.resolveSession(active.token, elevenHours, {
            slide: true,
          })
        )?.id,
        user.id,
      );
      assert.equal(
        (
          await repository.resolveSession(
            active.token,
            new Date(start.getTime() + 22 * 60 * 60 * 1000),
            { slide: false },
          )
        )?.id,
        user.id,
      );
      assert.equal(
        await repository.resolveSession(
          active.token,
          new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000),
          { slide: true },
        ),
        null,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("counts only live sessions and derives activity from last_seen_at", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-session-aggregate-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const users = await Promise.all(
        ["idle", "maximum", "revoked", "live"].map((state) =>
          repository.createUser({
            username: `aggregate.${state}`,
            password: MEMBER_CREDENTIAL,
            role: "member",
          }),
        ),
      );
      const now = new Date("2026-08-04T12:00:00.000Z");
      const inspection = createClient({ url: databaseUrl });
      try {
        const rows = [
          [
            users[0]!.id,
            "2026-08-04T10:00:00.000Z",
            "2026-08-04T11:59:59.000Z",
            "2026-08-05T12:00:00.000Z",
            null,
          ],
          [
            users[1]!.id,
            "2026-08-04T10:01:00.000Z",
            "2026-08-05T12:00:00.000Z",
            "2026-08-04T11:59:59.000Z",
            null,
          ],
          [
            users[2]!.id,
            "2026-08-04T10:02:00.000Z",
            "2026-08-05T12:00:00.000Z",
            "2026-08-05T12:00:00.000Z",
            "2026-08-04T11:00:00.000Z",
          ],
          [
            users[3]!.id,
            "2026-08-04T10:03:00.000Z",
            "2026-08-05T12:00:00.000Z",
            "2026-08-05T12:00:00.000Z",
            null,
          ],
        ] as const;
        for (const [index, row] of rows.entries()) {
          await inspection.execute({
            sql: `INSERT INTO sessions
              (id, user_id, token_digest, created_at, last_seen_at, idle_expires_at, expires_at, revoked_at)
              VALUES (?, ?, ?, '2026-08-01T00:00:00.000Z', ?, ?, ?, ?)`,
            args: [
              `aggregate-session-${index}`,
              row[0],
              String(index).repeat(64),
              ...row.slice(1),
            ],
          });
        }
      } finally {
        inspection.close();
      }

      const usage = await repository.usageByUser(
        users.map((user) => user.id),
        now,
      );
      assert.deepEqual(
        users.map((user) => usage.get(user.id)?.sessions),
        [0, 0, 0, 1],
      );
      assert.deepEqual(
        users.map((user) => usage.get(user.id)?.lastActiveAt),
        [
          "2026-08-04T10:00:00.000Z",
          "2026-08-04T10:01:00.000Z",
          "2026-08-04T10:02:00.000Z",
          "2026-08-04T10:03:00.000Z",
        ],
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("purges expired and revoked sessions before creating a new session", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-session-retention-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const user = await repository.bootstrapAdmin({
        username: "sessions.admin",
        password: ADMIN_CREDENTIAL,
      });
      const start = new Date("2025-01-01T00:00:00.000Z");
      await repository.createSession(user.id, start);
      const revoked = await repository.createSession(
        user.id,
        new Date(start.getTime() + 1000),
      );
      await repository.revokeSession(
        revoked.token,
        new Date(start.getTime() + 2000),
      );
      await repository.createSession(
        user.id,
        new Date(start.getTime() + 8 * 24 * 60 * 60 * 1000),
      );

      const inspection = createClient({ url: databaseUrl, intMode: "number" });
      try {
        const result = await inspection.execute(
          "SELECT COUNT(*) AS count FROM sessions",
        );
        assert.equal(Number(result.rows[0]?.count), 1);
      } finally {
        inspection.close();
      }
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("purges expired login throttle records", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-throttle-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const windowStart = new Date("2025-01-01T00:00:00.000Z");
      await assert.rejects(
        repository.authenticatePassword(
          "missing.one",
          WRONG_CREDENTIAL,
          "192.0.2.1",
          windowStart,
        ),
        /invalid username or password/iu,
      );
      await assert.rejects(
        repository.authenticatePassword(
          "missing.two",
          WRONG_CREDENTIAL,
          "192.0.2.2",
          new Date(windowStart.getTime() + 16 * 60 * 1000),
        ),
        /invalid username or password/iu,
      );

      const inspection = createClient({ url: databaseUrl, intMode: "number" });
      try {
        const result = await inspection.execute(
          "SELECT COUNT(*) AS count FROM login_failures",
        );
        assert.equal(Number(result.rows[0]?.count), 2);
      } finally {
        inspection.close();
      }
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("disabling an account transactionally revokes sessions so re-enable cannot revive them", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-disable-session-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const admin = await repository.bootstrapAdmin({
        username: "session.admin",
        password: ADMIN_CREDENTIAL,
      });
      const member = await repository.createUser({
        username: "session.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const memberSession = await repository.createSession(member.id);
      const adminSession = await repository.createSession(admin.id);
      assert.equal(
        (await repository.resolveSession(memberSession.token))?.id,
        member.id,
      );

      await repository.setActive(member.id, false);
      assert.equal(await repository.resolveSession(memberSession.token), null);
      await repository.setActive(member.id, true);
      assert.equal(await repository.resolveSession(memberSession.token), null);

      const inspection = createClient({ url: databaseUrl });
      try {
        const revoked = await inspection.execute({
          sql: "SELECT revoked_at FROM sessions WHERE user_id = ?",
          args: [member.id],
        });
        assert.equal(typeof revoked.rows[0]?.revoked_at, "string");
      } finally {
        inspection.close();
      }

      // Transactional rollback adjacency: a rejected last-admin disable must
      // not revoke that administrator's still-valid session.
      await assert.rejects(
        repository.setActive(admin.id, false),
        (error) =>
          error instanceof AppError && error.code === "last_active_admin",
      );
      assert.equal(
        (await repository.resolveSession(adminSession.token))?.id,
        admin.id,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes overlapping write transactions and recovers after rollback", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-write-serialization-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const user = await repository.bootstrapAdmin({
        username: "serialized.admin",
        password: ADMIN_CREDENTIAL,
      });
      const failed = repository.createSession("missing-user");
      const successful = repository.createSession(user.id);
      const [rolledBack, committed] = await Promise.allSettled([
        failed,
        successful,
      ]);
      assert.equal(rolledBack.status, "rejected");
      assert.equal(committed.status, "fulfilled");
      if (committed.status === "fulfilled") {
        assert.equal(
          (await repository.resolveSession(committed.value.token))?.id,
          user.id,
        );
      }

      const recovered = await repository.createSession(user.id);
      assert.equal(
        (await repository.resolveSession(recovered.token))?.id,
        user.id,
      );
      const rotated = repository.changePasswordAndRotateSession(
        user.id,
        ADMIN_CREDENTIAL,
        SECOND_ADMIN_CREDENTIAL,
        recovered.token,
      );
      const overlapping = repository.createSession(user.id);
      const rotationResults = await Promise.allSettled([rotated, overlapping]);
      assert.equal(
        rotationResults.filter((result) => result.status === "fulfilled")
          .length,
        2,
      );
      await repository.authenticatePassword(
        user.username,
        SECOND_ADMIN_CREDENTIAL,
        "192.0.2.240",
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("expires unused temporary passwords after seven days", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-temporary-password-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const user = await repository.createUser({
        username: "temporary.member",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const expires = new Date(
        Date.parse(user.createdAt) + 7 * 24 * 60 * 60 * 1000,
      );
      await assert.rejects(
        repository.authenticatePassword(
          user.username,
          MEMBER_CREDENTIAL,
          null,
          expires,
        ),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "temporary_password_expired",
      );
      await repository.setPassword(user.id, SECOND_ADMIN_CREDENTIAL);
      await repository.authenticatePassword(
        user.username,
        SECOND_ADMIN_CREDENTIAL,
        null,
        new Date(expires.getTime() + 1),
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a temporary password that expires after authentication but before session commit", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-temporary-session-boundary-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      const user = await repository.createUser({
        username: "temporary.boundary",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const expires = Date.parse(user.temporaryPasswordExpiresAt!);
      const verified = await repository.authenticatePassword(
        user.username,
        MEMBER_CREDENTIAL,
        null,
        new Date(expires - 1),
      );

      await assert.rejects(
        repository.createSession(verified, new Date(expires)),
        (error) =>
          error instanceof AppError &&
          error.code === "temporary_password_expired",
      );

      const inspection = createClient({ url: databaseUrl, intMode: "number" });
      try {
        const sessions = await inspection.execute({
          sql: "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?",
          args: [user.id],
        });
        assert.equal(Number(sessions.rows[0]?.count), 0);
      } finally {
        inspection.close();
      }
      assert.equal(
        (await repository.getUser(user.id))?.temporaryPasswordExpiresAt,
        user.temporaryPasswordExpiresAt,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("consumes temporary expiry only with the committed password session", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-temporary-session-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const user = await repository.createUser({
        username: "temporary.used",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const expires = Date.parse(user.temporaryPasswordExpiresAt!);
      const beforeExpiry = new Date(expires - 60_000);
      const verified = await repository.authenticatePassword(
        user.username,
        MEMBER_CREDENTIAL,
        null,
        beforeExpiry,
      );
      await repository.createSession(verified, beforeExpiry);

      const afterDeadline = new Date(expires + 1);
      const reused = await repository.authenticatePassword(
        user.username,
        MEMBER_CREDENTIAL,
        null,
        afterDeadline,
      );
      assert.equal(reused.user.id, user.id);
      assert.equal(
        (await repository.getUser(user.id))?.temporaryPasswordExpiresAt,
        null,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not consume temporary expiry when password-session commit is lost", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-temporary-session-loss-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
    try {
      const user = await repository.createUser({
        username: "temporary.lost",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      const expires = Date.parse(user.temporaryPasswordExpiresAt!);
      const verified = await repository.authenticatePassword(
        user.username,
        MEMBER_CREDENTIAL,
        null,
        new Date(expires - 60_000),
      );
      await repository.setActive(user.id, false);
      await assert.rejects(
        repository.createSession(verified, new Date(expires - 30_000)),
        (error) =>
          error instanceof AppError && error.code === "invalid_credentials",
      );
      await repository.setActive(user.id, true);
      await assert.rejects(
        repository.authenticatePassword(
          user.username,
          MEMBER_CREDENTIAL,
          null,
          new Date(expires + 1),
        ),
        (error) =>
          error instanceof AppError &&
          error.code === "temporary_password_expired",
      );
      assert.equal(
        (await repository.getUser(user.id))?.temporaryPasswordExpiresAt,
        user.temporaryPasswordExpiresAt,
      );
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates normalized users and protects the last active admin", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fs-auth-test-"));
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    let closed = false;
    try {
      const admin = await repository.bootstrapAdmin({
        username: " First.Admin ",
        password: ADMIN_CREDENTIAL,
      });
      const member = await repository.createUser({
        username: "Member.One",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      assert.equal(admin.username, "first.admin");
      await assert.rejects(
        repository.bootstrapAdmin({
          username: "second.admin",
          password: SECOND_ADMIN_CREDENTIAL,
        }),
        /already initialized/iu,
      );
      assert.equal(member.role, "member");
      assert.notEqual(admin.id, member.id);
      await assert.rejects(
        repository.createUser({
          username: "FIRST.ADMIN",
          password: OTHER_CREDENTIAL,
          role: "member",
        }),
        /already exists/iu,
      );
      await assert.rejects(
        repository.setActive(admin.id, false),
        /last active admin/iu,
      );
      await assert.rejects(
        repository.setRole(admin.id, "member"),
        /last active admin/iu,
      );
      const users = await repository.listUsers();
      assert.deepEqual(
        users.map(({ username, role, active }) => ({ username, role, active })),
        [
          { username: "first.admin", role: "admin", active: true },
          { username: "member.one", role: "member", active: true },
        ],
      );

      const secondAdmin = await repository.createUser({
        username: "second.admin",
        password: SECOND_ADMIN_CREDENTIAL,
        role: "admin",
      });
      const concurrent = await Promise.allSettled([
        repository.setActive(admin.id, false),
        repository.setActive(secondAdmin.id, false),
      ]);
      assert.equal(
        concurrent.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        (await repository.listUsers()).filter(
          (user) => user.role === "admin" && user.active,
        ).length,
        1,
      );

      const authenticated = await repository.authenticatePassword(
        "MEMBER.ONE",
        MEMBER_CREDENTIAL,
        "192.0.2.10",
      );
      assert.equal(authenticated.user.id, member.id);
      await assert.rejects(
        repository.authenticatePassword(
          "missing-user",
          WRONG_CREDENTIAL,
          "192.0.2.11",
        ),
        /invalid username or password/iu,
      );
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await assert.rejects(
          repository.authenticatePassword(
            "member.one",
            WRONG_CREDENTIAL,
            "192.0.2.12",
          ),
          /invalid username or password/iu,
        );
      }
      await repository.authenticatePassword(
        "member.one",
        MEMBER_CREDENTIAL,
        "192.0.2.12",
      );
      await assert.rejects(
        repository.authenticatePassword(
          "member.one",
          WRONG_CREDENTIAL,
          "192.0.2.12",
        ),
        /invalid username or password/iu,
      );

      const session = await repository.createSession(member.id);
      assert.match(session.token, /^[A-Za-z0-9_-]{40,}$/u);
      assert.equal(
        (await repository.resolveSession(session.token))?.id,
        member.id,
      );
      await repository.revokeSession(session.token);
      assert.equal(await repository.resolveSession(session.token), null);

      const apiKey = await repository.createApiKey(member.id, "laptop");
      assert.match(apiKey.secret, /^fsk_[A-Za-z0-9_-]{43}$/u);
      assert.equal(
        (await repository.resolveApiKey(apiKey.secret))?.id,
        member.id,
      );
      assert.equal(
        (await repository.listApiKeys(member.id))[0]?.name,
        "laptop",
      );

      await repository.revokeApiKey(apiKey.id, member.id, false);
      assert.equal(await repository.resolveApiKey(apiKey.secret), null);

      await repository.setActive(member.id, false);
      const disabledSession = await repository.createSession(member.id);
      assert.equal(
        await repository.resolveSession(disabledSession.token),
        null,
      );
      await assert.rejects(
        repository.createApiKey(member.id, "disabled"),
        (error) =>
          error instanceof AppError &&
          error.status === 404 &&
          error.code === "user_not_found",
      );

      await repository.close();
      closed = true;
      const inspection = createClient({ url: databaseUrl, intMode: "number" });
      try {
        const snapshot = JSON.stringify({
          users: (await inspection.execute("SELECT * FROM users")).rows,
          sessions: (await inspection.execute("SELECT * FROM sessions")).rows,
          apiKeys: (await inspection.execute("SELECT * FROM api_keys")).rows,
        });
        for (const credential of [
          HASH_CREDENTIAL,
          WRONG_CREDENTIAL,
          ADMIN_CREDENTIAL,
          MEMBER_CREDENTIAL,
          SECOND_ADMIN_CREDENTIAL,
          OTHER_CREDENTIAL,
        ]) {
          assert.doesNotMatch(snapshot, new RegExp(credential, "u"));
        }
        assert.doesNotMatch(snapshot, new RegExp(apiKey.secret, "u"));
        assert.doesNotMatch(snapshot, new RegExp(session.token, "u"));
        assert.match(snapshot, /\$2[aby]\$12\$/u);
        assert.match(snapshot, /key_digest/iu);
        assert.match(snapshot, /token_digest/iu);
      } finally {
        inspection.close();
      }
    } finally {
      if (!closed) await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
