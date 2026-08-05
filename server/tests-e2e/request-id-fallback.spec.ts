import { expect, test, type Page } from "@playwright/test";

import { ADMIN, ensureUser, signInContext } from "./helpers";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function acknowledgeSecret(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
}

test("supported HTTP browser flows use unique v4 ids without crypto.randomUUID", async ({
  context,
  page,
  baseURL,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  const requestIds: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (
      (request.method() === "POST" &&
        ["/api/users", "/api/api-keys"].includes(
          new URL(request.url()).pathname,
        )) ||
      (request.method() === "PATCH" &&
        new URL(request.url()).pathname.startsWith("/api/users/"))
    ) {
      const body = request.postDataJSON() as { request_id?: string };
      if (body.request_id) requestIds.push(body.request_id);
    }
    await route.continue();
  });

  await page.goto("/users");
  expect(
    await page.evaluate(() => ({
      randomUUID: typeof crypto.randomUUID,
      getRandomValues: typeof crypto.getRandomValues,
      secureContext: window.isSecureContext,
      protocol: window.location.protocol,
    })),
  ).toEqual({
    randomUUID: "undefined",
    getRandomValues: "function",
    secureContext: true,
    protocol: "http:",
  });
  await page.getByRole("button", { name: "New user" }).click();
  await page.getByLabel("Username", { exact: true }).fill("fallback-id-user");
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText(/User created — fallback-id-user/)).toBeVisible();
  await acknowledgeSecret(page);

  const row = page.getByRole("row", { name: /fallback-id-user/ });
  await row.getByRole("button", { name: /Reset password/ }).click();
  await page
    .getByRole("dialog", { name: /Reset password for fallback-id-user/ })
    .getByRole("button", { name: "Reset password" })
    .click();
  await expect(
    page.getByText(/Password reset — fallback-id-user/),
  ).toBeVisible();
  await acknowledgeSecret(page);

  await page.goto("/keys");
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("fallback-id-key");
  await page.getByRole("button", { name: "Create key" }).click();
  await acknowledgeSecret(page);

  expect(requestIds).toHaveLength(3);
  expect(new Set(requestIds).size).toBe(3);
  for (const id of requestIds) expect(id).toMatch(UUID_V4);
});

test("all three identity mutations fail definitively and send nothing without a CSPRNG", async ({
  context,
  page,
  baseURL,
}) => {
  const target = await ensureUser(baseURL!, "no-csprng-reset-target", "member");
  await context.addInitScript(() => {
    Object.defineProperties(Crypto.prototype, {
      randomUUID: { configurable: true, value: undefined },
      getRandomValues: { configurable: true, value: undefined },
    });
  });
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  const mutations: string[] = [];
  await page.route("**/api/**", async (route) => {
    const method = route.request().method();
    if (["POST", "PATCH"].includes(method))
      mutations.push(route.request().url());
    await route.continue();
  });

  const recovery =
    "Secure request IDs are unavailable. Use HTTPS or a supported browser.";
  await page.goto("/users");
  await page.getByRole("button", { name: "New user" }).click();
  await page.getByLabel("Username", { exact: true }).fill("must-not-create");
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText(recovery)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create user" })).toBeEnabled();
  await page.keyboard.press("Escape");

  const row = page.getByRole("row", { name: new RegExp(target.username) });
  await row
    .getByRole("button", {
      name: new RegExp(`Reset password for ${target.username}`),
    })
    .click();
  const resetDialog = page.getByRole("dialog", {
    name: new RegExp(`Reset password for ${target.username}`),
  });
  await resetDialog
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await expect(page.getByText(recovery)).toBeVisible();
  await expect(
    resetDialog.getByRole("button", { name: "Reset password", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");

  await page.goto("/keys");
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("must-not-create");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText(recovery)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create key" })).toBeEnabled();
  expect(mutations).toEqual([]);
});
