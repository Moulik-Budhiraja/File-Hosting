import { expect, test } from "@playwright/test";

import {
  LEGACY_TOKEN,
  apiContext,
  createApiKeyFor,
  ensureUser,
  uiLogin,
  uploadFile,
} from "./helpers";

// Same-role account replacement: when a different account of the SAME
// role signs in from another tab, every user-scoped surface in the first
// tab — list rows, open details, dialogs, show-once secrets — must be
// discarded with the old identity, not just the role-gated chrome.

test("a same-role member login in tab B clears tab A's private file rows and open detail", async ({
  context,
  page,
  baseURL,
}) => {
  const memberA = await ensureUser(baseURL!, "idswap-member-a", "member");
  const memberB = await ensureUser(baseURL!, "idswap-member-b", "member");
  const bearerA = await createApiKeyFor(baseURL!, memberA.id, "idswap-a-key");
  await uploadFile(baseURL!, bearerA, "idswap-a-private.txt", "private");
  const bearerB = await createApiKeyFor(baseURL!, memberB.id, "idswap-b-key");
  await uploadFile(baseURL!, bearerB, "idswap-b-private.txt", "private");

  // Tab A: member A opens their private file's detail panel.
  await uiLogin(page, memberA.username, memberA.password);
  await page.goto("/files");
  await page
    .getByRole("button", { name: /idswap-a-private\.txt/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: /idswap-a-private\.txt/ }),
  ).toBeVisible();

  // Tab B: a REAL login as a different member — same role, no focus.
  const tabB = await context.newPage();
  await uiLogin(tabB, memberB.username, memberB.password);

  // Tab A adopts B's identity…
  await expect(page.getByText("idswap-member-b · member")).toBeVisible({
    timeout: 10_000,
  });
  // …and retains NOTHING of A's private data: no row, no open detail.
  await expect(page.getByText(/idswap-a-private\.txt/)).toHaveCount(0);
  // The list reloads for the new identity: B's own private file appears.
  await expect(
    page.getByRole("button", { name: /idswap-b-private\.txt/ }).first(),
  ).toBeVisible();
  await tabB.close();
});

test("a same-role member login in tab B discards tab A's open show-once API key secret", async ({
  context,
  page,
  baseURL,
}) => {
  const memberA = await ensureUser(baseURL!, "keyswap-member-a", "member");
  const memberB = await ensureUser(baseURL!, "keyswap-member-b", "member");

  // Tab A: member A creates a key and leaves the show-once secret open.
  await uiLogin(page, memberA.username, memberA.password);
  await page.goto("/keys");
  await page.getByRole("button", { name: "New key" }).first().click();
  await page
    .getByLabel(/Name — where will this key live\?/)
    .fill("keyswap-once");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const secret = (await page.locator(".secret-value").innerText()).trim();
  expect(secret).toMatch(/^fsk_/);

  // Tab B: a REAL login as a different member — same role.
  const tabB = await context.newPage();
  await uiLogin(tabB, memberB.username, memberB.password);

  // Tab A adopts B's identity and the show-once secret is gone with A.
  await expect(page.getByText("keyswap-member-b · member")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(secret)).toHaveCount(0);
  await tabB.close();
});

test("a same-role admin login in tab B discards tab A's open show-once temp password", async ({
  context,
  page,
  baseURL,
}) => {
  const adminA = await ensureUser(baseURL!, "resetswap-admin-a", "admin");
  const adminB = await ensureUser(baseURL!, "resetswap-admin-b", "admin");
  const target = await ensureUser(baseURL!, "resetswap-target", "member");

  // Tab A: admin A resets a member's password; the one-time temporary
  // password dialog is open.
  await uiLogin(page, adminA.username, adminA.password);
  await page.goto("/users");
  await page
    .getByRole("button", { name: new RegExp(target.username) })
    .first()
    .click();
  await page.getByRole("button", { name: "Reset password…" }).click();
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await expect(
    page.getByText(`Password reset — ${target.username}`),
  ).toBeVisible();
  const temp = (await page.locator(".secret-value").innerText()).trim();
  expect(temp.length).toBeGreaterThan(10);

  // Tab B: a REAL login as a different admin — same role.
  const tabB = await context.newPage();
  await uiLogin(tabB, adminB.username, adminB.password);

  // Tab A adopts B's identity; the temp password is discarded unseen.
  await expect(page.getByText("resetswap-admin-b · admin")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(temp)).toHaveCount(0);
  await tabB.close();
});

test("an out-of-band demotion clears privileged file rows, not just the admin nav", async ({
  page,
  baseURL,
}) => {
  const demoted = await ensureUser(baseURL!, "rowswap-demoted-admin", "admin");
  const owner = await ensureUser(baseURL!, "rowswap-private-owner", "member");
  const bearer = await createApiKeyFor(baseURL!, owner.id, "rowswap-owner-key");
  await uploadFile(baseURL!, bearer, "rowswap-owner-private.txt", "private");

  await page.clock.install();
  await uiLogin(page, demoted.username, demoted.password);
  await page.goto("/files");
  // The admin Everyone scope shows the other member's private file.
  await expect(
    page.getByRole("button", { name: /rowswap-owner-private\.txt/ }).first(),
  ).toBeVisible();

  // Demote out of band — no coordinated signal; only the bounded poll.
  const api = await apiContext(baseURL!);
  const demote = await api.patch(`/api/users/${demoted.id}`, {
    data: { role: "member" },
    headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
  });
  expect(demote.status()).toBe(200);
  await api.dispose();

  await page.clock.fastForward(65_000);
  await expect(page.getByText("rowswap-demoted-admin · member")).toBeVisible({
    timeout: 10_000,
  });
  // The rows loaded under admin privilege are gone with the privilege.
  await expect(page.getByText(/rowswap-owner-private\.txt/)).toHaveCount(0);

  // Restore the fixture for reruns.
  const restore = await apiContext(baseURL!);
  await restore.patch(`/api/users/${demoted.id}`, {
    data: { role: "admin" },
    headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
  });
  await restore.dispose();
});
