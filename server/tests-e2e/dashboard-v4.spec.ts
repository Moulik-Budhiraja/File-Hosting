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

  const overview = await readFile(path.join(referenceRoot, references[0][0]));
  const metadata = await sharp(overview).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("approved overview reference has no dimensions");
  const width = metadata.width;
  const height = metadata.height;
  const mutants = [
    await sharp(overview).blur(8).png().toBuffer(),
    await sharp(overview)
      .composite([
        {
          input: {
            create: {
              width: Math.floor(width / 2),
              height,
              channels: 3,
              background: "#0d0f10",
            },
          },
          left: Math.floor(width / 2),
          top: 0,
        },
      ])
      .png()
      .toBuffer(),
    await sharp({
      create: { width, height, channels: 3, background: "#0d0f10" },
    })
      .composite([
        {
          input: await sharp(overview)
            .extract({ left: 0, top: 0, width: width - 120, height })
            .png()
            .toBuffer(),
          left: 120,
          top: 0,
        },
      ])
      .png()
      .toBuffer(),
  ];
  for (const [index, mutant] of mutants.entries()) {
    const metrics = await visualMetrics(mutant, overview);
    expect(
      visualPasses(metrics),
      `visual negative control ${index + 1}: ${JSON.stringify(metrics)}`,
    ).toBe(false);
  }
});

async function admin(page: Page, baseURL: string) {
  await signInContext(
    page.context(),
    baseURL,
    "e2e-admin",
    "e2e-admin-password-longer-than-12",
  );
}

