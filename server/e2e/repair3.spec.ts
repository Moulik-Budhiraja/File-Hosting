// Third-repair production E2E coverage: positive download-cancellation
// feedback (Sol frontend P2-01) and mobile url-note padding (Sol frontend
// P3-01). Runs against the real standalone production build like the other
// suites.
import { expect, test, type Page } from "@playwright/test";

import { ensureSeeded } from "./seed.mjs";

const TOKEN = process.env.FS_E2E_TOKEN ?? "e2e-dashboard-fixture-token";
const BASE = `http://127.0.0.1:${Number(process.env.FS_E2E_PORT ?? 4610)}`;

const createdIds: string[] = [];

test.beforeAll(async () => {
  await ensureSeeded(BASE, TOKEN);
});

test.afterAll(async () => {
  for (const id of createdIds) {
    await fetch(`${BASE}/api/files/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  }
  createdIds.length = 0;
});

async function authenticate(page: Page, path = "/admin") {
  await page.goto(path);
  await page.getByLabel("Bearer token").fill(TOKEN);
  await page.getByRole("button", { name: "Unlock console" }).click();
}

async function uploadTarget(name: string): Promise<string> {
  const uploaded = await fetch(`${BASE}/api/files`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-fs-name": encodeURIComponent(name),
      "content-type": "application/octet-stream",
    },
    body: Buffer.alloc(64 * 1024),
  });
  expect(uploaded.status).toBe(201);
  const { id } = (await uploaded.json()) as { id: string };
  createdIds.push(id);
  return id;
}

const cancelledStatus = (page: Page) =>
  page.getByRole("status").filter({ hasText: "download cancelled" });

test.describe("positive cancellation feedback", () => {
  test("picker cancellation shows the neutral cancelled status", async ({
    page,
  }) => {
    const id = await uploadTarget("repair3-picker-cancel.bin");
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => {
          throw new DOMException("user cancelled", "AbortError");
        },
      });
    });
    await authenticate(page, `/admin/files/${id}`);
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await expect(cancelledStatus(page)).toBeVisible();
    await expect(page.getByText(/download failed/i)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Download", exact: true }),
    ).toBeEnabled();
  });

  test("response-establishment cancellation on the stream path shows cancelled", async ({
    page,
  }) => {
    const id = await uploadTarget("repair3-establish-cancel.bin");
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => ({
          createWritable: async () => ({
            write: async () => undefined,
            close: async () => undefined,
            abort: async () => undefined,
          }),
        }),
      });
    });
    await authenticate(page, `/admin/files/${id}`);
    // Hold the raw response so Cancel fires while it is being established.
    await page.route(`**/raw/${id}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await route.abort();
    });
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const cancel = page.getByRole("button", { name: "Cancel download" });
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect(cancelledStatus(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/download failed/i)).toHaveCount(0);
  });

  test("pending stream write cancellation shows cancelled", async ({
    page,
  }) => {
    const id = await uploadTarget("repair3-write-cancel.bin");
    await page.addInitScript(() => {
      const state = window as typeof window & {
        __repair3WriterStarted?: boolean;
      };
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => ({
          createWritable: async () => ({
            write: async () => {
              state.__repair3WriterStarted = true;
              await new Promise(() => undefined);
            },
            close: async () => undefined,
            abort: async () => undefined,
          }),
        }),
      });
    });
    await authenticate(page, `/admin/files/${id}`);
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            (window as typeof window & { __repair3WriterStarted?: boolean })
              .__repair3WriterStarted,
          ),
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Cancel download" }).click();
    await expect(cancelledStatus(page)).toBeVisible();
    await expect(page.getByText(/download failed/i)).toHaveCount(0);
  });

  test("bounded fallback cancellation shows cancelled", async ({ page }) => {
    const id = await uploadTarget("repair3-fallback-cancel.bin");
    await page.addInitScript(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await authenticate(page, `/admin/files/${id}`);
    await page.route(`**/raw/${id}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await route.abort();
    });
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const cancel = page.getByRole("button", { name: "Cancel download" });
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect(cancelledStatus(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/download failed/i)).toHaveCount(0);
  });

  test("a genuine failure still shows the failure alert, not cancelled", async ({
    page,
  }) => {
    const id = await uploadTarget("repair3-genuine-500.bin");
    await page.addInitScript(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await authenticate(page, `/admin/files/${id}`);
    await page.route(`**/raw/${id}`, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "internal", message: "synthetic genuine failure" },
        }),
      }),
    );
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await expect(page.getByText(/download failed/i)).toBeVisible();
    await expect(cancelledStatus(page)).toHaveCount(0);
  });
});

test.describe("mobile url-note padding", () => {
  async function privateFileId(): Promise<string> {
    const response = await fetch(
      `${BASE}/api/files?name=telemetry-batch-0412.parquet&limit=1`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const body = (await response.json()) as { items: { id: string }[] };
    if (!body.items[0]) throw new Error("private fixture object missing");
    return body.items[0].id;
  }

  for (const width of [360, 390]) {
    test(`url-note keeps its horizontal padding at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const id = await privateFileId();
      await authenticate(page, `/admin/files/${id}`);
      const note = page.locator(".url-note");
      await expect(note).toBeVisible();
      const metrics = await note.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          left: element.getBoundingClientRect().left,
          textLeft:
            element.getBoundingClientRect().left +
            Number.parseFloat(style.paddingLeft),
        };
      });
      // The intended inset (8px 24px 12px) must win the cascade against the
      // .admin-root paragraph reset; the text must not start at the viewport
      // edge.
      expect(metrics.paddingLeft).toBe("24px");
      expect(metrics.paddingRight).toBe("24px");
      expect(metrics.textLeft).toBeGreaterThanOrEqual(16);
    });
  }
});
