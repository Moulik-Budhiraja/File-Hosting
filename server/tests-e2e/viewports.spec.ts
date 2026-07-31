import { expect, test, type Page } from "@playwright/test";

import { ADMIN, signInContext } from "./helpers";

const WIDTHS = [360, 390, 430, 768, 1440];

async function assertNoBodyOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.doc, `${label} documentElement overflow`).toBeLessThanOrEqual(
    overflow.client,
  );
  expect(overflow.body, `${label} body overflow`).toBeLessThanOrEqual(
    overflow.client,
  );
}

test("login page has no body overflow and 44px targets at mobile widths", async ({
  page,
}) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/login");
    await expect(page.getByLabel("Username")).toBeVisible();
    await assertNoBodyOverflow(page, `login@${width}`);
    if (width <= 768) {
      const submit = await page
        .getByRole("button", { name: "Sign in" })
        .boundingBox();
      expect(submit!.height, `sign-in height @${width}`).toBeGreaterThanOrEqual(
        44,
      );
      for (const field of ["Username", "Password"]) {
        const box = await page.getByLabel(field).boundingBox();
        expect(box!.height, `${field} height @${width}`).toBeGreaterThanOrEqual(
          44,
        );
      }
    }
  }
});

test("console pages have no body overflow at all required widths", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ["/files", "/users", "/keys", "/account"]) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await assertNoBodyOverflow(page, `${route}@${width}`);
    }
  }
});

test("Files visibility segments are at least 44x44 on mobile", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/files");
  const visibilityGroup = page.getByRole("group", {
    name: "Visibility filter",
  });
  for (const name of ["All", "Public", "Protected", "Private"]) {
    const box = await visibilityGroup
      .getByRole("button", { name, exact: true })
      .boundingBox();
    expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
});

test("Users row actions are at least 44x44 on mobile", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/users");
  const overflowButton = page
    .getByRole("button", { name: /actions for/i })
    .first();
  await expect(overflowButton).toBeVisible();
  const box = await overflowButton.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
