import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import sharp from "sharp";

import { LEGACY_TOKEN, signInContext, uploadFile } from "./helpers";

const references = [
  [
    "01-overview-live-operations-1440.png",
    "61ceccf52bcbac09828af1187e29d469e2165f077a7981e0b1719af9f1eafd94",
  ],
  [
    "02-files-1440.png",
    "4111b5742cf996481d3f5e70da76137d343d63da8845ef91a97448a0818655fa",
  ],
  [
    "03-file-inspector-1440.png",
    "77f9cc647f2e18b1430a3ef70b333fb146cbe16f3a533fd8f7587cccda0b5989",
  ],
  [
    "04-system-1440.png",
    "0ab62a119b59d3e0e37b229ef71c6a16280faf5dc48d91acdb9a5e4879c5f80a",
  ],
  [
    "05-desktop-states-overview.png",
    "6dc22e88f76290dc5b1e1514738f6268e6f3e281ec5fd7d81513cc493a6cbfe3",
  ],
  [
    "06-desktop-states-files.png",
    "b61e8b9040f77a14b07ae9a0ca6a673dd7d6b7bd13d03f8a4d69551bba6faeda",
  ],
  [
    "07-desktop-states-inspector-access.png",
    "2b3ca394cf5444a07dddb2e50e9ae8984329daaf7ad5dc7db915186a577054ad",
  ],
  [
    "08-mobile-390-core.png",
    "d29562685d47dd5a4a1bfaf70566b58a89dfaf763d7fed952bfeb272414607d8",
  ],
  [
    "09-mobile-430-core.png",
    "b2f5a7bc33e2d33668d82eb715652ca2f81217a44defc10ffa36faebdfa86c0c",
  ],
  [
    "10-mobile-390-states.png",
    "3345715f9203e79a510489c5b3205d213301a14adf9e37a364d752b52cef1117",
  ],
] as const;

const referenceRoot = path.join(
  process.env.DASHBOARD_REFERENCE_DIR ??
    path.join(
      process.env.HOME ?? "",
      "Library/Caches/Hermes/Scratch/20260803-file-hosting-design-review/minimal-copy-v2/dashboard-v4",
    ),
);

let seededId = "";

test.beforeAll(async ({ baseURL }) => {
  for (const [name, digest] of references) {
    const bytes = await readFile(path.join(referenceRoot, name));
    expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(digest);
  }
  const seeded = await uploadFile(
    baseURL!,
    LEGACY_TOKEN,
    "dashboard-v4-design-audit.parquet",
    "private",
    "dashboard visual audit bytes",
    "application/parquet",
  );
  seededId = seeded.id;
});

async function admin(page: Page, baseURL: string) {
  await signInContext(
    page.context(),
    baseURL,
    "e2e-admin",
    "e2e-admin-password-longer-than-12",
  );
}

