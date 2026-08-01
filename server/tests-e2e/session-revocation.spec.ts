import { expect, test } from "@playwright/test";

import {
  LEGACY_TOKEN,
  apiContext,
  ensureUser,
  nextAddress,
  signInContext,
} from "./helpers";

test("disable revokes the real session cookie permanently across re-enable", async ({
  context,
  page,
  baseURL,
}) => {
  const member = await ensureUser(baseURL!, "disable-session-member", "member");
  await signInContext(context, baseURL!, member.username, member.password);
  await page.goto("/files");

  const before = await context.request.get("/api/auth/me");
  expect(before.status()).toBe(200);

  const admin = await apiContext(baseURL!);
  const disable = await admin.patch(`/api/users/${member.id}`, {
    data: { active: false },
    headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
  });
  expect(disable.status()).toBe(200);

  const whileDisabled = await context.request.get("/api/auth/me");
  expect(whileDisabled.status()).toBe(401);

  const enable = await admin.patch(`/api/users/${member.id}`, {
    data: { active: true },
    headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
  });
  expect(enable.status()).toBe(200);

  // The exact cookie issued before disable remains revoked after re-enable.
  const afterEnable = await context.request.get("/api/auth/me");
  expect(afterEnable.status()).toBe(401);

  // Account access itself is restored only through a fresh authentication.
  const freshLogin = await admin.post("/api/auth/login", {
    data: { username: member.username, password: member.password },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(freshLogin.status()).toBe(200);
  await admin.dispose();
});
