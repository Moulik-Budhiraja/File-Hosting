// Second-repair production E2E coverage: stale ephemeral state (transfers +
// System success cues), download cancellation phases, shared visibility
// labels, and coarse-pointer filter-control sizing. Runs against the real
// standalone production build like admin.spec.ts / edge.spec.ts.
import http from "node:http";

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

test.describe("visibility labels on every surface", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mobile shows the abbreviated label on Overview, Files, and Inspector", async ({
    page,
  }) => {
    // Overview recent files — previously the only surface without the
    // abbreviation, leaving mobile users with a color-only dot.
    await authenticate(page, "/admin");
    const overviewVis = page
      .getByRole("region", { name: "Recent files" })
      .locator(".cell-vis .vis-text-short")
      .first();
    await expect(overviewVis).toBeVisible();
    await expect(overviewVis).toHaveText(/^(pub|prv)$/);

    // Files list. (The token lives in tab memory only, so a full navigation
    // requires re-authentication.)
    await authenticate(page, "/admin/files");
    const filesVis = page.locator(".cell-vis .vis-text-short").first();
    await expect(filesVis).toBeVisible();
    await expect(filesVis).toHaveText(/^(pub|prv)$/);
    // The full word stays in the accessibility tree.
    await expect(page.locator(".cell-vis .vis-text").first()).toHaveText(
      /^(public|private)$/,
    );

    // Inspector object record.
    await page.locator(".cell-name a").first().click();
    const inspectorVis = page
      .locator(".meta-row .visibility-label .vis-text-short")
      .first();
    await expect(inspectorVis).toBeVisible();
    await expect(inspectorVis).toHaveText(/^(pub|prv)$/);
  });

  test("forced colors keeps non-color visibility meaning on all surfaces", async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await authenticate(page, "/admin");
    await expect(
      page
        .getByRole("region", { name: "Recent files" })
        .locator(".vis-text-short")
        .first(),
    ).toHaveText(/pub|prv/);
    await authenticate(page, "/admin/files");
    await expect(page.locator(".vis-text-short").first()).toHaveText(/pub|prv/);
    await page.locator(".cell-name a").first().click();
    await expect(
      page.locator(".meta-row .visibility-label .vis-text-short").first(),
    ).toHaveText(/pub|prv/);
  });
});

