import { expect, test } from "@playwright/test";

import { type BrowserContext, type Page } from "@playwright/test";

import {
  ADMIN,
  createApiKeyFor,
  ensureUser,
  nextAddress,
  seedAggregateKeys,
  signInContext,
  uploadFile,
  type SeededUser,
} from "./helpers";

/** Resume a task URL in a fresh tab after the session died. Reusing the
 * original page across an auth boundary can stall on sockets left by its
 * aborted in-flight fetches; a returning user opens a new tab anyway. */
async function resumeAfterExpiry(
  context: BrowserContext,
  page: Page,
): Promise<Page> {
  const taskUrl = page.url();
  await page.close();
  await context.clearCookies();
  const resumed = await context.newPage();
  await resumed.goto(taskUrl);
  return resumed;
}

// Reauthenticate through the real login form and land back on the task.
async function relogin(
  page: Page,
  username: string,
  password: string,
  landing: RegExp,
): Promise<void> {
  await page.waitForURL(/\/login\?.*expired=1/);
  // A unique synthetic address keeps the backend's per-address login
  // throttle from coupling tests. Set as a context header rather than a
  // route interception: intercepting the reauth navigation itself can
  // strand the app's follow-up identity request.
  await page.context().setExtraHTTPHeaders({ "x-real-ip": nextAddress() });
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(landing);
  // The task view only mounts once the identity resolves; without this
  // the assertions race the session fetch.
  await expect(page.getByText("loading session…")).toHaveCount(0);
}

// P3-1 regression: reauthentication must restore the COMPLETE task state
// — current cursor, backward pagination history, and the selected record
// — and stale cursors must degrade safely.

test("expiry on Files page 2 with a selection restores page, history, and selection after reauth", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "restore-owner", "member");
  const bearer = await createApiKeyFor(baseURL!, owner.id, "restore-key");
  // 52 owned files → Mine spans two pages of 50.
  for (let index = 0; index < 52; index += 1) {
    await uploadFile(baseURL!, bearer, `restore-${index}.txt`, "private");
  }
  await signInContext(context, baseURL!, owner.username, owner.password);
  await page.goto("/files");
  await expect(page.getByRole("button", { name: "next →" })).toBeEnabled();

  // Page 2, then select a record.
  await page.getByRole("button", { name: "next →" }).click();
  await expect(page.getByRole("button", { name: "← prev" })).toBeEnabled();
  const rowButton = page.locator("tbody .row-open").first();
  const selectedName = (await rowButton.innerText()).split("\n")[0]!.trim();
  await rowButton.click();
  await expect(
    page.getByRole("heading", { name: new RegExp(selectedName) }),
  ).toBeVisible();
  await expect(page).toHaveURL(/cursor=/);
  await expect(page).toHaveURL(/prev=/);
  await expect(page).toHaveURL(/sel=/);

  // The session dies out of band; the reload routes through reauth with
  // the task URL preserved.
  await context.clearCookies();
  await page.reload();
  await page.waitForURL(/\/login\?.*expired=1/);

  // Reauthenticate through the real form.
  await page.context().setExtraHTTPHeaders({ "x-real-ip": nextAddress() });
  await page.getByLabel("Username").fill(owner.username);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/files\?/);

  // Complete restoration: same page (cursor), selection, and a working
  // backward history.
  await expect(
    page.getByRole("heading", { name: new RegExp(selectedName) }),
  ).toBeVisible();
  const prev = page.getByRole("button", { name: "← prev" });
  await expect(prev).toBeEnabled();
  await prev.click();
  await expect(page.getByRole("button", { name: "← prev" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "next →" })).toBeEnabled();
});

test("expiry on Keys page 2 with a selected key restores page, history, and the confirm dialog", async ({
  context,
  page,
  baseURL,
}) => {
  await seedAggregateKeys(baseURL!);
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/keys");
  await expect(page.getByRole("button", { name: "next →" })).toBeEnabled();
  await page.getByRole("button", { name: "next →" }).click();
  await expect(page.getByRole("button", { name: "← prev" })).toBeEnabled();

  // Select a key on page 2: its revoke confirmation is the selection.
  await page
    .getByRole("button", { name: /^Revoke / })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: /^Revoke / });
  await expect(dialog).toBeVisible();
  const dialogName = /Revoke (.+)\?/.exec(await dialog.innerText())?.[1];
  expect(dialogName).toBeTruthy();
  await expect(page).toHaveURL(/cursor=/);
  await expect(page).toHaveURL(/sel=/);
  await expect(page).toHaveURL(/prev=/);

  // Session dies out of band; the task URL survives reauth.
  const resumed = await resumeAfterExpiry(context, page);
  await relogin(resumed, ADMIN.username, ADMIN.password, /\/keys\?/);

  // Complete restoration: the same confirm dialog for the same key…
  await expect(
    resumed.getByRole("dialog", { name: `Revoke ${dialogName}?` }),
  ).toBeVisible();
  await resumed.getByRole("button", { name: "Cancel", exact: true }).click();
  // …on the same page, with working backward history.
  const prev = resumed.getByRole("button", { name: "← prev" });
  await expect(prev).toBeEnabled();
  await prev.click();
  await expect(resumed.getByRole("button", { name: "← prev" })).toBeDisabled();
  await expect(resumed.getByRole("button", { name: "next →" })).toBeEnabled();
  await resumed.close();
});

