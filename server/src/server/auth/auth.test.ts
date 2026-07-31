import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createClient } from "@libsql/client";

import { loadConfig } from "../files/config";
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
      assert.equal(authenticated.id, member.id);
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
