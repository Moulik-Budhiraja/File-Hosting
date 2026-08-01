import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  ADMIN,
  apiContext,
  ensureUser,
  nextAddress,
  signInContext,
} from "./helpers";

// Fable/Sol P3 regression: ambiguous non-key mutations (user create,
// password reset, role/status changes) must never claim "nothing was
// changed" after a real commit whose response was lost. Each flow below
// lets the REAL request commit, then aborts only the response delivery.

async function rawAuthDatabase(): Promise<string> {
  const dataDir = process.env.E2E_DATA_DIR;
  if (!dataDir) throw new Error("E2E_DATA_DIR is not set");
  return (await readFile(path.join(dataDir, "files.db"))).toString("latin1");
}

async function rawServerLog(): Promise<string> {
  const logPath = process.env.E2E_SERVER_LOG;
  if (!logPath) throw new Error("E2E_SERVER_LOG is not set");
  const log = await readFile(logPath, "utf8");
  expect(log.trim().length).toBeGreaterThan(0);
  return log;
}

test("a committed user create with a lost response reconciles to one user with a usable one-time password", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/users");

  // First create POST: forward to the real server (it commits), then
  // drop the response on the floor. The idempotent retry goes through.
  let dropped = false;
  await page.route("**/api/users", async (route) => {
    if (route.request().method() === "POST" && !dropped) {
      dropped = true;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "New user" }).click();
  const form = page.getByRole("dialog", { name: "New user" });
  await form.getByLabel("Username").fill("ambig-created-user");
  await form.getByRole("button", { name: "Create user" }).click();

  // Truthful completion: the show-once dialog appears with the retained
  // candidate password; no absolute negative claim was shown.
  const dialog = page.getByRole("dialog", {
    name: /User created — ambig-created-user/,
  });
  await expect(dialog).toBeVisible();
  await expect(page.getByText(/nothing was changed/i)).toHaveCount(0);
  const password = (await page.locator(".secret-value").innerText()).trim();
  expect(password.length).toBeGreaterThanOrEqual(12);

  // The password never leaks into the URL.
  expect(page.url()).not.toContain(password);

  await page
    .getByRole("checkbox", { name: /I've shared or stored this password/ })
    .check();
  await dialog.getByRole("button", { name: "Done" }).click();

  // Server truth: exactly one such user, and the shown candidate is the
  // real committed credential.
  const api = await apiContext(baseURL!);
  const listing = await api.get("/api/users", {
    headers: { authorization: "Bearer e2e-synthetic-service-token" },
  });
  const users = (
    (await listing.json()) as { users: Array<{ username: string }> }
  ).users.filter((user) => user.username === "ambig-created-user");
  expect(users).toHaveLength(1);
  const login = await api.post("/api/auth/login", {
    data: { username: "ambig-created-user", password },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(login.status()).toBe(200);
  await api.dispose();

  // The plaintext candidate is nowhere in the raw database — only the
  // bcrypt hash is persisted — and it never reached server output.
  expect(await rawAuthDatabase()).not.toContain(password);
  expect(await rawServerLog()).not.toContain(password);
});

test("a committed password reset with a lost response reconciles and shows the applied candidate", async ({
  context,
  page,
  baseURL,
}) => {
  const target = await ensureUser(baseURL!, "ambig-reset-target", "member");
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/users");

  let dropped = false;
  await page.route("**/api/users/*", async (route) => {
    if (route.request().method() === "PATCH" && !dropped) {
      dropped = true;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });

  const row = page.getByRole("row", { name: /ambig-reset-target/ });
  await row
    .getByRole("button", { name: "Reset password for ambig-reset-target" })
    .click();
  await page
    .getByRole("dialog", { name: /Reset password for ambig-reset-target\?/ })
    .getByRole("button", { name: "Reset password", exact: true })
    .click();

  // The reconciled retry applies nothing further and the ORIGINAL
  // candidate is shown once, truthfully.
  const dialog = page.getByRole("dialog", {
    name: /Password reset — ambig-reset-target/,
  });
  await expect(dialog).toBeVisible();
  await expect(page.getByText(/nothing was changed/i)).toHaveCount(0);
  const password = (await page.locator(".secret-value").innerText()).trim();
  expect(page.url()).not.toContain(password);
  await page
    .getByRole("checkbox", { name: /I've shared or stored this password/ })
    .check();
  await dialog.getByRole("button", { name: "Done" }).click();

  // Server truth: the shown candidate authenticates; the old password is
  // dead; the plaintext never reached the database.
  const api = await apiContext(baseURL!);
  const newLogin = await api.post("/api/auth/login", {
    data: { username: target.username, password },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(newLogin.status()).toBe(200);
  const oldLogin = await api.post("/api/auth/login", {
    data: { username: target.username, password: target.password },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(oldLogin.status()).toBe(401);
  await api.dispose();
  expect(await rawAuthDatabase()).not.toContain(password);
  expect(await rawServerLog()).not.toContain(password);
});

test("a committed status change with a lost response reconciles against the directory; a pre-commit failure says unknown", async ({
  context,
  page,
  baseURL,
}) => {
  const target = await ensureUser(baseURL!, "ambig-status-target", "member");
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/users");

  // Phase 1: pre-commit failure — the PATCH never reaches the server.
  let mode: "abort" | "commit-drop" | "continue" = "abort";
  await page.route("**/api/users/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    if (mode === "abort") {
      await route.abort();
      return;
    }
    if (mode === "commit-drop") {
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });

  const row = page.getByRole("row", { name: /ambig-status-target/ });
  await row
    .getByRole("button", { name: /Disable ambig-status-target/ })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "Disable ambig-status-target?",
  });
  await confirm.getByRole("button", { name: "Disable account" }).click();

  // Truthful unknown outcome with a retry — never "nothing was changed".
  await expect(
    confirm.getByText(/may or may not have been applied/i),
  ).toBeVisible();
  await expect(page.getByText(/nothing was changed/i)).toHaveCount(0);

  // Phase 2: the retry commits but the response is lost. The directory
  // re-fetch confirms the desired state → reconciled success.
  mode = "commit-drop";
  await confirm.getByRole("button", { name: "Disable account" }).click();
  await expect(confirm).toBeHidden();
  await expect(
    page.getByText(/change confirmed after reconnect/i),
  ).toBeVisible();
  await expect(page.getByText(/nothing was changed/i)).toHaveCount(0);

  // Server truth: the account is disabled.
  const api = await apiContext(baseURL!);
  const listing = await api.get("/api/users", {
    headers: { authorization: "Bearer e2e-synthetic-service-token" },
  });
  const user = (
    (await listing.json()) as {
      users: Array<{ id: string; active: boolean }>;
    }
  ).users.find((entry) => entry.id === target.id);
  expect(user?.active).toBe(false);
  // Restore for other tests.
  const restore = await api.patch(`/api/users/${target.id}`, {
    data: { active: true },
    headers: { authorization: "Bearer e2e-synthetic-service-token" },
  });
  expect(restore.status()).toBe(200);
  await api.dispose();
});
