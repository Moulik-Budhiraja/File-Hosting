import { expect, test } from "@playwright/test";

import {
  ADMIN,
  createApiKeyFor,
  ensureUser,
  signInContext,
  uiLogin,
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
  await expect(page.getByText(ADMIN.username, { exact: true })).toBeVisible();

  // Restore the network and retry — true success this time.
  await page.unroute("**/api/auth/logout");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("the session panel shows the enforced idle and absolute bounds", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  const me = await context.request.get(`${baseURL}/api/auth/me`);
  expect(me.status()).toBe(200);
  const contract = (await me.json()) as {
    session: { created_at: string; expires_at: string };
  };
  expect(
    Date.parse(contract.session.expires_at) -
      Date.parse(contract.session.created_at),
  ).toBe(7 * 24 * 60 * 60 * 1000);

  await page.goto("/account");
  await expect(
    page.getByText("12 h idle · 7 d max", { exact: true }),
  ).toBeVisible();
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
  await expect(page.getByText("Session expired.")).toBeVisible();
  await expect(page.getByText(/bearer token/i)).toHaveCount(0);
});

test("a real different-account login in tab B replaces tab A's identity without focus or injection", async ({
  context,
  page,
  baseURL,
}) => {
  const tabAdmin = await ensureUser(baseURL!, "twotab-admin", "admin");
  const tabMember = await ensureUser(baseURL!, "twotab-member", "member");

  // Tab A: a real login through the real form, then the admin console.
  await uiLogin(page, tabAdmin.username, tabAdmin.password);
  await page.goto("/files");
  await expect(page.getByRole("link", { name: "Users" })).toBeVisible();

  // Track whether tab A keeps issuing admin fetches after the switch.
  const adminRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/users") {
      adminRequests.push(request.url());
    }
  });

  // Tab B: the same browser performs a REAL login as a different account.
  // No storage events are dispatched manually and tab A is never focused.
  const tabB = await context.newPage();
  await uiLogin(tabB, tabMember.username, tabMember.password);

  // Tab A must drop the admin shell on the published session change alone.
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByText("twotab-member · member")).toBeVisible();

  // And no further admin fetches fire from tab A.
  const requestsAtFlip = adminRequests.length;
  await page.waitForTimeout(1000);
  expect(adminRequests.length).toBe(requestsAtFlip);
  await tabB.close();
});

test("a real admin→member demotion reaches an unfocused tab via bounded polling", async ({
  page,
  baseURL,
}) => {
  const demoted = await ensureUser(baseURL!, "poll-demoted-admin", "admin");
  // Install a controllable clock BEFORE the app loads so the low-frequency
  // poll can be advanced without focus, storage, or broadcast events.
  await page.clock.install();
  await uiLogin(page, demoted.username, demoted.password);
  await page.goto("/files");
  await expect(page.getByRole("link", { name: "Users" })).toBeVisible();

  // Demote out of band — no coordinated app flow publishes any signal.
  const api = await (await import("./helpers")).apiContext(baseURL!);
  const demote = await api.patch(`/api/users/${demoted.id}`, {
    data: { role: "member" },
    headers: { authorization: `Bearer ${"e2e-synthetic-service-token"}` },
  });
  expect(demote.status()).toBe(200);
  await api.dispose();

  // One poll interval later the stale admin shell is gone.
  await page.clock.fastForward(65_000);
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByText("poll-demoted-admin · member")).toBeVisible();

  // Restore the fixture for reruns.
  const restore = await (await import("./helpers")).apiContext(baseURL!);
  await restore.patch(`/api/users/${demoted.id}`, {
    data: { role: "admin" },
    headers: { authorization: `Bearer ${"e2e-synthetic-service-token"}` },
  });
  await restore.dispose();
});

test("a failed background identity refresh keeps the UI with a stale notice instead of a fallback", async ({
  page,
  baseURL,
}) => {
  const staleMember = await ensureUser(baseURL!, "stale-member", "member");
  await page.clock.install();
  await uiLogin(page, staleMember.username, staleMember.password);
  await page.goto("/files");
  await expect(page.getByText("stale-member · member")).toBeVisible();

  // Break only the identity endpoint, then force a background poll.
  await page.route("**/api/auth/me?*", (route) => route.abort());
  await page.clock.fastForward(65_000);

  await expect(page.getByText(/couldn't be refreshed/i)).toBeVisible({
    timeout: 10_000,
  });
  // The working UI is retained — no full-page fallback.
  await expect(page.getByText("stale-member · member")).toBeVisible();
  await expect(page.getByText(/couldn't load your session/i)).toHaveCount(0);

  // Retry restores a clean state.
  await page.unroute("**/api/auth/me?*");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(/couldn't be refreshed/i)).toHaveCount(0);
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

test("password change rotates the current session, revokes the others, and accepts the new password", async ({
  browser,
  context,
  page,
  baseURL,
}) => {
  const changer = await ensureUser(baseURL!, "pwchange-member", "member");
  await signInContext(context, baseURL!, changer.username, changer.password);
  const otherContext = await browser.newContext();
  const newContext = await browser.newContext();
  try {
    await signInContext(
      otherContext,
      baseURL!,
      changer.username,
      changer.password,
    );
    await page.goto("/account");
    const newPassword = "rotated-fixture-password-12+";
    await page.getByLabel("Current password").fill(changer.password);
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm new password").fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(
      page.getByText("Password changed. Other sessions were signed out."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/account/);
    expect((await context.request.get(`${baseURL}/api/auth/me`)).status()).toBe(
      200,
    );
    expect(
      (await otherContext.request.get(`${baseURL}/api/auth/me`)).status(),
    ).toBe(401);

    await signInContext(newContext, baseURL!, changer.username, newPassword);
    expect(
      (await newContext.request.get(`${baseURL}/api/auth/me`)).status(),
    ).toBe(200);
  } finally {
    await otherContext.close();
    await newContext.close();
  }
});

test("restricted storage and a missing BroadcastChannel degrade without breaking login", async ({
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
    // Some environments ship no BroadcastChannel at all.
    (window as unknown as Record<string, unknown>).BroadcastChannel = undefined;
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${baseURL}/login?expired=1`);
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByText("Session expired.")).toBeVisible();

  // A full real login still works: the session-change publish degrades
  // silently instead of crashing the success path.
  await uiLogin(page, ADMIN.username, ADMIN.password);
  await page.goto(`${baseURL}/files`);
  await expect(page.getByText(`${ADMIN.username} · admin`)).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});
