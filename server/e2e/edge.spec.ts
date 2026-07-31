// Edge-case and hardening coverage: maximum-length user-controlled strings,
// security headers, dialog focus semantics, touch targets, stale-data
// presentation, zero-byte previews, and the archive filter. Fixtures created
// here are removed again in afterAll so the primary fixture counts that
// admin.spec.ts asserts stay valid for reruns.
import http from "node:http";

import { expect, test, type Page } from "@playwright/test";

import { ensureSeeded } from "./seed.mjs";

const TOKEN = process.env.FS_E2E_TOKEN ?? "e2e-dashboard-fixture-token";
const BASE = `http://127.0.0.1:${Number(process.env.FS_E2E_PORT ?? 4610)}`;

// 255 unbroken bytes — the server's exact filename limit.
const LONG_NAME = `l${"o".repeat(250)}.bin`;
// 20 tags (the server maximum), the first at the 64-byte tag limit.
const MAX_TAGS = Array.from({ length: 20 }, (_, index) =>
  index === 0 ? "t".padEnd(64, "x") : `edge-tag-${index}`,
);
const EMPTY_NAME = "edge-empty-notes.txt";
const ARCHIVE_NAME = "edge-bundle-export.tar.gz";

const createdIds: string[] = [];

async function apiUpload(options: {
  name: string;
  body: string;
  tags?: string[];
  isPrivate?: boolean;
  archive?: "tar.gz";
  mime?: string;
}): Promise<string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    // The header contract keeps metadata out of the URL and access logs.
    "x-fs-name": encodeURIComponent(options.name),
  };
  if (options.tags?.length)
    headers["x-fs-tags"] = options.tags
      .map((tag) => encodeURIComponent(tag))
      .join(",");
  if (options.isPrivate) headers["x-fs-private"] = "true";
  if (options.archive) headers["x-fs-archive"] = options.archive;
  if (options.mime) headers["content-type"] = options.mime;
  const response = await fetch(`${BASE}/api/files`, {
    method: "POST",
    headers,
    body: options.body,
  });
  if (response.status !== 201)
    throw new Error(`fixture upload failed: ${response.status}`);
  const body = (await response.json()) as { id: string };
  createdIds.push(body.id);
  return body.id;
}

let longId = "";
let emptyId = "";
let archiveId = "";