test.describe("coarse-pointer filter controls", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("every filter input, select, and button is at least 44px tall", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    // EVERY actual control in the filter bar — inputs and segment buttons —
    // not just wrappers or a sample.
    const controls = page.locator(
      ".filter-bar input, .filter-bar select, .filter-bar button",
    );
    const count = await controls.count();
    expect(count).toBeGreaterThanOrEqual(9); // 3 inputs + 6 segment buttons
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      const label = await control.evaluate(
        (element) =>
          element.id ||
          element.textContent ||
          (element as HTMLInputElement).placeholder,
      );
      expect(box, `${label} must be visible`).not.toBeNull();
      expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("download cancellation", () => {
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

  test("picker cancellation clears busy without fetching or failure copy", async ({
    page,
  }) => {
    const id = await uploadTarget("repair2-picker-cancel.bin");
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => {
          throw new DOMException("user cancelled", "AbortError");
        },
      });
    });
    let rawRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes(`/raw/${id}`)) rawRequests += 1;
    });
    await authenticate(page, `/admin/files/${id}`);
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Download", exact: true }),
    ).toBeEnabled();
    await expect(page.getByText(/download failed/i)).toHaveCount(0);
    expect(rawRequests).toBe(0);
  });

  test("stream write cancellation aborts a pending writer and clears busy", async ({
    page,
  }) => {
    const id = await uploadTarget("repair2-stream-write-cancel.bin");
    await page.addInitScript(() => {
      const state = window as typeof window & {
        __repairWriterStarted?: boolean;
        __repairWriterAborted?: boolean;
      };
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => ({
          createWritable: async () => ({
            write: async () => {
              state.__repairWriterStarted = true;
              await new Promise(() => undefined);
            },
            close: async () => undefined,
            abort: async () => {
              state.__repairWriterAborted = true;
            },
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
            (window as typeof window & { __repairWriterStarted?: boolean })
              .__repairWriterStarted,
          ),
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Cancel download" }).click();
    await expect(
      page.getByRole("button", { name: "Download", exact: true }),
    ).toBeEnabled();
    await expect(page.getByText(/download failed/i)).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        Boolean(
          (window as typeof window & { __repairWriterAborted?: boolean })
            .__repairWriterAborted,
        ),
      ),
    ).toBe(true);
  });

  test("fallback body assembly cancellation clears busy without failure copy", async ({
    page,
  }) => {
    const id = await uploadTarget("repair2-fallback-body-cancel.bin");
    await page.addInitScript((targetId) => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (!url.includes(`/raw/${targetId}`))
          return originalFetch(input, init);
        const state = window as typeof window & {
          __repairBlobStarted?: boolean;
        };
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            state.__repairBlobStarted = true;
            controller.enqueue(new Uint8Array(1024));
            init?.signal?.addEventListener(
              "abort",
              () =>
                controller.error(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(stream, { status: 200 });
      };
    }, id);
    await authenticate(page, `/admin/files/${id}`);
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            (window as typeof window & { __repairBlobStarted?: boolean })
              .__repairBlobStarted,
          ),
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Cancel download" }).click();
    await expect(
      page.getByRole("button", { name: "Download", exact: true }),
    ).toBeEnabled();
    await expect(page.getByText(/download failed/i)).toHaveCount(0);
  });

  test("cancelling a fallback download clears busy without failure copy", async ({
    page,
  }) => {
    // Force the bounded fallback path (no File System Access API) and slow
    // the raw response so Cancel can fire mid-establishment.
    await page.addInitScript(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const uploaded = await fetch(`${BASE}/api/files`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-fs-name": encodeURIComponent("repair2-cancel-target.bin"),
        "content-type": "application/octet-stream",
      },
      body: Buffer.alloc(64 * 1024),
    });
    expect(uploaded.status).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };
    createdIds.push(id);

    await authenticate(page, `/admin/files/${id}`);
    await page.route(`**/raw/${id}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await route.abort();
    });
    await page.getByRole("button", { name: "Download" }).click();
    const cancel = page.getByRole("button", { name: "Cancel download" });
    await expect(cancel).toBeVisible();
    await cancel.click();
    // Busy clears and no failure copy appears for ordinary cancellation.
    await expect(
      page.getByRole("button", { name: "Download", exact: true }),
    ).toBeEnabled({ timeout: 10_000 });
    await expect(cancel).toHaveCount(0);
    await expect(page.getByText(/download failed/i)).toHaveCount(0);
  });
});

test.describe("stale ephemeral state", () => {
  test("a completed transfer never lingers as streaming after the poll fails", async ({
    page,
  }) => {
    await authenticate(page, "/admin");
    const transferName = "repair2-stale-transfer.bin";
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
    const row = transfers.locator("tbody tr").filter({ hasText: transferName });
    try {
      // 1. Observe the transfer live.
      await expect(row).toBeVisible({ timeout: 5_000 });
      // 2. Fail every subsequent poll while the row is still retained data.
      await page.route("**/api/system", (route) => route.abort());
    } finally {
      // 3. Complete the upload — the server-side transfer ends, but the
      //    dashboard can no longer observe that.
      if (!request.writableEnded) request.end(Buffer.alloc(512));
    }
    const uploaded = await completed;
    expect(uploaded.status).toBe(201);
    createdIds.push(uploaded.id);

    // 4. The stale view must not render any retained row as streaming.
    await expect(page.locator(".state-stale")).toBeVisible({
      timeout: 10_000,
    });
    await expect(transfers.getByText(/streaming/)).toHaveCount(0);
    await expect(transfers.getByText(transferName)).toHaveCount(0);
    await expect(
      transfers.getByText(/live transfer view unavailable/i),
    ).toBeVisible();
    await expect(transfers.getByText(/last live data/i)).toBeVisible();
  });

  test("System page drops every green success cue when the refresh fails", async ({
    page,
  }) => {
    await page.clock.install();
    await authenticate(page, "/admin/system");
    // Fresh load: success cues are present.
    await expect(
      page.locator(".status-state .dot-success").first(),
    ).toBeVisible();
    const freshCount = await page.locator(".status-state .dot-success").count();
    expect(freshCount).toBeGreaterThanOrEqual(8);

    // Break the endpoint, then let the 30 s poll fire.
    await page.route("**/api/system", (route) => route.abort());
    await page.clock.fastForward("00:31");

    await expect(page.locator(".state-stale")).toBeVisible({ timeout: 10_000 });
    // No status row retains a green success/on cue from retained data.
    await expect(page.locator(".status-state .dot-success")).toHaveCount(0);
    await expect(
      page.getByText("configured · unverified").first(),
    ).toBeVisible();
    // Truthful subtitle: no current 200 claim.
    await expect(page.getByText(/data is stale/)).toBeVisible();
    await expect(page.getByText(/· 200 ·/)).toHaveCount(0);
  });
});

test.describe("production audit", () => {
  test("all views keep console, network, secrets, and clipping clean", async ({
    page,
  }) => {
    const errors: string[] = [];
    const failedRequests: string[] = [];
    const serverFailures: string[] = [];
    const requestUrls: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("request", (request) => requestUrls.push(request.url()));
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "unknown";
      // Next.js prefetches object links; full-route audit navigation cancels
      // those speculative requests intentionally.
      if (!reason.includes("ERR_ABORTED")) {
        failedRequests.push(`${reason} ${request.method()} ${request.url()}`);
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 500) {
        serverFailures.push(`${response.status()} ${response.url()}`);
      }
    });

    const routes = ["/admin", "/admin/files", "/admin/system"];
    for (const route of routes) {
      await authenticate(page, route);
      await page.waitForLoadState("networkidle");
      const metrics = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        body: document.body.innerText,
        local: Object.keys(localStorage).map((key) =>
          localStorage.getItem(key),
        ),
        session: Object.keys(sessionStorage).map((key) =>
          sessionStorage.getItem(key),
        ),
      }));
      expect(metrics.overflow, route).toBeLessThanOrEqual(1);
      expect(metrics.body).not.toContain(TOKEN);
      expect(metrics.local).not.toContain(TOKEN);
      expect(metrics.session).not.toContain(TOKEN);
    }

    await authenticate(page, "/admin/files");
    await page.locator("tbody tr").first().getByRole("link").click();
    await expect(page.getByText("Object record")).toBeVisible();
    const inspectorAudit = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.innerText,
    }));
    expect(inspectorAudit.overflow).toBeLessThanOrEqual(1);
    expect(inspectorAudit.body).not.toContain(TOKEN);

    expect(errors).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(serverFailures).toEqual([]);
    expect(requestUrls.some((url) => url.includes(TOKEN))).toBe(false);
  });
});
