import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createClient } from "@libsql/client";

import { loadConfig } from "../files/config";
import { AppError } from "../files/errors";
import { AuthRepository } from "./database";
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
      for (let attempt = 0; attempt < 5; attempt += 1) {
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

  it("caps active API keys and purges revoked history", async () => {
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
      assert.equal(retained.length, 10);
      assert.equal(
        retained.every((key) => key.revokedAt === null),
        true,
      );
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