test("Keys admin scope and search restore after reauth", async ({
  context,
  page,
  baseURL,
}) => {
  // A dedicated admin keeps this independent of the shared fixture
  // account's active-key cap.
  const admin: SeededUser = await ensureUser(
    baseURL!,
    "scope-restore-admin",
    "admin",
  );
  const ownKeyName = "admin-own-restore-key";
  await createApiKeyFor(baseURL!, admin.id, ownKeyName);
  await signInContext(context, baseURL!, admin.username, admin.password);
  await page.goto("/keys");
  await page.getByRole("button", { name: "Mine" }).click();
  await page.getByLabel(/search key name/i).fill("admin-own-restore");
  await expect(
    page.getByRole("cell", { name: ownKeyName, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/scope=mine/);
  // Wait for the debounced query to reach the URL before the session dies,
  // otherwise the task state under test was never persisted.
  await expect(page).toHaveURL(/q=admin-own-restore/);

  const resumed = await resumeAfterExpiry(context, page);
  await relogin(resumed, admin.username, admin.password, /\/keys\?/);

  await expect(
    resumed.getByRole("group", { name: "Key owner filter" }),
  ).toBeVisible();
  await expect(resumed.getByRole("button", { name: "Mine" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(resumed.getByLabel(/search key name/i)).toHaveValue(
    "admin-own-restore",
  );
  await expect(
    resumed.getByRole("cell", { name: ownKeyName, exact: true }),
  ).toBeVisible();
  await resumed.close();
});

test("an interrupted show-once pending flow reconciles truthfully after reauth", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "pend-restore-owner", "member");
  await signInContext(context, baseURL!, owner.username, owner.password);
  await page.goto("/keys");

  // Activation never completes before the session dies.
  await page.route("**/api/api-keys/*/activate", (route) => route.abort());
  await page.getByRole("button", { name: "New key" }).first().click();
  await page
    .getByLabel(/Name — where will this key live\?/)
    .fill("interrupted-key");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText("SHOWN ONLY ONCE")).toBeVisible();
  await expect(page.getByText(/may not be active/i)).toBeVisible();
  // Only the opaque pending id is in the URL — never secret material.
  await expect(page).toHaveURL(/pend=/);
  expect(page.url()).not.toContain("fsk_");
  // The interruption: the tab is abandoned mid-flow and the session dies.
  // The user comes back to the same task URL in a new tab.
  const resumed = await resumeAfterExpiry(context, page);
  await relogin(resumed, owner.username, owner.password, /\/keys\?/);

  // Truthful reconcile: the secret is NOT recoverable; cancel offered.
  const dialog = resumed.getByRole("dialog", {
    name: "Pending key interrupted-key",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/cannot be shown again/i)).toBeVisible();
  // No show-once secret is re-displayed anywhere.
  await expect(resumed.locator(".secret-value")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel key" }).click();
  await expect(
    resumed.getByRole("cell", { name: "interrupted-key", exact: true }),
  ).toHaveCount(0);
  await resumed.close();
});

test("a stale restored cursor degrades to page 1 without loops or a dead screen", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "restore-stale-owner", "member");
  const bearer = await createApiKeyFor(baseURL!, owner.id, "stale-key");
  await uploadFile(baseURL!, bearer, "stale-solo.txt", "private");
  await signInContext(context, baseURL!, owner.username, owner.password);

  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/files?")) requests.push(request.url());
  });
  await page.goto("/files?cursor=not-a-real-cursor");
  // Degrades to a working first page…
  await expect(
    page.getByRole("button", { name: /stale-solo\.txt/ }),
  ).toBeVisible();
  // …with a bounded number of retries (invalid, then clean), not a loop.
  expect(requests.length).toBeLessThanOrEqual(3);
  await expect(page).not.toHaveURL(/cursor=/);
});
