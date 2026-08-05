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
import { POST as activateKey } from "../../app/api/api-keys/[id]/activate/route";
import { POST as changePassword } from "../../app/api/auth/password/route";
import { PATCH as updateUser } from "../../app/api/users/[id]/route";
import {
  GET as listUsers,
  POST as createUser,
} from "../../app/api/users/route";
import { AppError } from "../files/errors";
import { loadConfig } from "../files/config";
import { FileService } from "../files/service";
import {
  assertCsrf,
  cookieValue,
  HTTPS_SESSION_COOKIE,
  HTTP_SESSION_COOKIE,
  jsonObject,
  sessionCookieName,
  sessionCookieValue,
} from "./http";
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
    assert.match(cookie ?? "", /^__Host-fs_session=/u);
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
    assert.match(
      loggedOut.headers.get("set-cookie") ?? "",
      /^__Host-fs_session=;/u,
    );
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

  it("uses non-sliding me probes while ignoring attacker-controlled probe headers", async (t) => {
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
    const cookie = loggedIn.headers.get("set-cookie")!.split(";", 1)[0]!;
    const repository = service.auth as unknown as {
      resolveSession: (
        token: string,
        now?: Date,
        options?: { slide?: boolean },
      ) => Promise<unknown>;
    };
    const original = repository.resolveSession.bind(repository);
    const slides: Array<boolean | undefined> = [];
    repository.resolveSession = async (token, now, options) => {
      slides.push(options?.slide);
      return original(token, now, options);
    };
    t.after(() => {
      repository.resolveSession = original;
    });

    assert.equal(
      (
        await me(
          new Request("https://files.example.test/api/auth/me?probe=1", {
            headers: { cookie },
          }),
        )
      ).status,
      200,
    );
    assert.equal(slides.at(-1), false);

    assert.equal(
      (
        await me(
          new Request("https://files.example.test/api/auth/me", {
            headers: {
              cookie,
              "x-fs-session-probe": "1",
              "x-session-probe": "true",
            },
          }),
        )
      ).status,
      200,
    );
    assert.notEqual(slides.at(-1), false);
  });

  it("throttles varied usernames from one verified ingress address before bcrypt", async (t) => {
    const secret = "route-test-trusted-ingress-secret";
    const previousIngress = service.config.trustedIngress;
    service.config.trustedIngress = {
      ipHeader: "x-fs-client-ip",
      secretHeader: "x-fs-proxy-secret",
      secret,
    };
    const repository = service.auth as unknown as Record<string, unknown>;
    const originalVerify = repository.verifyPasswordForLogin;
    let bcryptCalls = 0;
    repository.verifyPasswordForLogin = async () => {
      bcryptCalls += 1;
      return false;
    };
    t.after(() => {
      service.config.trustedIngress = previousIngress;
      repository.verifyPasswordForLogin = originalVerify;
    });

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await login(
        new Request("https://files.example.test/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://files.example.test",
            "x-fs-client-ip": "198.51.100.61",
            "x-fs-proxy-secret": secret,
          },
          body: JSON.stringify({
            username: `verified-address-${attempt}`,
            password: "a sufficiently long wrong password",
          }),
        }),
      );
      assert.equal(response.status, attempt < 10 ? 401 : 429);
    }
    assert.equal(bcryptCalls, 10);
  });

  it("does not let spoofed or unverified headers select an address bucket", async (t) => {
    const secret = "route-test-trusted-ingress-secret";
    const previousIngress = service.config.trustedIngress;
    service.config.trustedIngress = {
      ipHeader: "x-fs-client-ip",
      secretHeader: "x-fs-proxy-secret",
      secret,
    };
    t.after(() => {
      service.config.trustedIngress = previousIngress;
    });

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await login(
        new Request("https://files.example.test/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://files.example.test",
            forwarded: "for=198.51.100.62",
            "x-forwarded-for": "198.51.100.62",
            "x-real-ip": "198.51.100.62",
            "x-fs-client-ip": "198.51.100.62",
            "x-fs-proxy-secret": attempt % 2 === 0 ? "wrong" : "",
          },
          body: JSON.stringify({
            username: `unverified-address-${attempt}`,
            password: "a sufficiently long wrong password",
          }),
        }),
      );
      assert.equal(response.status, 401);
    }

    const verified = await login(
      new Request("https://files.example.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
          "x-fs-client-ip": "198.51.100.62",
          "x-fs-proxy-secret": secret,
        },
        body: JSON.stringify({
          username: "verified-after-spoofing",
          password: "a sufficiently long wrong password",
        }),
      }),
    );
    assert.equal(verified.status, 401);
  });

  it("fails safe to identity-only throttling for malformed trusted addresses", async (t) => {
    const secret = "route-test-trusted-ingress-secret";
    const previousIngress = service.config.trustedIngress;
    service.config.trustedIngress = {
      ipHeader: "x-fs-client-ip",
      secretHeader: "x-fs-proxy-secret",
      secret,
    };
    t.after(() => {
      service.config.trustedIngress = previousIngress;
    });

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await login(
        new Request("https://files.example.test/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://files.example.test",
            "x-fs-client-ip": "198.51.100.63, 203.0.113.8",
            "x-fs-proxy-secret": secret,
          },
          body: JSON.stringify({
            username: `malformed-address-${attempt}`,
            password: "a sufficiently long wrong password",
          }),
        }),
      );
      assert.equal(response.status, 401);
    }
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
      headers: { cookie: `${HTTPS_SESSION_COOKIE}=%` },
    });
    assert.equal(cookieValue(request, HTTPS_SESSION_COOKIE), null);
  });

  it("fails closed on duplicate session cookies, including malformed duplicates", async () => {
    for (const cookie of [
      `${HTTPS_SESSION_COOKIE}=first; ${HTTPS_SESSION_COOKIE}=second`,
      `${HTTPS_SESSION_COOKIE}=first; ${HTTPS_SESSION_COOKIE}=%`,
    ]) {
      const request = new Request("https://files.example.test/api/auth/me", {
        headers: { cookie },
      });
      assert.equal(cookieValue(request, HTTPS_SESSION_COOKIE), null);
      assert.equal((await me(request)).status, 401);
    }
  });

  it("uses one protocol-aware canonical session cookie and rejects mixed names", () => {
    const canonicalHttps = loadConfig({
      NODE_ENV: "test",
      FS_TOKEN: LEGACY_TOKEN,
      FS_PUBLIC_URL: "HtTpS://FILES.Example.Test:443/",
    }).publicUrl;
    assert.equal(sessionCookieName(canonicalHttps), HTTPS_SESSION_COOKIE);
    assert.equal(
      sessionCookieName("http://localhost:3000"),
      HTTP_SESSION_COOKIE,
    );
    const mixed = new Request("https://files.example.test/api/auth/me", {
      headers: {
        cookie: `${HTTPS_SESSION_COOKIE}=secure-token; ${HTTP_SESSION_COOKIE}=tossed-token`,
      },
    });
    assert.equal(sessionCookieValue(mixed, canonicalHttps), null);
  });

  it("compares CSRF origins against the canonical configured origin", (t) => {
    const previousPublicUrl = service.config.publicUrl;
    service.config.publicUrl = loadConfig({
      NODE_ENV: "test",
      FS_TOKEN: LEGACY_TOKEN,
      FS_PUBLIC_URL: "HtTpS://FILES.Example.Test:443/",
    }).publicUrl;
    t.after(() => {
      service.config.publicUrl = previousPublicUrl;
    });

    assert.doesNotThrow(() =>
      assertCsrf(
        new Request("https://files.example.test/api/auth/logout", {
          headers: { origin: "https://files.example.test" },
        }),
        service,
      ),
    );
    assert.throws(
      () =>
        assertCsrf(
          new Request("https://files.example.test/api/auth/logout", {
            headers: { origin: "https://FILES.example.test:443" },
          }),
          service,
        ),
      (error: unknown) =>
        error instanceof AppError && error.code === "csrf_rejected",
    );
  });

  it("rejects mixed user mutations without partially committing", async () => {
    const target = await service.auth.createUser({
      username: "atomic.patch.member",
      password: "a sufficiently long member password",
      role: "member",
    });
    const response = await updateUser(
      new Request(`https://files.example.test/api/users/${target.id}`, {
        method: "PATCH",
        headers: { ...LEGACY_AUTH, "content-type": "application/json" },
        body: JSON.stringify({ role: "admin", active: false }),
      }),
      routeContext(target.id),
    );
    assert.equal(response.status, 400);
    const unchanged = await service.auth.getUser(target.id);
    assert.equal(unchanged?.role, "member");
    assert.equal(unchanged?.active, true);
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

  it("lets admin and legacy actors revoke disabled-owner keys without weakening privacy", async () => {
    const admin = await service.auth.createUser({
      username: "inactive.key.admin",
      password: "a sufficiently long route admin password",
      role: "admin",
    });
    const adminLogin = await login(
      new Request("https://files.example.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
        },
        body: JSON.stringify({
          username: admin.username,
          password: "a sufficiently long route admin password",
        }),
      }),
    );
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get("set-cookie")!.split(";", 1)[0]!;
    const owner = await service.auth.createUser({
      username: "inactive.key.owner",
      password: "a sufficiently long member password",
      role: "member",
    });
    const pending = await service.auth.beginApiKeyCreation(
      owner.id,
      "before-disable",
      "http-before-disable",
    );
    const active = await service.auth.createApiKey(
      owner.id,
      "active-before-disable",
    );
    const selfRevokeCandidate = await service.auth.createApiKey(
      owner.id,
      "self-revoke-after-disable",
    );
    const outsider = await service.auth.createUser({
      username: "inactive.key.outsider",
      password: "a sufficiently long member password",
      role: "member",
    });
    const outsiderKey = await service.auth.createApiKey(
      outsider.id,
      "outsider",
    );

    const missingRevoke = await revokeKey(
      new Request("https://files.example.test/api/api-keys/missing-key", {
        method: "DELETE",
        headers: LEGACY_AUTH,
      }),
      routeContext("missing-key"),
    );
    const crossOwnerRevoke = await revokeKey(
      new Request(`https://files.example.test/api/api-keys/${pending.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${outsiderKey.secret}` },
      }),
      routeContext(pending.id),
    );
    const missingBody = await missingRevoke.text();
    assert.equal(missingRevoke.status, 404);
    assert.equal(crossOwnerRevoke.status, 404);
    assert.equal(await crossOwnerRevoke.text(), missingBody);

    const disabled = await updateUser(
      new Request(`https://files.example.test/api/users/${owner.id}`, {
        method: "PATCH",
        headers: { ...LEGACY_AUTH, "content-type": "application/json" },
        body: JSON.stringify({ active: false }),
      }),
      routeContext(owner.id),
    );
    assert.equal(disabled.status, 200);

    const disabledOwnerCrossRevoke = await revokeKey(
      new Request(`https://files.example.test/api/api-keys/${pending.id}`, {
        method: "DELETE",
        headers: {
          authorization: ["Bearer", outsiderKey.secret].join(" "),
        },
      }),
      routeContext(pending.id),
    );
    assert.equal(disabledOwnerCrossRevoke.status, 404);
    assert.equal(await disabledOwnerCrossRevoke.text(), missingBody);

    const disabledOwnerRevoke = await revokeKey(
      new Request(
        `https://files.example.test/api/api-keys/${selfRevokeCandidate.id}`,
        {
          method: "DELETE",
          headers: {
            authorization: ["Bearer", selfRevokeCandidate.secret].join(" "),
          },
        },
      ),
      routeContext(selfRevokeCandidate.id),
    );
    assert.equal(disabledOwnerRevoke.status, 401);

    const adminCancel = await revokeKey(
      new Request(`https://files.example.test/api/api-keys/${pending.id}`, {
        method: "DELETE",
        headers: {
          cookie: adminCookie,
          origin: "https://files.example.test",
        },
      }),
      routeContext(pending.id),
    );
    assert.equal(adminCancel.status, 204);
    const legacyRevoke = await revokeKey(
      new Request(`https://files.example.test/api/api-keys/${active.id}`, {
        method: "DELETE",
        headers: LEGACY_AUTH,
      }),
      routeContext(active.id),
    );
    assert.equal(legacyRevoke.status, 204);
    const adminRevoke = await revokeKey(
      new Request(
        `https://files.example.test/api/api-keys/${selfRevokeCandidate.id}`,
        {
          method: "DELETE",
          headers: {
            cookie: adminCookie,
            origin: "https://files.example.test",
          },
        },
      ),
      routeContext(selfRevokeCandidate.id),
    );
    assert.equal(adminRevoke.status, 204);

    const oneStep = await createKey(
      new Request("https://files.example.test/api/api-keys", {
        method: "POST",
        headers: { ...LEGACY_AUTH, "content-type": "application/json" },
        body: JSON.stringify({ name: "planted-active", user_id: owner.id }),
      }),
    );
    assert.equal(oneStep.status, 404);
    assert.equal(
      ((await oneStep.json()) as { error: { code: string } }).error.code,
      "user_not_found",
    );

    const begun = await createKey(
      new Request("https://files.example.test/api/api-keys", {
        method: "POST",
        headers: { ...LEGACY_AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          name: "planted-pending",
          user_id: owner.id,
          request_id: "http-planted-pending",
        }),
      }),
    );
    assert.equal(begun.status, 404);
    assert.equal(
      ((await begun.json()) as { error: { code: string } }).error.code,
      "user_not_found",
    );

    const activated = await activateKey(
      new Request(
        `https://files.example.test/api/api-keys/${pending.id}/activate`,
        { method: "POST", headers: LEGACY_AUTH },
      ),
      routeContext(pending.id),
    );
    assert.equal(activated.status, 404);
    assert.equal(
      ((await activated.json()) as { error: { code: string } }).error.code,
      "api_key_not_found",
    );

    const reenabled = await updateUser(
      new Request(`https://files.example.test/api/users/${owner.id}`, {
        method: "PATCH",
        headers: { ...LEGACY_AUTH, "content-type": "application/json" },
        body: JSON.stringify({ active: true }),
      }),
      routeContext(owner.id),
    );
    assert.equal(reenabled.status, 200);
    assert.equal(await service.auth.resolveApiKey(active.secret!), null);
    assert.equal(
      await service.auth.resolveApiKey(selfRevokeCandidate.secret!),
      null,
    );
    assert.equal(await service.auth.resolveApiKey(pending.secret!), null);
    const keys = await service.auth.listApiKeys(owner.id);
    const names = keys.map((key) => key.name);
    assert.notEqual(keys.find((key) => key.id === active.id)?.revokedAt, null);
    assert.equal(names.includes("before-disable"), false);
    assert.equal(names.includes("planted-active"), false);
    assert.equal(names.includes("planted-pending"), false);
  });

  it("rejects two-phase begin at the active cap without returning a secret", async () => {
    const owner = await service.auth.createUser({
      username: "http.capped.owner",
      password: "a sufficiently long member password",
      role: "member",
    });
    for (let index = 0; index < 10; index += 1) {
      await service.auth.createApiKey(owner.id, `active-${index}`);
    }
    const loginResponse = await login(
      new Request("https://files.example.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
          "x-real-ip": "192.0.2.211",
        },
        body: JSON.stringify({
          username: owner.username,
          password: "a sufficiently long member password",
        }),
      }),
    );
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get("set-cookie")!.split(";")[0]!;
    const response = await createKey(
      new Request("https://files.example.test/api/api-keys", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://files.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "must-not-mint",
          request_id: "http-active-cap",
        }),
      }),
    );
    assert.equal(response.status, 409);
    const body = (await response.json()) as {
      error: { code: string };
      api_key?: { secret?: string };
    };
    assert.equal(body.error.code, "api_key_limit");
    assert.equal(body.api_key, undefined);
    assert.equal(
      (await service.auth.listApiKeys(owner.id)).some(
        (key) => key.name === "must-not-mint",
      ),
      false,
    );
  });

  it("serves the aggregate key listing to admins only, with owner identity", async () => {
    await service.auth.createUser({
      username: "aggregate.member",
      password: "a sufficiently long member password",
      role: "member",
    });
    const adminLogin = await login(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
          "x-real-ip": "192.0.2.201",
        },
        body: JSON.stringify({
          username: "admin",
          password: "a sufficiently long admin password",
        }),
      }),
    );
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get("set-cookie")!.split(";")[0]!;

    const aggregate = await listKeys(
      new Request("http://localhost/api/api-keys?scope=all&limit=100", {
        headers: { cookie: adminCookie },
      }),
    );
    assert.equal(aggregate.status, 200);
    const body = (await aggregate.json()) as {
      api_keys: Array<{ owner_username?: string; user_id: string }>;
      next_cursor: string | null;
    };
    for (const key of body.api_keys) {
      assert.equal(typeof key.owner_username, "string");
    }
    assert.equal(body.next_cursor, null);

    // Members must not reach the aggregate view.
    const memberLogin = await login(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
          "x-real-ip": "192.0.2.202",
        },
        body: JSON.stringify({
          username: "aggregate.member",
          password: "a sufficiently long member password",
        }),
      }),
    );
    assert.equal(memberLogin.status, 200);
    const memberCookie = memberLogin.headers.get("set-cookie")!.split(";")[0]!;
    const denied = await listKeys(
      new Request("http://localhost/api/api-keys?scope=all", {
        headers: { cookie: memberCookie },
      }),
    );
    assert.equal(denied.status, 403);

    // q searches key names and owner usernames server-side (case- and
    // wildcard-safe), still admin-only.
    const noiseOwner = await service.auth.createUser({
      username: "aggregate.noise.owner",
      password: "a sufficiently long member password",
      role: "member",
    });
    await service.auth.createApiKey(noiseOwner.id, "unrelated-key-a");
    await service.auth.createApiKey(noiseOwner.id, "unrelated-key-b");
    const searchOwner = await service.auth.createUser({
      username: "aggregate.q.owner",
      password: "a sufficiently long member password",
      role: "member",
    });
    await service.auth.createApiKey(searchOwner.id, "Route-Needle-Key");
    const searched = await listKeys(
      new Request("http://localhost/api/api-keys?scope=all&q=route-needle", {
        headers: { cookie: adminCookie },
      }),
    );
    assert.equal(searched.status, 200);
    const searchedBody = (await searched.json()) as {
      api_keys: Array<{ name: string; owner_username: string }>;
    };
    assert.deepEqual(
      searchedBody.api_keys.map((key) => key.name),
      ["Route-Needle-Key"],
    );
    const byUsername = await listKeys(
      new Request("http://localhost/api/api-keys?scope=all&q=aggregate.q", {
        headers: { cookie: adminCookie },
      }),
    );
    const byUsernameBody = (await byUsername.json()) as {
      api_keys: Array<{ owner_username: string }>;
    };
    assert.equal(byUsernameBody.api_keys.length, 1);
    assert.equal(
      byUsernameBody.api_keys[0]?.owner_username,
      "aggregate.q.owner",
    );
    const deniedSearch = await listKeys(
      new Request("http://localhost/api/api-keys?scope=all&q=route-needle", {
        headers: { cookie: memberCookie },
      }),
    );
    assert.equal(deniedSearch.status, 403);
  });

  it("runs the two-phase browser key protocol with CSRF and idempotent reconcile", async () => {
    await service.auth.createUser({
      username: "twophase.member",
      password: "a sufficiently long member password",
      role: "member",
    });
    const loginResponse = await login(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
          "x-real-ip": "192.0.2.208",
        },
        body: JSON.stringify({
          username: "twophase.member",
          password: "a sufficiently long member password",
        }),
      }),
    );
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get("set-cookie")!.split(";")[0]!;
    const sessionHeaders = {
      cookie,
      "content-type": "application/json",
      origin: "https://files.example.test",
    };

    // Browser (cookie-session) callers must use the two-phase protocol:
    // a one-step create without request_id is rejected, so a lost browser
    // response can never mint an active unrecoverable credential.
    const oneStep = await createKey(
      new Request("https://files.example.test/api/api-keys", {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ name: "one-step-browser" }),
      }),
    );
    assert.equal(oneStep.status, 400);
    assert.equal(
      ((await oneStep.json()) as { error: { code: string } }).error.code,
      "request_id_required",
    );

    // Phase 1: create a pending key with an idempotency request id.
    const requestId = "11111111-2222-4333-8444-555555555555";
    const createdResponse = await createKey(
      new Request("https://files.example.test/api/api-keys", {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ name: "browser-laptop", request_id: requestId }),
      }),
    );
    assert.equal(createdResponse.status, 201);
    const createdBody = (await createdResponse.json()) as {
      api_key: {
        id: string;
        secret: string | null;
        status: string;
        pending_expires_at: string | null;
        created: boolean;
      };
    };
    assert.equal(createdBody.api_key.status, "pending");
    assert.equal(createdBody.api_key.created, true);
    assert.match(createdBody.api_key.secret!, /^fsk_/u);
    assert.ok(createdBody.api_key.pending_expires_at);

    // A pending key must NEVER authenticate.
    const pendingAuth = await me(
      new Request("https://files.example.test/api/auth/me", {
        headers: { authorization: `Bearer ${createdBody.api_key.secret}` },
      }),
    );
    assert.equal(pendingAuth.status, 401);

    // Retrying the create (lost response) reconciles without the secret.
    const retryResponse = await createKey(
      new Request("https://files.example.test/api/api-keys", {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ name: "browser-laptop", request_id: requestId }),
      }),
    );
    assert.equal(retryResponse.status, 200);
    const retryBody = (await retryResponse.json()) as {
      api_key: {
        id: string;
        secret: string | null;
        status: string;
        created: boolean;
      };
    };
    assert.equal(retryBody.api_key.created, false);
    assert.equal(retryBody.api_key.secret, null);
    assert.equal(retryBody.api_key.id, createdBody.api_key.id);

    // Phase 2 is CSRF-protected for session callers.
    const badOrigin = await activateKey(
      new Request(
        `https://files.example.test/api/api-keys/${createdBody.api_key.id}/activate`,
        {
          method: "POST",
          headers: { cookie, origin: "https://evil.example" },
        },
      ),
      routeContext(createdBody.api_key.id),
    );
    assert.equal(badOrigin.status, 403);

    // Activation succeeds, then reconciles idempotently.
    const activateResponse = await activateKey(
      new Request(
        `https://files.example.test/api/api-keys/${createdBody.api_key.id}/activate`,
        {
          method: "POST",
          headers: sessionHeaders,
        },
      ),
      routeContext(createdBody.api_key.id),
    );
    assert.equal(activateResponse.status, 200);
    const activateAgain = await activateKey(
      new Request(
        `https://files.example.test/api/api-keys/${createdBody.api_key.id}/activate`,
        {
          method: "POST",
          headers: sessionHeaders,
        },
      ),
      routeContext(createdBody.api_key.id),
    );
    assert.equal(activateAgain.status, 200);

    // Now — and only now — the secret is a live credential.
    const activeAuth = await me(
      new Request("https://files.example.test/api/auth/me", {
        headers: { authorization: `Bearer ${createdBody.api_key.secret}` },
      }),
    );
    assert.equal(activeAuth.status, 200);

    // Non-browser bearer callers keep the one-step path (no request_id).
    const bearerOneStep = await createKey(
      new Request("https://files.example.test/api/api-keys", {
        method: "POST",
        headers: {
          authorization: `Bearer ${createdBody.api_key.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "bearer-one-step" }),
      }),
    );
    assert.equal(bearerOneStep.status, 201);
    const bearerBody = (await bearerOneStep.json()) as {
      api_key: { secret: string };
    };
    assert.match(bearerBody.api_key.secret, /^fsk_/u);

    // A second pending key can be cancelled: the row disappears.
    const cancelCreate = await createKey(
      new Request("https://files.example.test/api/api-keys", {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({
          name: "cancel-me",
          request_id: "cancel-req-1",
        }),
      }),
    );
    assert.equal(cancelCreate.status, 201);
    const cancelBody = (await cancelCreate.json()) as {
      api_key: { id: string };
    };
    const cancelled = await revokeKey(
      new Request(
        `https://files.example.test/api/api-keys/${cancelBody.api_key.id}`,
        { method: "DELETE", headers: sessionHeaders },
      ),
      routeContext(cancelBody.api_key.id),
    );
    assert.equal(cancelled.status, 204);
    const listing = await listKeys(
      new Request("https://files.example.test/api/api-keys", {
        headers: { cookie },
      }),
    );
    const listingBody = (await listing.json()) as {
      api_keys: Array<{ name: string; status: string }>;
    };
    assert.equal(
      listingBody.api_keys.some((key) => key.name === "cancel-me"),
      false,
    );
    // The activated key lists as active with its status field.
    assert.equal(
      listingBody.api_keys.find((key) => key.name === "browser-laptop")?.status,
      "active",
    );
  });

  it("honors idempotency request ids on user creation and password reset", async () => {
    const loginResponse = await login(
      new Request("https://files.example.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
          "x-real-ip": "10.77.0.1",
        },
        body: JSON.stringify({
          username: "admin",
          password: "a sufficiently long admin password",
        }),
      }),
    );
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get("set-cookie")!.split(";", 1)[0]!;
    const jsonHeaders = {
      "content-type": "application/json",
      origin: "https://files.example.test",
      cookie,
    };

    // Create with a request id commits once…
    const createBody = {
      username: "idem.http.member",
      password: "idem-http-member-password-1",
      role: "member",
      request_id: "http-req-create-1",
    };
    const created = await createUser(
      new Request("https://files.example.test/api/users", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(createBody),
      }),
    );
    assert.equal(created.status, 201);
    const createdJson = (await created.json()) as {
      user: { id: string; username: string };
      created: boolean;
    };
    assert.equal(createdJson.created, true);

    // …and a retry with the same request id reconciles to the SAME user.
    const retried = await createUser(
      new Request("https://files.example.test/api/users", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(createBody),
      }),
    );
    assert.equal(retried.status, 200);
    const retriedJson = (await retried.json()) as {
      user: { id: string };
      created: boolean;
    };
    assert.equal(retriedJson.created, false);
    assert.equal(retriedJson.user.id, createdJson.user.id);

    // A malformed request id is rejected before any write.
    const badRequestId = await createUser(
      new Request("https://files.example.test/api/users", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ ...createBody, request_id: 7 }),
      }),
    );
    assert.equal(badRequestId.status, 400);

    // Password reset with a request id applies exactly once…
    const resetBody = {
      password: "idem-http-reset-password-1",
      request_id: "http-req-reset-1",
    };
    const reset = await updateUser(
      new Request(
        `https://files.example.test/api/users/${createdJson.user.id}`,
        {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify(resetBody),
        },
      ),
      routeContext(createdJson.user.id),
    );
    assert.equal(reset.status, 200);
    assert.equal(
      ((await reset.json()) as { password_applied: boolean }).password_applied,
      true,
    );
    const resetReplay = await updateUser(
      new Request(
        `https://files.example.test/api/users/${createdJson.user.id}`,
        {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify(resetBody),
        },
      ),
      routeContext(createdJson.user.id),
    );
    assert.equal(resetReplay.status, 200);
    assert.equal(
      ((await resetReplay.json()) as { password_applied: boolean })
        .password_applied,
      false,
    );

    // …and the committed candidate authenticates.
    const memberLogin = await login(
      new Request("https://files.example.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.test",
          "x-real-ip": "10.77.0.2",
        },
        body: JSON.stringify({
          username: "idem.http.member",
          password: "idem-http-reset-password-1",
        }),
      }),
    );
    assert.equal(memberLogin.status, 200);

    // request_id is only meaningful for the password reset patch.
    const requestIdAlone = await updateUser(
      new Request(
        `https://files.example.test/api/users/${createdJson.user.id}`,
        {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify({ request_id: "http-req-lonely" }),
        },
      ),
      routeContext(createdJson.user.id),
    );
    assert.equal(requestIdAlone.status, 400);
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
    const summaryResponse = await listUsers(
      new Request("https://files.example.test/api/users", {
        headers: LEGACY_AUTH,
      }),
    );
    const summaryBody = (await summaryResponse.json()) as {
      users: Array<{
        id: string;
        files_count: number;
        api_keys_count: number;
        sessions_count: number;
        last_active_at: string | null;
      }>;
    };
    const memberSummary = summaryBody.users.find(
      (candidate) => candidate.id === member.user.id,
    );
    assert.equal(memberSummary?.files_count, 0);
    assert.equal(memberSummary?.api_keys_count, 0);
    assert.equal(memberSummary?.sessions_count, 0);

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
    assert.equal(changed.status, 200);
    const rotatedCookie = changed.headers.get("set-cookie")!.split(";", 1)[0]!;
    assert.match(rotatedCookie, /^__Host-fs_session=/u);
    assert.notEqual(rotatedCookie, memberCookie);
    assert.equal(typeof (await changed.json()).expires_at, "string");
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
    assert.equal(
      (
        await me(
          new Request("https://files.example.test/api/auth/me", {
            headers: { cookie: rotatedCookie },
          }),
        )
      ).status,
      200,
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
