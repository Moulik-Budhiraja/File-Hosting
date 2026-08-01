import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { POST as login } from "../../app/api/auth/login/route";
import { POST as logout } from "../../app/api/auth/logout/route";
import { GET as me } from "../../app/api/auth/me/route";
import {
  GET as listKeys,
  POST as createKey,
} from "../../app/api/api-keys/route";
import { DELETE as revokeKey } from "../../app/api/api-keys/[id]/route";
import { POST as changePassword } from "../../app/api/auth/password/route";
import { PATCH as updateUser } from "../../app/api/users/[id]/route";
import {
  GET as listUsers,
  POST as createUser,
} from "../../app/api/users/route";
import { AppError } from "../files/errors";
import { FileService } from "../files/service";
import { cookieValue, jsonObject, SESSION_COOKIE } from "./http";
import { setFileServiceForTests } from "../files/singleton";

const LEGACY_TOKEN = "legacy-admin-service-token";
const LEGACY_AUTH = { authorization: `Bearer ${LEGACY_TOKEN}` };

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("authentication HTTP routes", { concurrency: false }, () => {
  let directory: string;
  let service: FileService;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fs-auth-http-test-"));
    service = await FileService.create({
      token: LEGACY_TOKEN,
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: path.join(directory, "objects"),
      publicUrl: "https://files.example.test",
      maxUploadBytes: 1024,
      minFreeBytes: 0,
    });
    setFileServiceForTests(service);
    await service.auth.createUser({
      username: "admin",
      password: "a sufficiently long admin password",
      role: "admin",
    });
  });

  after(async () => {
    setFileServiceForTests(null);
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("logs in without enumeration, exposes current user, enforces CSRF, and logs out", async () => {
    const failed = await login(
      new Request("https://files.example.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
        },
        body: JSON.stringify({
          username: "missing",
          password: "a sufficiently long wrong password",
        }),
      }),
    );
    assert.equal(failed.status, 401);
    assert.equal(
      ((await failed.json()) as { error: { code: string } }).error.code,
      "invalid_credentials",
    );

    const response = await login(
      new Request("https://files.example.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
        },
        body: JSON.stringify({
          username: "ADMIN",
          password: "a sufficiently long admin password",
        }),
      }),
    );
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie ?? "", /^fs_session=/u);
    assert.match(cookie ?? "", /HttpOnly/iu);
    assert.match(cookie ?? "", /Secure/iu);
    assert.match(cookie ?? "", /SameSite=Strict/iu);
    const cookieHeader = cookie!.split(";", 1)[0]!;

    const current = await me(
      new Request("https://files.example.test/api/auth/me", {
        headers: { cookie: cookieHeader },
      }),
    );
    assert.equal(current.status, 200);
    assert.equal(
      ((await current.json()) as { user: { username: string } }).user.username,
      "admin",
    );

    const csrfRejected = await logout(
      new Request("https://files.example.test/api/auth/logout", {
        method: "POST",
        headers: { cookie: cookieHeader, origin: "https://evil.example" },
      }),
    );
    assert.equal(csrfRejected.status, 403);
    const loggedOut = await logout(
      new Request("https://files.example.test/api/auth/logout", {
        method: "POST",
        headers: { cookie: cookieHeader, origin: "https://files.example.test" },
      }),
    );
    assert.equal(loggedOut.status, 204);
    assert.equal(
      (
        await me(
          new Request("https://files.example.test/api/auth/me", {
            headers: { cookie: cookieHeader },
          }),
        )
      ).status,
      401,
    );
  });

  it("does not mark an HTTP public URL session cookie Secure in production", async (t) => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousPublicUrl = service.config.publicUrl;
    Reflect.set(process.env, "NODE_ENV", "production");
    service.config.publicUrl = "http://localhost:3000";
    t.after(() => {
      if (previousNodeEnv === undefined)
        Reflect.deleteProperty(process.env, "NODE_ENV");
      else Reflect.set(process.env, "NODE_ENV", previousNodeEnv);
      service.config.publicUrl = previousPublicUrl;
    });

    const response = await login(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          username: "admin",
          password: "a sufficiently long admin password",
        }),
      }),
    );

    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^fs_session=/u);
    assert.doesNotMatch(cookie, /(?:^|;\s*)Secure(?:;|$)/iu);
  });

  it("rejects oversized JSON bodies before parsing", async () => {
    const request = new Request("https://files.example.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(65_536) }),
    });
    await assert.rejects(
      jsonObject(request),
      (error: unknown) => error instanceof AppError && error.status === 413,
    );
  });

  it("does not mark an HTTP public URL logout cookie Secure in production", async (t) => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalPublicUrl = service.config.publicUrl;
    t.after(() => {
      if (originalNodeEnv === undefined)
        Reflect.deleteProperty(process.env, "NODE_ENV");
      else Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
      service.config.publicUrl = originalPublicUrl;
    });
    Reflect.set(process.env, "NODE_ENV", "production");
    service.config.publicUrl = "http://localhost:3000";

    const loggedIn = await login(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          username: "admin",
          password: "a sufficiently long admin password",
        }),
      }),
    );
    assert.equal(loggedIn.status, 200, await loggedIn.clone().text());
    const sessionCookie = loggedIn.headers.get("set-cookie")!.split(";", 1)[0]!;
    const response = await logout(
      new Request("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: { cookie: sessionCookie, origin: "http://localhost:3000" },
      }),
    );

    assert.equal(response.status, 204);
    assert.doesNotMatch(
      response.headers.get("set-cookie") ?? "",
      /(?:^|;\s*)Secure(?:;|$)/iu,
    );
  });

  it("clears a stale revoked session cookie idempotently", async () => {
    const loggedIn = await login(
      new Request("https://files.example.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
        },
        body: JSON.stringify({
          username: "admin",
          password: "a sufficiently long admin password",
        }),
      }),
    );
    const sessionCookie = loggedIn.headers.get("set-cookie")!.split(";", 1)[0]!;
    await service.auth.revokeSession(
      decodeURIComponent(sessionCookie.split("=")[1]!),
    );

    const response = await logout(
      new Request("https://files.example.test/api/auth/logout", {
        method: "POST",
        headers: {
          cookie: sessionCookie,
          origin: "https://files.example.test",
        },
      }),
    );

    assert.equal(response.status, 204);
    assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/iu);
  });

  it("ignores malformed percent encoding in session cookies", () => {
    const request = new Request("https://files.example.test/raw/example", {
      headers: { cookie: `${SESSION_COOKIE}=%` },
    });
    assert.equal(cookieValue(request, SESSION_COOKIE), null);
  });

  it("returns 404 when an administrator targets a missing API-key owner", async () => {
    const response = await createKey(
      new Request("https://files.example.test/api/api-keys", {
        method: "POST",
        headers: { ...LEGACY_AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          name: "orphaned",
          user_id: "missing-user-id",
        }),
      }),
    );

    assert.equal(response.status, 404);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "user_not_found",
    );
  });

  it("uses legacy bearer as admin and returns API key secrets only once", async (t) => {
    const logged: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => logged.push(values);
    t.after(() => {
      console.error = originalConsoleError;
    });

    const created = await createUser(
      new Request("https://files.example.test/api/users", {
        method: "POST",
        headers: { ...LEGACY_AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          username: "member",
          password: "a sufficiently long member password",
          role: "member",
        }),
      }),
    );
    assert.equal(created.status, 201);
    const member = (await created.json()) as { user: { id: string } };
    assert.equal(
      (
        await listUsers(
          new Request("https://files.example.test/api/users", {
            headers: LEGACY_AUTH,
          }),
        )
      ).status,
      200,
    );

    const key = await createKey(
      new Request("https://files.example.test/api/api-keys", {
        method: "POST",
        headers: { ...LEGACY_AUTH, "content-type": "application/json" },
        body: JSON.stringify({ name: "automation", user_id: member.user.id }),
      }),
    );
    assert.equal(key.status, 201);
    const keyBody = (await key.json()) as {
      api_key: { id: string; secret: string };
    };
    const secret = keyBody.api_key.secret;
    assert.match(secret, /^fsk_/u);
    const listed = await listKeys(
      new Request(
        `https://files.example.test/api/api-keys?user_id=${member.user.id}`,
        { headers: LEGACY_AUTH },
      ),
    );
    assert.equal(listed.status, 200);
    assert.doesNotMatch(
      await listed.text(),
      new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );

    const memberLogin = await login(
      new Request("https://files.example.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
        },
        body: JSON.stringify({
          username: "member",
          password: "a sufficiently long member password",
        }),
      }),
    );
    const memberCookie = memberLogin.headers
      .get("set-cookie")!
      .split(";", 1)[0]!;
    assert.equal(
      (
        await listUsers(
          new Request("https://files.example.test/api/users", {
            headers: { cookie: memberCookie },
          }),
        )
      ).status,
      403,
    );
    const changed = await changePassword(
      new Request("https://files.example.test/api/auth/password", {
        method: "POST",
        headers: {
          cookie: memberCookie,
          origin: "https://files.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          current_password: "a sufficiently long member password",
          new_password: "a different sufficiently long member password",
        }),
      }),
    );
    assert.equal(changed.status, 204);
    assert.equal(
      (
        await me(
          new Request("https://files.example.test/api/auth/me", {
            headers: { cookie: memberCookie },
          }),
        )
      ).status,
      401,
    );

    const reset = await updateUser(
      new Request(`https://files.example.test/api/users/${member.user.id}`, {
        method: "PATCH",
        headers: { ...LEGACY_AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          password: "an admin supplied replacement password",
        }),
      }),
      routeContext(member.user.id),
    );
    assert.equal(reset.status, 200);

    const revoked = await revokeKey(
      new Request(
        `https://files.example.test/api/api-keys/${keyBody.api_key.id}`,
        {
          method: "DELETE",
          headers: LEGACY_AUTH,
        },
      ),
      routeContext(keyBody.api_key.id),
    );
    assert.equal(revoked.status, 204);
    assert.equal(await service.auth.resolveApiKey(secret), null);
    const logSnapshot = JSON.stringify(logged);
    assert.doesNotMatch(logSnapshot, /sufficiently long member password/iu);
    assert.doesNotMatch(
      logSnapshot,
      new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
    assert.deepEqual(logged, []);
  });
});
