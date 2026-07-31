import path from "node:path";

import { test, type Page } from "@playwright/test";

import { ensureSeeded } from "./seed.mjs";

const TOKEN = process.env.FS_E2E_TOKEN ?? "e2e-dashboard-fixture-token";
const BASE = `http://127.0.0.1:${Number(process.env.FS_E2E_PORT ?? 4610)}`;

const OUTPUT_DIR =
  process.env.FS_SCREENSHOT_DIR ??
  "/Users/admin/Documents/Hermes Projects/fs-server-admin-dashboard-implementation/implementation-pass";

test.beforeAll(async () => {
  await ensureSeeded(BASE, TOKEN);
});

// Every full page load drops the in-memory token by design, so navigation to
// a fresh route re-enters it through the gate.
async function gotoAuthed(page: Page, route: string) {
  await page.goto(route);
  const tokenField = page.getByLabel("Bearer token");
  if (await tokenField.isVisible().catch(() => false)) {
    await tokenField.fill(TOKEN);
    await page.getByRole("button", { name: "Unlock console" }).click();
  }
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
}

interface Shot {
  slug: string;
  route: string;
  ready: (page: Page) => Promise<void>;
}

async function firstFileId(): Promise<string> {
  const response = await fetch(
    `${BASE}/api/files?name=telemetry-batch-0412.parquet&limit=1`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  const body = (await response.json()) as { items: { id: string }[] };
  if (!body.items[0]) throw new Error("fixture object missing");
  return body.items[0].id;
}

test("capture desktop and mobile screenshots for every view", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const inspectorId = await firstFileId();
  const shots: Shot[] = [
    {
      slug: "overview",
      route: "/admin",
      ready: async (page) => {
        await page.getByText("Storage used").waitFor();
      },
    },
    {
      slug: "files",
      route: "/admin/files",
      ready: async (page) => {
        await page.locator("tbody tr").first().waitFor();
      },
    },
    {
      slug: "inspector",
      route: `/admin/files/${inspectorId}`,
      ready: async (page) => {
        await page.getByText("Object record").waitFor();
      },
    },
    {
      slug: "system",
      route: "/admin/system",
      ready: async (page) => {
        await page.getByText("FS_MAX_UPLOAD_BYTES").waitFor();
      },
    },
  ];

  const viewports = [
    { name: "desktop-1440x960", width: 1440, height: 960 },
    { name: "mobile-390x844", width: 390, height: 844 },
  ];

  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: "dark",
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    for (const shot of shots) {
      await gotoAuthed(page, shot.route);
      await shot.ready(page);
      await settle(page);
      await page.screenshot({
        path: path.join(OUTPUT_DIR, `${shot.slug}-${viewport.name}.png`),
        fullPage: false,
      });
    }
    // Token gate + mobile nav open, once per viewport where meaningful.
    if (viewport.width < 500) {
      await gotoAuthed(page, "/admin");
      await page.getByText("Storage used").waitFor();
      await page.getByRole("button", { name: "menu" }).click();
      await page.waitForTimeout(200);
      await page.screenshot({
        path: path.join(OUTPUT_DIR, `mobile-nav-open-${viewport.name}.png`),
      });
    }
    await context.close();
  }

  const gate = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: "dark",
    deviceScaleFactor: 2,
  });
  const gatePage = await gate.newPage();
  await gatePage.goto(`${BASE}/admin`);
  await gatePage
    .getByRole("heading", { name: "Authentication required" })
    .waitFor();
  await gatePage.screenshot({
    path: path.join(OUTPUT_DIR, "token-gate-desktop-1440x960.png"),
  });
  await gate.close();
});
