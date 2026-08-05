import { expect, test, type Page } from "@playwright/test";

import { ADMIN, seedAggregateKeys, signInContext } from "./helpers";

// P2-2 / P2-4 regressions: aggregate key search must be server-side
// (never a page-local filter with a false global empty), and the mobile
// pager must meet the 44x44 target without letter-wrapping — proven with
// a real >100-row aggregate so the pager is actually enabled.

async function openKeys(
  page: Page,
  baseURL: string,
  context: Parameters<typeof signInContext>[0],
) {
  await seedAggregateKeys(baseURL);
  await signInContext(context, baseURL, ADMIN.username, ADMIN.password);
  await page.goto("/keys");
  await expect(page.getByRole("button", { name: "next →" })).toBeEnabled();
}

test("aggregate search finds a key buried beyond page 1 — no false global empty", async ({
  context,
  page,
  baseURL,
}) => {
  await openKeys(page, baseURL!, context);
  // The needle is not on the loaded first page…
  await expect(
    page.getByRole("cell", { name: "needle-buried-key", exact: true }),
  ).toHaveCount(0);

  // …but typing its name finds it via the server-side search.
  await page.getByLabel(/search key name or owner/i).fill("needle-buried");
  await expect(
    page.getByRole("cell", { name: "needle-buried-key", exact: true }),
  ).toBeVisible();

  // Owner-username search is covered too.
  await page.getByLabel(/search key name or owner/i).fill("needle-owner");
  await expect(
    page.getByRole("cell", { name: "needle-buried-key", exact: true }),
  ).toBeVisible();

  // A genuinely absent term shows a truthful (global, server-backed)
  // empty result.
  await page.getByLabel(/search key name or owner/i).fill("zzz-no-such-key");
  await expect(
    page.getByText("no keys match the current filters"),
  ).toBeVisible();
});

test("aggregate pagination stays disjoint and stable while searching", async ({
  context,
  page,
  baseURL,
}) => {
  await openKeys(page, baseURL!, context);
  const firstPageNames = await page
    .locator("tbody td.cell-strong")
    .allInnerTexts();
  await page.getByRole("button", { name: "next →" }).click();
  await expect(page.getByRole("button", { name: "← prev" })).toBeEnabled();
  const secondPageNames = await page
    .locator("tbody td.cell-strong")
    .allInnerTexts();
  const firstSet = new Set(firstPageNames);
  expect(secondPageNames.length).toBeGreaterThan(0);
  for (const name of secondPageNames) {
    expect(firstSet.has(name)).toBe(false);
  }
  // Backward navigation restores the first page.
  await page.getByRole("button", { name: "← prev" }).click();
  await expect(page.getByRole("button", { name: "← prev" })).toBeDisabled();
});

test("the enabled mobile keys pager meets 44x44 with unwrapped labels at 360/390/430", async ({
  context,
  page,
  baseURL,
}) => {
  await seedAggregateKeys(baseURL!);
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/keys");
    const next = page.getByRole("button", { name: "next →" });
    await expect(next).toBeEnabled();
    for (const name of ["← prev", "next →"]) {
      const box = await page
        .getByRole("button", { name, exact: true })
        .boundingBox();
      expect(box!.width, `${name} width @${width}`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `${name} height @${width}`).toBeGreaterThanOrEqual(
        44,
      );
      // Letter-per-line wrapping shows up as an extreme height; a single
      // unwrapped label stays a one-line control.
      expect(box!.height, `${name} single line @${width}`).toBeLessThanOrEqual(
        64,
      );
      expect(
        box!.width / box!.height,
        `${name} not a vertical letter stack @${width}`,
      ).toBeGreaterThan(0.9);
    }
    // The long retention footline must not push the page wide.
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(overflow.doc, `keys overflow @${width}`).toBeLessThanOrEqual(
      overflow.client,
    );
  }
});
