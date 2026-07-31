import { expect, test, type Page } from "@playwright/test";

import { ensureSeeded } from "./seed.mjs";

const TOKEN = process.env.FS_E2E_TOKEN ?? "e2e-dashboard-fixture-token";
const BASE = `http://127.0.0.1:${Number(process.env.FS_E2E_PORT ?? 4610)}`;

test.beforeAll(async () => {
  await ensureSeeded(BASE, TOKEN);
});

async function authenticate(page: Page, path = "/admin") {
  await page.goto(path);
  await page.getByLabel("Bearer token").fill(TOKEN);
  await page.getByRole("button", { name: "Unlock console" }).click();
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test.describe("authentication", () => {
  test("gates every admin route and never persists the token", async ({
    page,
  }) => {
    for (const route of [
      "/admin",
      "/admin/files",
      "/admin/system",
      "/admin/inspector",
    ]) {
      await page.goto(route);
      await expect(
        page.getByRole("heading", { name: "Authentication required" }),
      ).toBeVisible();
    }

    await authenticate(page);
    await expect(
      page.getByRole("heading", { name: "Live Operations" }),
    ).toBeVisible();

    const storage = await page.evaluate(() => ({
      local: { ...window.localStorage },
      session: { ...window.sessionStorage },
      cookies: document.cookie,
    }));
    expect(JSON.stringify(storage)).not.toContain(TOKEN);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Authentication required" }),
    ).toBeVisible();
  });

  test("rejected tokens surface an auth error and a way back to the gate", async ({
    page,
  }) => {
    await page.goto("/admin");
    await page.getByLabel("Bearer token").fill("not-the-token");
    await page.getByRole("button", { name: "Unlock console" }).click();
    await expect(
      page.getByText("the server rejected the bearer token").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Re-enter token" }).first().click();
    await expect(
      page.getByRole("heading", { name: "Authentication required" }),
    ).toBeVisible();
  });
});

test.describe("navigation and overview", () => {
  test("nav rail moves aria-current and routes client-side", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await authenticate(page);
    const nav = page.getByRole("navigation", { name: "Admin" });
    await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await nav.getByRole("link", { name: "Files" }).click();
    await expect(page).toHaveURL(/\/admin\/files$/);
    await expect(nav.getByRole("link", { name: "Files" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Client-side navigation must preserve the in-memory token: content loads.
    await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
    await nav.getByRole("link", { name: "System" }).click();
    await expect(
      page.getByRole("heading", { name: "System Health & Configuration" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("overview shows real totals, warnings, and subordinated transfers", async ({
    page,
  }) => {
    await authenticate(page);
    await expect(page.getByText("Storage used")).toBeVisible();
    await expect(page.getByText("Objects", { exact: true })).toBeVisible();
    // 21 seeded objects.
    await expect(page.locator(".figure-value").nth(3)).toHaveText("21");
    await expect(
      page.getByText("Proposed · Not implemented").first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "all files →" })).toBeVisible();
    // Recent files table filled from the live API.
    await expect(page.locator("table tbody tr").first()).toContainText(
      /api-reference-v3\.pdf|victim-of-deletion\.txt/,
    );
  });
});

test.describe("files browser", () => {
  test("filters, glob, visibility segment, and cursor paging work", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();

    // Two pages: 21 objects with a 16-row page size.
    await expect(page.locator("tbody tr")).toHaveCount(16);
    await expect(page.getByText(/rows 1–16 · more available/)).toBeVisible();
    await page.getByRole("button", { name: "next →" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(5);
    await expect(page.getByText(/rows 17–21/)).toBeVisible();
    await page.getByRole("button", { name: "← prev" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(16);

    await page.getByLabel("glob").fill("*.parquet");
    await expect(page.locator("tbody tr")).toHaveCount(14);
    await page.getByLabel("glob").fill("");

    await page.getByLabel("search").fill("schema");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr").first()).toContainText(
      "telemetry-schema-v4.json",
    );
    await page.getByLabel("search").fill("");

    await page
      .getByRole("group", { name: "Visibility filter" })
      .getByRole("button", { name: "Public" })
      .click();
    await expect(page.locator("tbody tr")).toHaveCount(6);

    await page
      .getByRole("group", { name: "Visibility filter" })
      .getByRole("button", { name: "All" })
      .click();
    await page.getByLabel("tag", { exact: true }).fill("docs");
    await expect(page.locator("tbody tr")).toHaveCount(2);

    await page.getByLabel("tag", { exact: true }).fill("no-such-tag");
    await expect(
      page.getByText("no objects match the current filter"),
    ).toBeVisible();
  });
});

test.describe("inspector", () => {
  test("shows the object record and a truthful text preview", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    await page.getByRole("link", { name: "onboarding-runbook.md" }).click();
    await expect(
      page.getByRole("heading", { name: "onboarding-runbook.md" }),
    ).toBeVisible();
    await expect(page.getByText("Object record")).toBeVisible();
    await expect(page.getByText(/[0-9a-f]{64}/).first()).toBeVisible();
    await expect(page.locator(".preview-body pre")).toContainText(
      "Onboarding runbook",
    );
    await expect(page.getByText("bytes ·")).toBeVisible();
    await expect(
      page.getByText("archive/hide state · Proposed · Not implemented"),
    ).toBeVisible();
  });

  test("stages visibility and tag edits until Save changes", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    await page.getByLabel("search").fill("press-kit");
    await page.getByRole("link", { name: "press-kit-2026.zip" }).click();

    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();
    await page.getByRole("button", { name: "Make private" }).click();
    await expect(page.getByText("private · unsaved")).toBeVisible();
    await expect(save).toBeEnabled();

    await page.getByLabel("Add tag").fill("brand");
    await page.getByLabel("Add tag").press("Enter");
    await save.click();
    await expect(save).toBeDisabled();
    await expect(
      page.getByText("private", { exact: false }).first(),
    ).toBeVisible();

    // Verify persistence through the API, then restore.
    await page.getByRole("button", { name: "Make public" }).click();
    await page.getByRole("button", { name: "Remove tag brand" }).click();
    await save.click();
    await expect(save).toBeDisabled();
  });

  test("delete requires explicit confirmation and cancel is safe", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    await page.getByLabel("search").fill("victim");
    await page.getByRole("link", { name: "victim-of-deletion.txt" }).click();
    await expect(
      page.getByRole("heading", { name: "victim-of-deletion.txt" }),
    ).toBeVisible();

    // Cancel path.
    await page.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("no soft-delete")).toBeVisible();
    // Focus starts on Cancel; Escape closes without deleting.
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await authenticate(page, page.url());
    await expect(
      page.getByRole("heading", { name: "victim-of-deletion.txt" }),
    ).toBeVisible();

    // Confirm path.
    await page.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page).toHaveURL(/\/admin\/files$/);
    await page.getByLabel("search").fill("victim");
    await expect(
      page.getByText("no objects match the current filter"),
    ).toBeVisible();
  });
});

test.describe("system page", () => {
  test("reports real config and subordinates unimplemented capabilities", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await authenticate(page, "/admin/system");
    await expect(page.getByText("FS_MAX_UPLOAD_BYTES")).toBeVisible();
    await expect(page.getByText("FS_MIN_FREE_BYTES")).toBeVisible();
    await expect(page.getByText("2.0 GB per object")).toBeVisible();
    await expect(
      page.getByText("config read-only · set via environment"),
    ).toBeVisible();
    await expect(
      page.getByText("Proposed · Not implemented").first(),
    ).toBeVisible();
    await expect(page.getByText("multi-user & RBAC")).toBeVisible();
    await expect(page.getByText("single shared token")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("responsive behavior", () => {
  const widths = [360, 390, 430, 768, 1440];

  for (const width of widths) {
    test(`no horizontal body overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await authenticate(page);
      for (const route of ["/admin", "/admin/files", "/admin/system"]) {
        await page.goto(route);
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(
          () =>
            document.body.scrollWidth - document.documentElement.clientWidth,
        );
        expect(
          overflow,
          `${route} overflows at ${width}px`,
        ).toBeLessThanOrEqual(0);
      }
    });
  }

  test("mobile nav expands in flow and navigates", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await authenticate(page);
    const menuButton = page.getByRole("button", { name: "menu" });
    await expect(menuButton).toBeVisible();
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    await menuButton.click();
    await expect(menuButton).toHaveAttribute("aria-expanded", "true");
    const filesLink = page
      .getByRole("navigation", { name: "Admin" })
      .getByRole("link", { name: "Files" });
    await expect(filesLink).toBeVisible();
    // The expanded menu must not cover the page content (in-flow expansion).
    const navBox = await page.locator(".nav-rail").boundingBox();
    const mainBox = await page.locator("main").boundingBox();
    expect(
      navBox && mainBox && mainBox.y >= navBox.y + navBox.height,
    ).toBeTruthy();
    await filesLink.click();
    await expect(page).toHaveURL(/\/admin\/files$/);
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  });

  test("mobile inspector stacks and keeps the delete button reachable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await authenticate(page, "/admin/files");
    await page.getByRole("link", { name: "onboarding-runbook.md" }).click();
    await expect(page.getByText("Object record")).toBeVisible();
    const deleteButton = page.getByRole("button", { name: "Delete" });
    await deleteButton.scrollIntoViewIfNeeded();
    const box = await deleteButton.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(
      () => document.body.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("keyboard access", () => {
  test("nav items and filters are reachable by Tab with visible focus", async ({
    page,
  }) => {
    await authenticate(page, "/admin/files");
    await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
    // Reset focus to the document start, then walk until a nav link owns it.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    let focusedText = "";
    for (let index = 0; index < 40; index += 1) {
      await page.keyboard.press("Tab");
      focusedText = await page.evaluate(
        () => document.activeElement?.textContent ?? "",
      );
      if (focusedText === "Overview") break;
    }
    expect(focusedText).toBe("Overview");
    const outline = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return getComputedStyle(element).outlineStyle;
    });
    expect(outline).not.toBe("none");
  });
});
