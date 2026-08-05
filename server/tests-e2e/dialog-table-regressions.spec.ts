import { expect, test } from "@playwright/test";

import {
  createApiKeyFor,
  ensureUser,
  signInContext,
  uploadFile,
} from "./helpers";

test("closing a modal restores focus only after the trigger is interactive", async ({
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
  await page.goto("/keys");
  const trigger = page.getByRole("button", { name: "New key" }).first();
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "New API key" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "New API key" })).toHaveCount(
    0,
  );
  await expect(trigger).toBeFocused();
  await expect(trigger).not.toHaveAttribute("inert", "");
  expect(
    await trigger.evaluate(
      (element) => element.closest("[inert], [aria-hidden='true']") === null,
    ),
  ).toBe(true);
});

test("desktop file metadata keeps atomic size, MIME, and owner tokens on one line", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "metadata-owner", "member");
  const bearer = await createApiKeyFor(
    baseURL!,
    owner.id,
    "metadata-token-key",
  );
  for (let index = 0; index < 8; index += 1) {
    await uploadFile(
      baseURL!,
      bearer,
      `metadata-token-regression-${index}-with-a-long-file-name.txt`,
      "public",
      `content-${index}`,
    );
  }
  await signInContext(
    context,
    baseURL!,
    "e2e-admin",
    "e2e-admin-password-longer-than-12",
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/files");
  const row = page.locator(".data-table tbody tr").first();
  await expect(row).toBeVisible();
  for (const index of [2, 3, 4]) {
    const cell = row.locator(`td:nth-child(${index})`);
    expect(
      await cell.evaluate((element) => getComputedStyle(element).overflowWrap),
      `column ${index} permits mid-token breaks`,
    ).not.toBe("anywhere");
    expect(
      await cell.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set(
          Array.from(range.getClientRects()).map((rect) =>
            Math.round(rect.top),
          ),
        ).size;
      }),
      `column ${index} wrapped an atomic token`,
    ).toBe(1);
  }
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
