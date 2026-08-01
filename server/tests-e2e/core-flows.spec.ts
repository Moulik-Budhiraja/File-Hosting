import { expect, test } from "@playwright/test";

import {
  createApiKeyFor,
  ensureUser,
  nextAddress,
  signInContext,
  uploadFile,
} from "./helpers";

test("invalid credentials show one generic error and clear the password", async ({
  page,
}) => {
  const address = nextAddress();
  await page.route("**/api/auth/login", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-real-ip": address },
    }),
  );
  await page.goto("/login");
  await page.getByLabel("Username").fill("nobody-here");
  await page.getByLabel("Password").fill("a wrong password 123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByText("Username or password is incorrect."),
  ).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveValue("");
  await expect(page.getByLabel("Password")).toBeFocused();
});

test("key create shows the secret once; revoked rows survive the next creation", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "keyflow-member", "member");
  await signInContext(context, baseURL!, owner.username, owner.password);
  await page.goto("/keys");

  // Create a key through the real UI.
  await page.getByRole("button", { name: "New key" }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("flow-key-a");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(
    page.getByText("Copy this key now. It won't be shown again."),
  ).toBeVisible();
  const secretText = await page.locator(".secret-value").innerText();
  expect(secretText).toMatch(/^fsk_/);
  await page.getByRole("checkbox", { name: /I've stored this key/ }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".secret-value")).toHaveCount(0);

  // Revoke it, then create another — the revoked record must stay listed
  // (bounded retention, not deletion).
  await page
    .getByRole("button", { name: /^Revoke/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Revoke key" }).click();
  await expect(page.getByText(/revoked · /).first()).toBeVisible();

  await page.getByRole("button", { name: "New key" }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("flow-key-b");
  await page.getByRole("button", { name: "Create key" }).click();
  await page.getByRole("checkbox", { name: /I've stored this key/ }).check();
  await page.getByRole("button", { name: "Done" }).click();

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/revoked · /).first()).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "flow-key-a", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "flow-key-b", exact: true }),
  ).toBeVisible();
});

test("anonymous protected/private/missing previews are byte-identical branded 404s", async ({
  request,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "privacy-owner", "member");
  const bearer = await createApiKeyFor(baseURL!, owner.id, "privacy-key");
  const privateFile = await uploadFile(
    baseURL!,
    bearer,
    "privacy-private.txt",
    "private",
  );
  const protectedFile = await uploadFile(
    baseURL!,
    bearer,
    "privacy-protected.txt",
    "protected",
  );

  const responses = await Promise.all([
    request.get(`/${privateFile.id}`, { failOnStatusCode: false }),
    request.get(`/${protectedFile.id}`, { failOnStatusCode: false }),
    request.get("/zzzzzz9", { failOnStatusCode: false }),
  ]);
  const bodies = await Promise.all(
    responses.map((response) => response.text()),
  );
  for (const response of responses) expect(response.status()).toBe(404);
  expect(bodies[0]).toBe(bodies[1]);
  expect(bodies[0]).toBe(bodies[2]);
  expect(bodies[0]).toContain("404 · NOT FOUND");
});

test("console pages render without console errors for an admin", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(
    context,
    baseURL!,
    "e2e-admin",
    "e2e-admin-password-longer-than-12",
  );
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  for (const route of ["/files", "/users", "/keys", "/account"]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
  }
  expect(problems).toEqual([]);
});