async function visualMetrics(actual: Buffer, reference: Buffer) {
  const width = 608;
  const height = 416;
  const [actualRaw, referenceRaw] = await Promise.all([
    sharp(actual)
      .resize(width, height, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer(),
    sharp(reference)
      .resize(width, height, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer(),
  ]);
  let colorDifference = 0;
  let actualEdge = 0;
  let referenceEdge = 0;
  let edgeDifference = 0;
  let edgeSamples = 0;
  let actualStrongEdges = 0;
  let referenceStrongEdges = 0;
  let overlappingStrongEdges = 0;
  let actualEdgeX = 0;
  let referenceEdgeX = 0;
  let actualEdgeY = 0;
  let referenceEdgeY = 0;
  const actualQuadrantEdges = [0, 0, 0, 0];
  const referenceQuadrantEdges = [0, 0, 0, 0];

  const actualColumnEdges = new Float64Array(width);
  const referenceColumnEdges = new Float64Array(width);
  for (let offset = 0; offset < actualRaw.length; offset += 1) {
    colorDifference += Math.abs(actualRaw[offset]! - referenceRaw[offset]!);
  }
  for (let y = 1; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const left = offset - 3;
      const above = ((y - 1) * width + x) * 3;
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
      actualColumnEdges[x]! += actualGradient;
      referenceColumnEdges[x]! += referenceGradient;
      actualEdgeX += actualGradient * x;
      referenceEdgeX += referenceGradient * x;
      actualEdgeY += actualGradient * y;
      referenceEdgeY += referenceGradient * y;
      edgeDifference += Math.abs(actualGradient - referenceGradient);
      if (actualGradient >= 20) actualStrongEdges += 1;
      if (referenceGradient >= 20) referenceStrongEdges += 1;

      if (actualGradient >= 20 && referenceGradient >= 20)
        overlappingStrongEdges += 1;
      const quadrant = (y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0);
      actualQuadrantEdges[quadrant]! += actualGradient;
      referenceQuadrantEdges[quadrant]! += referenceGradient;
      edgeSamples += 1;
    }
  }
  let maxTileDifference = 0;
  const tileWidth = width / 8;
  const tileHeight = height / 8;
  for (let tileY = 0; tileY < 8; tileY += 1) {
    for (let tileX = 0; tileX < 8; tileX += 1) {
      let tileDifference = 0;
      let samples = 0;
      for (let y = tileY * tileHeight; y < (tileY + 1) * tileHeight; y += 1) {
        for (let x = tileX * tileWidth; x < (tileX + 1) * tileWidth; x += 1) {
          const offset = (y * width + x) * 3;
          for (let channel = 0; channel < 3; channel += 1) {
            tileDifference += Math.abs(
              actualRaw[offset + channel]! - referenceRaw[offset + channel]!,
            );
            samples += 1;
          }
        }
      }
      maxTileDifference = Math.max(
        maxTileDifference,
        tileDifference / samples / 255,
      );
    }
  }

  const boundaryStart = Math.floor(width * 0.05);
  const boundaryEnd = Math.floor(width * 0.35);
  let actualBoundary = boundaryStart;
  let referenceBoundary = boundaryStart;
  for (let x = boundaryStart + 1; x < boundaryEnd; x += 1) {
    if (actualColumnEdges[x]! > actualColumnEdges[actualBoundary]!)
      actualBoundary = x;
    if (referenceColumnEdges[x]! > referenceColumnEdges[referenceBoundary]!)
      referenceBoundary = x;
  }
  return {
    colorDifference: colorDifference / actualRaw.length / 255,
    edgeDifference: edgeDifference / edgeSamples / 255,
    edgeDensityRatio: actualEdge / referenceEdge,
    strongEdgeRatio: actualStrongEdges / referenceStrongEdges,
    strongEdgeOverlap: overlappingStrongEdges / referenceStrongEdges,
    edgeCentroidXDelta: Math.abs(
      actualEdgeX / actualEdge / width - referenceEdgeX / referenceEdge / width,
    ),
    edgeCentroidYDelta: Math.abs(
      actualEdgeY / actualEdge / height -
        referenceEdgeY / referenceEdge / height,
    ),
    leftBoundaryDelta: Math.abs(actualBoundary - referenceBoundary) / width,
    rightHalfEdgeRatio:
      (actualQuadrantEdges[1]! + actualQuadrantEdges[3]!) /
      (referenceQuadrantEdges[1]! + referenceQuadrantEdges[3]!),
    minimumQuadrantEdgeRatio: Math.min(
      ...actualQuadrantEdges.map(
        (edge, index) => edge / referenceQuadrantEdges[index]!,
      ),
    ),
    maxTileDifference,
  };
}

function visualPasses(
  metrics: Awaited<ReturnType<typeof visualMetrics>>,
  maxBoundaryDelta = 0.07,
) {
  return (
    metrics.colorDifference <= 0.085 &&
    metrics.edgeDifference <= 0.06 &&
    metrics.edgeDensityRatio > 0.18 &&
    metrics.edgeDensityRatio < 3 &&
    metrics.strongEdgeRatio > 0.12 &&
    metrics.strongEdgeRatio < 4 &&
    metrics.leftBoundaryDelta < maxBoundaryDelta &&
    metrics.edgeCentroidYDelta < 0.4 &&
    metrics.rightHalfEdgeRatio > 0.05 &&
    metrics.maxTileDifference <= 0.26
  );
}

async function evidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  referenceCrop?: { left: number; top: number; width: number; height: number },
  evidenceName = name,
) {
  const bodyOverflow = await page.evaluate(
    () => document.body.scrollWidth - document.documentElement.clientWidth,
  );
  expect(bodyOverflow, `${name} body overflow`).toBeLessThanOrEqual(0);
  const bytes = await page.screenshot({ fullPage: true });
  const frozenReference = await readFile(path.join(referenceRoot, name));
  const reference = referenceCrop
    ? await sharp(frozenReference).extract(referenceCrop).png().toBuffer()
    : frozenReference;
  const referenceMeta = await sharp(reference).metadata();
  const viewport = page.viewportSize();
  const referenceHeight = referenceMeta.height ?? 0;
  const comparisonBytes = referenceCrop
    ? await page.screenshot()
    : viewport?.width === referenceMeta.width &&
        referenceHeight <= viewport.height
      ? await page.screenshot({
          clip: {
            x: 0,
            y: 0,
            width: referenceMeta.width ?? viewport.width,
            height: referenceHeight,
          },
        })
      : bytes;
  const actualMeta = await sharp(comparisonBytes).metadata();
  expect(actualMeta.width, `${evidenceName} mapped width`).toBe(
    referenceMeta.width,
  );
  expect(actualMeta.height, `${evidenceName} mapped height`).toBe(
    referenceMeta.height,
  );
  const metrics = await visualMetrics(comparisonBytes, reference);
  const maxBoundaryDelta = name === references[0][0] ? 0.07 : 0.27;
  expect(
    metrics.colorDifference,
    `${evidenceName} palette drift`,
  ).toBeLessThanOrEqual(0.085);
  expect(
    metrics.edgeDifference,
    `${evidenceName} structure drift`,
  ).toBeLessThanOrEqual(0.06);
  expect(
    metrics.edgeDensityRatio,
    `${evidenceName} missing visual structure`,
  ).toBeGreaterThan(0.18);
  expect(
    metrics.edgeDensityRatio,
    `${evidenceName} excess visual noise`,
  ).toBeLessThan(3);
  expect(
    metrics.strongEdgeRatio,
    `${evidenceName} blurred typography`,
  ).toBeGreaterThan(0.12);
  expect(
    metrics.strongEdgeRatio,
    `${evidenceName} excess sharp noise`,
  ).toBeLessThan(4);
  expect(
    metrics.leftBoundaryDelta,
    `${evidenceName} structural boundary displacement`,
  ).toBeLessThan(maxBoundaryDelta);

  expect(
    metrics.edgeCentroidYDelta,
    `${evidenceName} vertical displacement`,
  ).toBeLessThan(0.4);
  expect(
    metrics.rightHalfEdgeRatio,
    `${evidenceName} missing right frame region`,
  ).toBeGreaterThan(0.05);
  expect(
    metrics.maxTileDifference,
    `${evidenceName} regional drift`,
  ).toBeLessThanOrEqual(0.26);
  expect(
    visualPasses(metrics, maxBoundaryDelta),
    `${evidenceName} frozen-frame comparison`,
  ).toBe(true);
  if (process.env.DASHBOARD_EVIDENCE_DIR) {
    await mkdir(process.env.DASHBOARD_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(process.env.DASHBOARD_EVIDENCE_DIR, evidenceName),
      fullPage: true,
    });
  }
  await testInfo.attach(evidenceName, {
    body: bytes,
    contentType: "image/png",
  });
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
    await page.setViewportSize({ width, height: 844 });
    await admin(page, baseURL!);
    const routes = ["/overview", "/files", `/files?sel=${seededId}`, "/system"];
    for (const [panel, route] of routes.entries()) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      expect(
        await page.evaluate(
          () =>
            document.body.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await evidence(
        page,
        testInfo,
        references[index][0],
        {
          left: 40 + panel * (width + 48),
          top: 40,
          width,
          height: 844,
        },
        `${String(index + 1).padStart(2, "0")}-mobile-${width}-panel-${panel + 1}.png`,
      );
    }
    const mobileNav = page.getByRole("navigation", { name: "Console" });
    for (const label of ["Overview", "Files", "System", "More"]) {
      const link = mobileNav.getByRole("link", { name: label });
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box && box.height >= 44, label).toBeTruthy();
    }
  });
}

