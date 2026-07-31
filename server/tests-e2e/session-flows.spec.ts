import { expect, test } from "@playwright/test";

import {
  ADMIN,
  createApiKeyFor,
  ensureUser,
  nextAddress,
  signInContext,
  uploadFile,
} from "./helpers";

test("a failed logout keeps the session, shows an error, and a retry signs out", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/account");
  await expect(page.getByText(ADMIN.username, { exact: true })).toBeVisible();

  // Sever the logout endpoint only.
  await page.route("**/api/auth/logout", (route) => route.abort());
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByText(/couldn't sign out — you are still signed in/i),
  ).toBeVisible();
  // Never claims signed out; the session is genuinely still alive.
  await page.reload();
  await expect(page.getByText(/signed in as/)).toBeVisible();

  // Restore the network and retry — true success this time.
  await page.unroute("**/api/auth/logout");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a 401 during a streamed upload routes through session reauth without bearer wording", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/files");
  await page.route(
    (url) => url.pathname === "/api/files" && url.searchParams.has("name"),
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "unauthorized",
                message: "A valid bearer token is required",
              },
            }),
          })
        : route.continue(),
  );
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByLabel("File", { exact: true }).setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic"),
  });
  await page.getByRole("button", { name: "Upload file" }).click();
  // Shared session-expiry flow: lands on the login page with the expired
  // notice, and never shows bearer-token API wording.
  await page.waitForURL(/\/login\?.*expired=1/);
  await expect(
    page.getByText("Session expired — sign in again to continue."),
  ).toBeVisible();
  await expect(page.getByText(/bearer token/i)).toHaveCount(0);
});

test("cross-tab identity replacement removes admin-only rendering", async ({
  context,
  page,
  baseURL,
}) => {
  const driftAdmin = await ensureUser(baseURL!, "drift-admin", "admin");
  await signInContext(
    context,
    baseURL!,
    driftAdmin.username,
    driftAdmin.password,
  );
  await page.goto("/files");
  await expect(page.getByRole("link", { name: "Users" })).toBeVisible();

  // Demote out of band (another tab / another admin).
  const api = await (await import("./helpers")).apiContext(baseURL!);
  const demote = await api.patch(`/api/users/${driftAdmin.id}`, {
    data: { role: "member" },
    headers: {
      authorization: `Bearer ${"e2e-synthetic-service-token"}`,
    },
  });
  expect(demote.status()).toBe(200);
  await api.dispose();

  // A cross-tab session-marker write triggers an identity refresh.
  await page.evaluate(() => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: "fs.session-active", newValue: "1" }),
    );
  });
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  await expect(page.getByText("drift-admin · member")).toBeVisible();

  // Restore the fixture for other tests.
  const restore = await (await import("./helpers")).apiContext(baseURL!);
  await restore.patch(`/api/users/${driftAdmin.id}`, {
    data: { role: "admin" },
    headers: { authorization: `Bearer ${"e2e-synthetic-service-token"}` },
  });
  await restore.dispose();
});

test("a stale slow list response never overwrites a newer filter", async ({
  context,
  page,
  baseURL,
}) => {
  const raceOwner = await ensureUser(baseURL!, "race-owner", "member");
  const bearer = await createApiKeyFor(baseURL!, raceOwner.id, "race-key");
  await uploadFile(baseURL!, bearer, "race-public.txt", "public");
  await uploadFile(baseURL!, bearer, "race-private.txt", "private");
  await signInContext(
    context,
    baseURL!,
    raceOwner.username,
    raceOwner.password,
  );

  let releaseStale: (() => void) | null = null;
  const stale = new Promise<void>((resolve) => {
    releaseStale = () => resolve();
  });
  let held = false;
  await page.route("**/api/files?*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.get("visibility") && !held) {
      held = true;
      await stale;
    }
    await route.continue();
  });

  await page.goto("/files");
  // The initial unfiltered load is held. Choose Private, which completes
  // first.
  await page.getByRole("button", { name: "Private" }).click();
  await expect(
    page.getByRole("button", { name: /race-private\.txt/ }),
  ).toBeVisible();
  // Release the stale response; it must be discarded.
  releaseStale!();
  await page.waitForTimeout(500);
  await expect(
    page.getByRole("button", { name: /race-public\.txt/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Private", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("a busy delete dialog resists Escape until the real request completes", async ({
  context,
  page,
  baseURL,
}) => {
  const busyOwner = await ensureUser(baseURL!, "busy-owner", "member");
  const bearer = await createApiKeyFor(baseURL!, busyOwner.id, "busy-key");
  await uploadFile(baseURL!, bearer, "busy-delete.txt", "private");
  await signInContext(
    context,
    baseURL!,
    busyOwner.username,
    busyOwner.password,
  );
  await page.goto("/files");

  // Delay the real DELETE by one second — no mocking of the outcome.
  await page.route("**/api/files/*", async (route) => {
    if (route.request().method() === "DELETE") {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    await route.continue();
  });

  await page.getByRole("button", { name: /busy-delete\.txt/ }).click();
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Delete file" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
  // The committed mutation completes and only then does the surface close.
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5000 });
  await expect(
    page.getByRole("button", { name: /busy-delete\.txt/ }),
  ).toHaveCount(0);
});

test("password change routes to the truthful changed state and the new password works", async ({
  context,
  page,
  baseURL,
}) => {
  const changer = await ensureUser(baseURL!, "pwchange-member", "member");
  await signInContext(context, baseURL!, changer.username, changer.password);
  await page.goto("/account");
  const newPassword = "rotated-fixture-password-12+";
  await page.getByLabel("Current password").fill(changer.password);
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Change password" }).click();

  await page.waitForURL(/\/login\?changed=1/);
  await expect(
    page.getByText("Password changed — sign in again with your new password."),
  ).toBeVisible();
  await expect(page.getByText(/session expired/i)).toHaveCount(0);

  // Re-authenticate with the new password and return to the account task.
  const address = nextAddress();
  await page.route("**/api/auth/login", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-real-ip": address },
    }),
  );
  await page.getByLabel("Username").fill(changer.username);
  await page.getByLabel("Password").fill(newPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/account/);
  await expect(
    page.getByRole("heading", { name: "Change password" }),
  ).toBeVisible();
});

test("restricted storage still renders the expired login form", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const deny = () => {
      throw new DOMException("denied", "SecurityError");
    };
    Storage.prototype.getItem = deny;
    Storage.prototype.setItem = deny;
    Storage.prototype.removeItem = deny;
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${baseURL}/login?expired=1`);
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(
    page.getByText("Session expired — sign in again to continue."),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});
