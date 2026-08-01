import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createClient } from "@libsql/client";

import { loadConfig } from "../files/config";
import { AppError } from "../files/errors";
import {
  AuthRepository,
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

describe("user repository", () => {
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

  it("preserves address-wide throttle history after successful login", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-address-success-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "auth.db")}`;
    const repository = await AuthRepository.create(databaseUrl);
    try {
      await repository.createUser({
        username: "known.account",
        password: MEMBER_CREDENTIAL,
        role: "member",
      });
      await assert.rejects(
        repository.authenticatePassword(
          "unknown.account",
          WRONG_CREDENTIAL,
          "198.51.100.44",
        ),
        /invalid username or password/iu,
      );
      await repository.authenticatePassword(
        "known.account",
        MEMBER_CREDENTIAL,
        "198.51.100.44",
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

  it("rejects connection-local in-memory database URLs", async () => {
    await assert.rejects(
      AuthRepository.create("file::memory:"),
      /connection-local in-memory databases are not supported/iu,
    );
  });

  it("limits varied usernames from the same remote address before bcrypt", async () => {
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
        (error: unknown) =>
          error instanceof AppError && error.code === "login_throttled",
      );
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

  it("atomically limits concurrent password attempts before bcrypt", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-concurrent-throttle-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
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
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains revoked keys across creations and prunes only beyond the retention bounds", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-auth-api-key-retention-bounds-test-"),
    );
    const repository = await AuthRepository.create(
      `file:${path.join(directory, "auth.db")}`,
    );
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

      // Count bound: only the most recent REVOKED_KEY_RETENTION_COUNT
      // revoked records survive the next creation.
      for (let index = 0; index < REVOKED_KEY_RETENTION_COUNT + 5; index += 1) {
        const later = new Date(now.getTime() + (index + 1) * 1000);
        const key = await repository.createApiKey(
          member.id,
          `churn-${index}`,
          later,
        );
        await repository.revokeApiKey(key.id, member.id, false, later);
      }
      await repository.createApiKey(
        member.id,
        "post-churn",
        new Date(now.getTime() + 100_000),
      );
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
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prunes revoked keys older than the retention age on the next creation", async () => {
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

      await repository.createApiKey(member.id, "trigger-prune", now);
      const retained = await repository.listApiKeys(member.id);
      const revokedNames = retained
        .filter((key) => key.revokedAt !== null)
        .map((key) => key.name);
      assert.deepEqual(revokedNames, ["fresh"]);
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
        collected.push(...page.apiKeys);
        if (!page.nextCursor) break;
        cursor = decodeApiKeyCursor(page.nextCursor);
      }
      assert.equal(collected.length, 15);
      assert.equal(new Set(collected.map((key) => key.id)).size, 15);
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

      // The needle sits beyond the first unfiltered page…
      const unfiltered = await repository.listAllApiKeys({ limit: 100 });
      assert.equal(
        unfiltered.apiKeys.some((key) => key.name === "NEEDLE-Laptop"),
        false,
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
      const listed = await repository.listApiKeys(owner.id);
      assert.equal(
        listed.some((key) => key.name === "stale-pending"),
        false,
      );

      // Cancel: revoking a pending key removes the never-active row.
      const fresh = listed.find((key) => key.name === "fresh-pending");
      const freshRow = await repository.listApiKeys(owner.id);
      assert.equal(freshRow.length >= 1 || fresh !== undefined, true);
      const cancelTarget = (await repository.listApiKeys(owner.id)).find(
        (key) => key.name === "fresh-pending",
      )!;
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
      const other = await repository.createUser({
        username: "other.member",
        password: OTHER_CREDENTIAL,
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
      // …pending creation is allowed (it holds no live credential)…
      const pending = await repository.beginApiKeyCreation(
        owner.id,
        "pending-at-cap",
        "req-at-cap",
      );
      assert.equal(pending.status, "pending");
      // …but activation at the cap must fail, leaving the key pending.
      await assert.rejects(
        repository.activateApiKey(pending.id, owner.id, false),
        (error) => error instanceof AppError && error.code === "api_key_limit",
      );
      assert.equal(await repository.resolveApiKey(pending.secret!), null);

      // A different member cannot activate or cancel someone else's key.
      await assert.rejects(
        repository.activateApiKey(pending.id, other.id, false),
        (error) =>
          error instanceof AppError && error.code === "api_key_not_found",
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

      // Retained metadata is bounded: past the retention window the
      // request id no longer replays and duplicates report definitively.
      const later = new Date(
        Date.now() + IDEMPOTENT_OPERATION_RETENTION_MS + 60_000,
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

  it("rebuilds the current unconstrained upgraded schema preserving rows, indexes, and FK behavior", async () => {
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
        // Every row survives with identical metadata.
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
              "up-revoked",
              "active",
              "2026-02-03T00:00:00.000Z",
              null,
              "2026-02-04T00:00:00.000Z",
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
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await assert.rejects(
          repository.authenticatePassword(
            "member.one",
            WRONG_CREDENTIAL,
            "192.0.2.12",
          ),
          /invalid username or password/iu,
        );
      }
      await assert.rejects(
        repository.authenticatePassword(
          "member.one",
          MEMBER_CREDENTIAL,
          "192.0.2.12",
        ),
        /too many login attempts/iu,
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
      const disabledKey = await repository.createApiKey(member.id, "disabled");
      assert.equal(await repository.resolveApiKey(disabledKey.secret), null);

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