test("10 approved mobile states", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await admin(page, baseURL!);

  const captureState = async (panel: number) =>
    evidence(
      page,
      testInfo,
      references[9][0],
      {
        left: 40 + (panel % 3) * 438,
        top: 40 + Math.floor(panel / 3) * 864,
        width: 390,
        height: 844,
      },
      `10-mobile-390-state-${panel + 1}.png`,
    );

  await page.route("**/api/system", () => new Promise(() => undefined));
  await page.goto("/overview");
  await expect(page.getByText("Loading…")).toBeVisible();
  await captureState(0);
  await page.unroute("**/api/system");

  let calls = 0;
  await page.route("**/api/system", async (route) => {
    calls += 1;
    if (calls === 1) await route.fulfill({ response: await route.fetch() });
    else
      await route.fulfill({
        status: 503,
        json: { error: { code: "offline" } },
      });
  });
  await page.goto("/overview");
  await expect(page.getByRole("status")).toContainText("frozen", {
    timeout: 5_000,
  });
  await captureState(1);
  await page.unroute("**/api/system");

  await page.route("**/api/files?**", (route) =>
    route.fulfill({ status: 200, json: { items: [], next_cursor: null } }),
  );
  await page.goto("/files?q=none");
  await expect(
    page.getByText("No files match the current filters"),
  ).toBeVisible();
  await captureState(2);
  await page.unroute("**/api/files?**");

  await page.goto(`/files?sel=${seededId}`);
  await expect(
    page.getByRole("region", { name: /object record · access/i }),
  ).toBeVisible();
  await captureState(3);

  await page.route("**/api/files?**", (route) =>
    route.fulfill({ status: 503, json: { error: { code: "offline" } } }),
  );
  await page.goto("/files");
  await expect(page.getByText(/Couldn.t load files/)).toBeVisible();
  await captureState(4);
  await page.unroute("**/api/files?**");

  const long = await uploadFile(
    baseURL!,
    LEGACY_TOKEN,
    "研究データ_2026年度_テレメトリー集計_управление-отчёт_τελικό-αντίγραφο_v2.parquet",
    "private",
    "long dashboard audit bytes",
    "application/parquet",
  );
  await page.goto(`/files?sel=${long.id}`);
  await expect(page.getByText(/研究データ/).first()).toBeVisible();
  await captureState(5);

  for (const control of await page.getByRole("button").all()) {
    if (!(await control.isVisible()) || !(await control.isEnabled())) continue;
    const box = await control.boundingBox();
    expect(box && box.height >= 44, await control.innerText()).toBeTruthy();
  }
});
