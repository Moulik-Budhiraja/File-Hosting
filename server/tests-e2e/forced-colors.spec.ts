import { expect, test } from "@playwright/test";

import { ADMIN, signInContext } from "./helpers";

test("forced-colors keeps selected nav/segments visible and 2px focus outlines", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/files");
  expect(
    await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
  ).toBe(true);
  await page.waitForLoadState("networkidle");

  const activeNav = page.locator(".nav-item-active");
  await expect(activeNav).toBeVisible();
  const navStyles = await activeNav.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      outlineWidth: styles.outlineWidth,
      textDecorationLine: styles.textDecorationLine,
    };
  });
  expect(parseInt(navStyles.outlineWidth, 10)).toBeGreaterThanOrEqual(2);
  expect(navStyles.textDecorationLine).toContain("underline");

  const activeSegment = page.locator(".segment-item-active").first();
  await expect(activeSegment).toBeVisible();
  const segmentStyles = await activeSegment.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      outlineWidth: styles.outlineWidth,
      textDecorationLine: styles.textDecorationLine,
    };
  });
  expect(parseInt(segmentStyles.outlineWidth, 10)).toBeGreaterThanOrEqual(2);
  expect(segmentStyles.textDecorationLine).toContain("underline");

  // Focus outline: tab to the search field and measure.
  const search = page.getByLabel("Search name or tag");
  await search.focus();
  const focusOutline = await search.evaluate(
    (element) => getComputedStyle(element).outlineWidth,
  );
  expect(parseInt(focusOutline, 10)).toBeGreaterThanOrEqual(2);
});