test.beforeAll(async () => {
  await ensureSeeded(BASE, TOKEN);
  if (createdIds.length > 0) return;
  longId = await apiUpload({
    name: LONG_NAME,
    body: "payload",
    tags: MAX_TAGS,
  });
  emptyId = await apiUpload({
    name: EMPTY_NAME,
    body: "",
    isPrivate: true,
    mime: "text/plain",
  });
  archiveId = await apiUpload({
    name: ARCHIVE_NAME,
    body: "not-really-gzip-but-metadata-is-real",
    archive: "tar.gz",
    mime: "application/gzip",
  });
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

async function bodyOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.body.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe("security headers", () => {
  test("admin responses carry frame protections and hide X-Powered-By", async ({
    request,
  }) => {
    const response = await request.get("/admin");
    const headers = response.headers();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  test("API responses are frame-protected and hide X-Powered-By", async ({
    request,
  }) => {
    const response = await request.get("/api/system", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["x-powered-by"]).toBeUndefined();
  });
});

test.describe("maximum-length user-controlled strings", () => {
  for (const width of [360, 390, 430, 768, 1440]) {
    test(`255-byte name and max tags do not overflow at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await authenticate(page, "/admin/files");
      await page.getByLabel("search").fill("loooo");
      await expect(page.locator("tbody tr")).toHaveCount(1);
      expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);

      await page.goto(`/admin/files/${longId}`);
      await authenticate(page, `/admin/files/${longId}`);
      await expect(
        page.getByRole("heading", { name: LONG_NAME }),
      ).toBeVisible();
      // Tag chips at the 64-byte limit render fully without overflow.
      await expect(page.getByText("t".padEnd(64, "x"))).toBeVisible();
      expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
      // Actions stay on screen.
      const deleteButton = page.getByRole("button", { name: "Delete" });
      await deleteButton.scrollIntoViewIfNeeded();
      const box = await deleteButton.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    });
  }

  test("mobile rows expose the object id and full accessible name", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await authenticate(page, "/admin/files");
    await page.getByLabel("search").fill("telemetry-batch");
    await expect(page.locator("tbody tr").first()).toBeVisible();
    // Similarly prefixed truncated rows are distinguishable via the id line.
    const idLines = page.locator(".cell-name-id");
    await expect(idLines.first()).toBeVisible();
    const ids = await idLines.allTextContents();
    expect(new Set(ids).size).toBe(ids.length);
    // The full untruncated name stays available to assistive technology.
    const firstLink = page.locator(".cell-name a").first();
    await expect(firstLink).toHaveAttribute(
      "aria-label",
      /telemetry-batch-04\d\d\.parquet/,
    );
    // Visibility is not communicated by color alone at narrow widths.
    await expect(page.locator(".vis-text-short").first()).toHaveText(/pub|prv/);
  });
});

test.describe("dialog focus semantics", () => {
  test("upload dialog: initial focus, Escape, invoker restoration, busy protection", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    const uploadButton = page.getByRole("button", { name: "Upload" }).first();
    await uploadButton.click();
    const dialog = page.locator("dialog");
    await expect(dialog).toBeVisible();
    // Initial focus lands inside the dialog.
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("dialog")),
    ).toBe(true);
    // Tab stays trapped inside the native modal dialog.
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => !!document.activeElement?.closest("dialog")),
      ).toBe(true);
    }
    // Escape closes and restores focus to the invoker.
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(uploadButton).toBeFocused();

    // While an upload is in flight, Escape must NOT dismiss the dialog.
    await page.route("**/api/files", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return route.fallback();
    });
    await uploadButton.click();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "busy-escape.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("busy"),
    });
    await dialog.getByRole("button", { name: "Upload" }).click();
    await expect(
      dialog.getByRole("button", { name: "Uploading …" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    // After completion the dialog closes on its own.
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    await page.unroute("**/api/files");
    // Remove the object the busy test created.
    const search = await fetch(`${BASE}/api/files?q=busy-escape&limit=10`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const found = (await search.json()) as { items: { id: string }[] };
    for (const item of found.items) {
      await fetch(`${BASE}/api/files/${item.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
    }
  });

  test("confirm dialog restores focus to the Delete invoker on cancel", async ({
    page,
  }) => {
    await authenticate(page, `/admin/files/${longId}`);
    const deleteButton = page.getByRole("button", { name: "Delete" });
    await deleteButton.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(deleteButton).toBeFocused();
  });
});

test.describe("touch target sizes", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("primary, segment, pager, and copy controls are at least 44px tall", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const controls = [
      page.getByRole("button", { name: "Upload" }).first(),
      page.getByRole("button", { name: "Refresh" }),
      page
        .getByRole("group", { name: "Visibility filter" })
        .getByRole("button", { name: "Public" }),
      page.getByRole("button", { name: "next →" }),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box, "control must be visible").not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    // Inspector: copy buttons and the destructive Delete.
    await page.goto(`/admin/files/${archiveId}`);
    await authenticate(page, `/admin/files/${archiveId}`);
    for (const control of [
      page.getByRole("button", { name: "Copy preview URL" }),
      page.getByRole("button", { name: "Delete" }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("stale data presentation", () => {
  test("failed refresh keeps the table with a prominent stale banner", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    await expect(page.locator("tbody tr").first()).toBeVisible();
    // Break the next list request, then refresh explicitly.
    await page.route("**/api/files?**", (route) => route.abort());
    await page.getByRole("button", { name: "Refresh" }).click();
    const banner = page.locator(".state-stale");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/stale data/i);
    await expect(banner).toContainText(/last successful load/i);
    // Retained rows stay visible — never silently hidden.
    await expect(page.locator("tbody tr").first()).toBeVisible();
    // Recovery clears the banner.
    await page.unroute("**/api/files?**");
    await banner.getByRole("button", { name: "Retry" }).click();
    await expect(banner).not.toBeVisible();
  });
});

test.describe("active transfer lifecycle", () => {
  test("a current upload appears live and is removed after completion", async ({
    page,
  }) => {
    await authenticate(page, "/admin");
    const transferName = "browser-active-upload.bin";
    let request!: http.ClientRequest;
    const completed = new Promise<{ status: number; id: string }>(
      (resolve, reject) => {
        request = http.request(
          `${BASE}/api/files`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/octet-stream",
              "content-length": "1024",
              "x-fs-name": encodeURIComponent(transferName),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
              const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                id: string;
              };
              resolve({ status: response.statusCode ?? 0, id: body.id });
            });
          },
        );
        request.on("error", reject);
        request.write(Buffer.alloc(512));
      },
    );

    const transfers = page.getByRole("region", { name: "Active transfers" });
    const row = transfers.locator("tbody tr").filter({
      hasText: transferName,
    });
    try {
      await expect(row).toBeVisible({ timeout: 5_000 });
    } finally {
      if (!request.writableEnded) request.end(Buffer.alloc(512));
    }
    const uploaded = await completed;
    expect(uploaded.status).toBe(201);
    createdIds.push(uploaded.id);
    await expect(row).toHaveCount(0, { timeout: 5_000 });
    await expect(
      transfers.getByText(/none in flight right now/i),
    ).toBeVisible();
  });
});

test.describe("system page truthfulness", () => {
  test("healthcheck and log rows are labelled as compose defaults; CLI examples are valid", async ({
    page,
  }) => {
    await authenticate(page, "/admin/system");
    await expect(page.getByText("Docker healthcheck")).toBeVisible();
    const composeLabels = page.getByText(
      "compose.yaml default; runtime unverified",
    );
    await expect(composeLabels.first()).toBeVisible();
    // Never an invented last-pass time or runtime log status.
    await expect(page.getByText(/last pass/)).toHaveCount(0);
    await expect(
      page.getByText("$ fs find --name '*.parquet' --tag ingest"),
    ).toBeVisible();
    await expect(
      page.getByText("$ fs up ./batch.parquet --tag ingest"),
    ).toBeVisible();
    // The old invalid examples are gone.
    await expect(page.getByText(/fs list "datasets/)).toHaveCount(0);
    await expect(page.getByText(/9f2c41d7/)).toHaveCount(0);
  });

  test("mobile healthcheck detail and provenance use readable full-width lines", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await authenticate(page, "/admin/system");
    const row = page.locator(".status-row").filter({
      has: page.getByText("Docker healthcheck", { exact: true }),
    });
    const detailBox = await row.locator(".status-detail").boundingBox();
    const sourceBox = await row.locator(".status-source").boundingBox();
    expect(detailBox?.width).toBeGreaterThanOrEqual(300);
    expect(sourceBox?.width).toBeGreaterThanOrEqual(300);
  });
});

test.describe("previews", () => {
  test("zero-byte private text objects preview truthfully with no raw fetch", async ({
    page,
  }) => {
    const rawRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/raw/${emptyId}`))
        rawRequests.push(request.url());
    });
    await authenticate(page, `/admin/files/${emptyId}`);
    await expect(
      page.getByText("empty file — 0 bytes, nothing to preview"),
    ).toBeVisible();
    // Both URLs explain the bearer-header limitation for private objects.
    await expect(page.getByText(/address bar cannot attach it/)).toBeVisible();
    expect(rawRequests).toEqual([]);
  });

  test("a stable object produces exactly one preview request", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    const rawRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/raw/")) rawRequests.push(request.url());
    });
    await page.getByRole("link", { name: "onboarding-runbook.md" }).click();
    await expect(page.locator(".preview-body pre")).toContainText(
      "Onboarding runbook",
    );
    await page.waitForTimeout(400);
    expect(rawRequests.length).toBe(1);
  });

  test("clipboard pending state prevents duplicate writes and reports success", async ({
    page,
  }) => {
    await authenticate(page, `/admin/files/${emptyId}`);
    await page.evaluate(() => {
      let resolveWrite!: () => void;
      const pendingWrite = new Promise<void>((resolve) => {
        resolveWrite = resolve;
      });
      const state = window as unknown as {
        clipboardCalls: number;
        resolveClipboard: () => void;
      };
      state.clipboardCalls = 0;
      state.resolveClipboard = resolveWrite;
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: () => {
          state.clipboardCalls += 1;
          return pendingWrite;
        },
      });
    });
    const copy = page.getByRole("button", { name: "Copy preview URL" });
    await copy.click();
    await expect(copy).toBeDisabled();
    await expect(copy).toHaveText("copying …");
    await copy.click({ force: true });
    expect(
      await page.evaluate(
        () => (window as unknown as { clipboardCalls: number }).clipboardCalls,
      ),
    ).toBe(1);
    await page.evaluate(() =>
      (
        window as unknown as { resolveClipboard: () => void }
      ).resolveClipboard(),
    );
    await expect(copy).toHaveText("copied");
  });
});

test.describe("archive metadata", () => {
  test("archive filter narrows end-to-end and the inspector shows real state", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    const archiveGroup = page.getByRole("group", { name: "Archive filter" });
    await archiveGroup.getByRole("button", { name: "tar.gz" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr").first()).toContainText(ARCHIVE_NAME);
    await archiveGroup.getByRole("button", { name: "none" }).click();
    await expect(page.getByText(ARCHIVE_NAME)).toHaveCount(0);
    await archiveGroup.getByRole("button", { name: "Any" }).click();

    await page.goto(`/admin/files/${archiveId}`);
    await authenticate(page, `/admin/files/${archiveId}`);
    await expect(
      page.getByText("tar.gz — uploaded as a directory archive"),
    ).toBeVisible();
    await expect(
      page.getByText("archive/hide toggle · Proposed · Not implemented"),
    ).toBeVisible();
  });
});

test.describe("forced colors", () => {
  test("visibility keeps non-color meaning under forced colors", async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: 390, height: 844 });
    await authenticate(page, "/admin/files");
    // With OS high-contrast palettes the dots lose their meaning; the
    // abbreviated text label must still be present and readable.
    await expect(page.locator(".vis-text-short").first()).toHaveText(/pub|prv/);
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });
});

test.describe("contrast", () => {
  test("small slate text meets WCAG AA against its actual background", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    const ratio = await page.evaluate(() => {
      function luminance(color: string): number {
        const parts = color
          .match(/\d+(\.\d+)?/g)!
          .slice(0, 3)
          .map(Number);
        const channel = parts.map((value) => {
          const scaled = value / 255;
          return scaled <= 0.04045
            ? scaled / 12.92
            : ((scaled + 0.055) / 1.055) ** 2.4;
        });
        return (
          0.2126 * channel[0]! + 0.7152 * channel[1]! + 0.0722 * channel[2]!
        );
      }
      function background(element: Element): string {
        let node: Element | null = element;
        while (node) {
          const value = getComputedStyle(node).backgroundColor;
          if (value && !value.includes("0, 0, 0, 0")) return value;
          node = node.parentElement;
        }
        return "rgb(16, 18, 20)";
      }
      const sample = document.querySelector(".filter-note")!;
      const fg = luminance(getComputedStyle(sample).color);
      const bg = luminance(background(sample));
      const [lighter, darker] = fg > bg ? [fg, bg] : [bg, fg];
      return (lighter + 0.05) / (darker + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
