import { expect, test } from "@playwright/test";

import {
  createApiKeyFor,
  ensureUser,
  signInContext,
  uploadFile,
} from "./helpers";

// P2-9 regression: server-valid 100-byte unbroken names must never widen
// the page or a dialog at mobile widths.
const LONG_NAME = "x".repeat(100);

test("100-byte key names keep the keys page and revoke sheet inside the viewport", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "longdata-member", "member");
  const api = await import("./helpers");
  await api.createApiKeyFor(baseURL!, owner.id, LONG_NAME);
  await signInContext(context, baseURL!, owner.username, owner.password);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/keys");
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(overflow.doc, `keys@${width}`).toBeLessThanOrEqual(overflow.client);

    // Open the revoke confirmation naming the 100-byte key.
    await page
      .getByRole("button", { name: /^Revoke/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const dialogOverflow = await dialog.evaluate((element) => ({
      scroll: element.scrollWidth,
      client: element.clientWidth,
      docScroll: document.documentElement.scrollWidth,
      docClient: document.documentElement.clientWidth,
    }));
    expect(dialogOverflow.scroll, `dialog@${width}`).toBeLessThanOrEqual(
      dialogOverflow.client + 1,
    );
    expect(dialogOverflow.docScroll).toBeLessThanOrEqual(
      dialogOverflow.docClient,
    );
    await page.keyboard.press("Escape");
  }
});

test("100-byte file names keep the files browser inside the viewport", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "longfile-member", "member");
  const bearer = await createApiKeyFor(baseURL!, owner.id, "longfile-key");
  await uploadFile(baseURL!, bearer, `${LONG_NAME}.txt`, "public");
  await signInContext(context, baseURL!, owner.username, owner.password);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/files");
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(overflow.doc, `files@${width}`).toBeLessThanOrEqual(overflow.client);
  }
});