async function evidence(page: Page, testInfo: TestInfo, name: string) {
  const bodyOverflow = await page.evaluate(
    () => document.body.scrollWidth - document.documentElement.clientWidth,
  );
  expect(bodyOverflow, `${name} body overflow`).toBeLessThanOrEqual(0);
  const bytes = await page.screenshot({ fullPage: true });
  const reference = await readFile(path.join(referenceRoot, name));
  const referenceMeta = await sharp(reference).metadata();
  const viewport = page.viewportSize();
  const comparisonBytes =
    viewport &&
    referenceMeta.width === viewport.width &&
    (referenceMeta.height ?? 0) <= viewport.height
      ? await page.screenshot({
          clip: {
            x: 0,
            y: 0,
            width: referenceMeta.width,
            height: referenceMeta.height!,
          },
        })
      : bytes;
  const sampleSize = 96;
  const [actualMeta, actualRaw, referenceRaw] = await Promise.all([
    sharp(comparisonBytes).metadata(),
    sharp(comparisonBytes)
      .resize(sampleSize, sampleSize, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer(),
    sharp(reference)
      .resize(sampleSize, sampleSize, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer(),
  ]);
  if ((actualMeta.width ?? 0) > 1_000) {
    expect(actualMeta.width, `${name} width`).toBe(referenceMeta.width);
    expect(actualMeta.height, `${name} height`).toBe(referenceMeta.height);
  }
  let colorDifference = 0;
  let actualEdge = 0;
  let referenceEdge = 0;
  let edgeDifference = 0;
  let edgeSamples = 0;
  for (let offset = 0; offset < actualRaw.length; offset += 1) {
    colorDifference += Math.abs(actualRaw[offset]! - referenceRaw[offset]!);
  }
  for (let y = 1; y < sampleSize; y += 1) {
    for (let x = 1; x < sampleSize; x += 1) {
      const offset = (y * sampleSize + x) * 3;
      const left = offset - 3;
      const above = ((y - 1) * sampleSize + x) * 3;
      let actualGradient = 0;
      let referenceGradient = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        actualGradient +=
          Math.abs(actualRaw[offset + channel]! - actualRaw[left + channel]!) +
          Math.abs(actualRaw[offset + channel]! - actualRaw[above + channel]!);
        referenceGradient +=
          Math.abs(
            referenceRaw[offset + channel]! - referenceRaw[left + channel]!,
          ) +
          Math.abs(
            referenceRaw[offset + channel]! - referenceRaw[above + channel]!,
          );
      }
      actualGradient /= 6;
      referenceGradient /= 6;
      actualEdge += actualGradient;
      referenceEdge += referenceGradient;
      edgeDifference += Math.abs(actualGradient - referenceGradient);
      edgeSamples += 1;
    }
  }
  // Independent release tolerances: reject blank/missing structure and broad
  // palette/layout drift while allowing genuine runtime text and data changes.
  const normalizedColorDifference = colorDifference / actualRaw.length / 255;
  const normalizedEdgeDifference = edgeDifference / edgeSamples / 255;
  const edgeDensityRatio = actualEdge / referenceEdge;
  expect(
    normalizedColorDifference,
    `${name} palette drift`,
  ).toBeLessThanOrEqual(0.085);
  expect(
    normalizedEdgeDifference,
    `${name} structure drift`,
  ).toBeLessThanOrEqual(0.06);
  expect(edgeDensityRatio, `${name} missing visual structure`).toBeGreaterThan(
    0.18,
  );
  expect(edgeDensityRatio, `${name} excess visual noise`).toBeLessThan(2.25);
  if (process.env.DASHBOARD_EVIDENCE_DIR) {
    await mkdir(process.env.DASHBOARD_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(process.env.DASHBOARD_EVIDENCE_DIR, name),
      fullPage: true,
    });
  }
  await testInfo.attach(name, { body: bytes, contentType: "image/png" });
}

test("01 approved desktop overview", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1520, height: 1040 });
  await admin(page, baseURL!);
  await page.goto("/overview");
  await expect(
    page.getByRole("heading", { name: "Live Operations" }),
  ).toBeVisible();
  await expect(page.getByText("Volume used")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Active transfers" }),
  ).toBeVisible();
  await evidence(page, testInfo, references[0][0]);
});

test("02 approved desktop files", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1520, height: 1040 });
  await admin(page, baseURL!);
  await page.goto("/files");
  await expect(
    page.getByRole("button", { name: /dashboard-v4-design-audit/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Archive filter" }),
  ).toBeVisible();
  await evidence(page, testInfo, references[1][0]);
});

test("03 approved desktop inspector", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1520, height: 1040 });
  await admin(page, baseURL!);
  await page.goto(`/files?sel=${seededId}`);
  const inspector = page.getByRole("region", {
    name: /object record · access/i,
  });
  await expect(inspector).toBeVisible();
  await expect(
    inspector.locator("dd").filter({ hasText: /^private/ }),
  ).toBeVisible();
  await evidence(page, testInfo, references[2][0]);
});

