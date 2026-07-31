import { expect, test } from "@playwright/test";

// P1-1 regression: the committed `npm run build && npm start` pair must
// serve a complete app — HTML, JS, CSS, and public assets — from the
// standalone output alone. /healthz passing is NOT sufficient.

test("login HTML references assets that all load with correct types", async ({
  request,
}) => {
  const page = await request.get("/login");
  expect(page.status()).toBe(200);
  const html = await page.text();

  const scriptSources = [...html.matchAll(/src="(\/_next\/[^"]+)"/gu)].map(
    (match) => match[1]!,
  );
  const styleSheets = [
    ...html.matchAll(/href="(\/_next\/[^"]+\.css[^"]*)"/gu),
  ].map((match) => match[1]!);
  expect(scriptSources.length).toBeGreaterThan(0);

  for (const source of scriptSources) {
    const asset = await request.get(source);
    expect(asset.status(), `${source} should be served`).toBe(200);
    expect(asset.headers()["content-type"] ?? "").toContain("javascript");
  }
  for (const sheet of styleSheets) {
    const asset = await request.get(sheet);
    expect(asset.status(), `${sheet} should be served`).toBe(200);
    expect(asset.headers()["content-type"] ?? "").toContain("css");
  }
});

test("public assets are served from the standalone output", async ({
  request,
}) => {
  const favicon = await request.get("/favicon.ico");
  expect(favicon.status()).toBe(200);
});

test("the login page actually executes its JavaScript and renders the form", async ({
  page,
}) => {
  await page.goto("/login");
  // A blank shell would leave the body empty; the interactive form only
  // appears when the bundle executes.
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).toContain("fs-server");
});