test("04 approved desktop system", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1520, height: 1040 });
  await admin(page, baseURL!);
  await page.goto("/system");
  await expect(
    page.getByRole("heading", { name: "System Health & Configuration" }),
  ).toBeVisible();
  await expect(page.getByText("config read-only")).toBeVisible();
  await expect(page.getByText("Per-user key auth")).toBeVisible();
  await evidence(page, testInfo, references[3][0]);
});

test("05 approved overview stale and storage-floor states", async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 1520, height: 528 });
  await admin(page, baseURL!);
  let systemCalls = 0;
  await page.route("**/api/system", async (route) => {
    systemCalls += 1;
    if (systemCalls === 1) {
      const response = await route.fetch();
      const body = (await response.json()) as {
        storage: { free_bytes: number };
        config: { min_free_bytes: number };
      };
      body.storage.free_bytes = Math.max(1, body.config.min_free_bytes - 1);
      await route.fulfill({ response, json: body });
    } else {
      await route.fulfill({
        status: 503,
        json: { error: { code: "offline", message: "offline" } },
      });
    }
  });
  await page.goto("/overview");
  await expect(page.getByText("Free space below reserve floor")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("frozen", {
    timeout: 5_000,
  });
  await evidence(page, testInfo, references[4][0]);
});

test("06 approved files empty and recoverable error states", async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 1520, height: 552 });
  await admin(page, baseURL!);
  await page.route("**/api/files?**", (route) =>
    route.fulfill({ status: 200, json: { items: [], next_cursor: null } }),
  );
  await page.goto("/files?q=none");
  await expect(
    page.getByText("No files match the current filters"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Clear filters" }),
  ).toBeVisible();
  await evidence(page, testInfo, references[5][0]);
});

test("07 approved inspector access and destructive confirmation", async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 1520, height: 500 });
  await admin(page, baseURL!);
  await page.goto(`/files?sel=${seededId}`);
  await page.getByRole("button", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: /Delete dashboard-v4/ });
  await expect(dialog).toContainText("cannot be undone");
  const confirmation = dialog.getByLabel(/Type .* to confirm/);
  await expect(confirmation).toBeFocused();
  await confirmation.fill("dashboard-v4-design-audit.parquet");
  await expect(
    dialog.getByRole("button", { name: "Delete file" }),
  ).toBeEnabled();
  await evidence(page, testInfo, references[6][0]);
});

for (const [index, width] of [
  [7, 390],
  [8, 430],
] as const) {
  test(`${String(index + 1).padStart(2, "0")} approved mobile core at ${width}`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 924 });
    await admin(page, baseURL!);
    for (const route of [
      "/overview",
      "/files",
      `/files?sel=${seededId}`,
      "/system",
    ]) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      expect(
        await page.evaluate(
          () =>
            document.body.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    }
    const mobileNav = page.getByRole("navigation", { name: "Console" });
    for (const label of ["Overview", "Files", "System", "More"]) {
      const link = mobileNav.getByRole("link", { name: label });
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box && box.height >= 44, label).toBeTruthy();
    }
    await evidence(page, testInfo, references[index][0]);
  });
}

test("10 approved mobile states", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 924 });
  await admin(page, baseURL!);
  await page.route("**/api/files?**", (route) =>
    route.fulfill({ status: 200, json: { items: [], next_cursor: null } }),
  );
  await page.goto("/files?q=none");
  await expect(
    page.getByText("No files match the current filters"),
  ).toBeVisible();
  for (const control of await page.getByRole("button").all()) {
    if (!(await control.isVisible()) || !(await control.isEnabled())) continue;
    const box = await control.boundingBox();
    expect(box && box.height >= 44, await control.innerText()).toBeTruthy();
  }
  await evidence(page, testInfo, references[9][0]);
});
