import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  chromium,
  webkit,
  type Browser,
  type BrowserType,
  type Page,
} from "playwright-core";

import type { FileService } from "./service";
import type { StoredFile } from "./types";
import { PREVIEW_CONTENT_SECURITY_POLICY, renderPreview } from "./preview";

const widths = [320, 375, 390, 430, 768, 1280] as const;
const webkitInstalled = existsSync(webkit.executablePath());
interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  clientWidth: number;
  scrollWidth: number;
}
interface ResponsiveMetrics {
  viewportWidth: number;
  rootScrollWidth: number;
  rootClientWidth: number;
  shellRect: Bounds;
  image: Bounds & { naturalWidth: number; naturalHeight: number };
  action: Bounds;
  metadata: Bounds;
  title: Bounds;
  sha: Bounds & { overflowWrap: string; wordBreak: string; whiteSpace: string };
}
const browsers: Array<{ name: string; browser: Browser }> = [];
let temporaryRoot = "";

async function bounded<T>(
  label: string,
  operation: Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pdf(
  width: number,
  height: number,
  title: string,
): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([width, height]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(title, { x: 36, y: height - 64, size: 26, font });
  page.drawText("Responsive first-page fixture", {
    x: 36,
    y: height - 104,
    size: 15,
    font,
  });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function htmlFor(orientation: "portrait" | "landscape"): Promise<string> {
  const bytes =
    orientation === "portrait"
      ? await pdf(612, 792, "Portrait PDF")
      : await pdf(792, 500, "Landscape PDF");
  const objectPath = path.join(temporaryRoot, `${orientation}.pdf`);
  await writeFile(objectPath, bytes);
  const file: StoredFile = {
    id: orientation === "portrait" ? "PdfP001" : "PdfL001",
    name: `${"研究-long-name-".repeat(20)}${orientation}.pdf`,
    size: bytes.length,
    mimeType: "application/pdf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    visibility: "public",
    ownerId: null,
    storageKey: `${orientation}.pdf`,
    archive: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    tags: ["Unicode-研究", "x".repeat(160)],
  };
  const service = {
    storagePath: () => objectPath,
  } as unknown as FileService;
  return renderPreview(service, file);
}

function installedExecutable(type: BrowserType): string | null {
  const managed = type.executablePath();
  if (existsSync(managed)) return managed;
  if (type === chromium) {
    const systemCandidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ];
    return systemCandidates.find(existsSync) ?? null;
  }
  return null;
}

async function launch(name: string, type: BrowserType): Promise<void> {
  const executablePath = installedExecutable(type);
  if (!executablePath) return;
  browsers.push({
    name,
    browser: await type.launch({
      headless: true,
      executablePath,
      timeout: 30_000,
    }),
  });
}

before(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pdf-responsive-"));
  try {
    await launch("chromium", chromium);
    await launch("webkit", webkit);
    assert(
      browsers.some(({ name }) => name === "chromium"),
      "Chromium is required",
    );
    if (webkitInstalled)
      assert(
        browsers.some(({ name }) => name === "webkit"),
        "WebKit must run when installed",
      );
  } catch (error) {
    await Promise.allSettled(
      browsers.map(({ browser, name }) =>
        bounded(`${name} browser cleanup`, browser.close()),
      ),
    );
    browsers.length = 0;
    throw error;
  }
});

after(async () => {
  const closeResults = await Promise.allSettled(
    browsers.map(({ browser, name }) =>
      bounded(`${name} browser cleanup`, browser.close()),
    ),
  );
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  const closeFailures = closeResults.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (closeFailures.length > 0)
    throw new AggregateError(
      closeFailures.map(({ reason }) =>
        reason instanceof Error ? reason : new Error("browser close failed"),
      ),
      "failed to close responsive PDF browsers",
    );
});

async function loadPreview(
  page: Page,
  html: string,
  label: string,
): Promise<ResponsiveMetrics> {
  const cspHtml = html.replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CONTENT_SECURITY_POLICY}">`,
  );
  try {
    // WebKit's setContent lifecycle waits on an unrelated fixed delay in the
    // macOS test runtime. Write the same document directly, then gate on the
    // product-owned image state rather than a generic page lifecycle event.
    return await bounded(
      `${label}: document write and preview readiness`,
      page.evaluate(async (documentHtml) => {
        document.open();
        document.write(documentHtml);
        document.close();
        const image =
          document.querySelector<HTMLImageElement>(".pdf-page-preview");
        if (!image) throw new Error("missing fitted PDF first-page image");
        if (!(
          image.complete &&
          image.naturalWidth > 1 &&
          image.naturalHeight > 1
        ))
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("PDF preview image did not become ready")),
              25_000,
            );
            image.addEventListener(
              "load",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
            image.addEventListener(
              "error",
              () => {
                clearTimeout(timer);
                reject(new Error("PDF preview image failed to load"));
              },
              { once: true },
            );
          });
        const root = document.documentElement;
        const viewportWidth = window.visualViewport?.width ?? root.clientWidth;
        const selectors = [
          ".pdf-page-shell",
          ".raw-action",
          ".metadata",
          ".file-title",
          ".metadata-row:last-child dd",
        ];
        const rectangles = Object.fromEntries(
          selectors.map((selector) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`missing ${selector}`);
            const rect = element.getBoundingClientRect();
            return [
              selector,
              {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
              },
            ];
          }),
        );
        const imageRect = image.getBoundingClientRect();
        const sha = [...document.querySelectorAll(".metadata-row")]
          .find((row) => row.querySelector("dt")?.textContent === "SHA-256")
          ?.querySelector("dd");
        if (!sha) throw new Error("missing SHA-256 metadata row");
        const shaStyle = getComputedStyle(sha);
        return {
          viewportWidth,
          rootScrollWidth: root.scrollWidth,
          rootClientWidth: root.clientWidth,
          shellRect: rectangles[".pdf-page-shell"] as Bounds,
          image: {
            left: imageRect.left,
            right: imageRect.right,
            top: imageRect.top,
            bottom: imageRect.bottom,
            width: imageRect.width,
            height: imageRect.height,
            clientWidth: image.clientWidth,
            scrollWidth: image.scrollWidth,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
          },
          action: rectangles[".raw-action"] as Bounds,
          metadata: rectangles[".metadata"] as Bounds,
          title: rectangles[".file-title"] as Bounds,
          sha: {
            ...(rectangles[".metadata-row:last-child dd"] as Bounds),
            overflowWrap: shaStyle.overflowWrap,
            wordBreak: shaStyle.wordBreak,
            whiteSpace: shaStyle.whiteSpace,
          },
        } satisfies ResponsiveMetrics;
      }, cspHtml),
    );
  } catch (error) {
    throw new Error(`failed to load intended PDF preview state (${label})`, {
      cause: error,
    });
  }
}

function assertResponsive(
  metrics: ResponsiveMetrics,
  width: number,
  label: string,
): void {
  try {
    const inside = (rect: { left: number; right: number }) =>
      rect.left >= -0.5 && rect.right <= metrics.viewportWidth + 0.5;
    assert(metrics.rootScrollWidth <= metrics.viewportWidth + 0.5);
    assert(metrics.rootScrollWidth <= metrics.rootClientWidth + 0.5);
    assert(inside(metrics.shellRect));
    assert(inside(metrics.image));
    assert(inside(metrics.action));
    assert(inside(metrics.metadata));
    assert(inside(metrics.title));
    assert(inside(metrics.sha));
    assert(metrics.image.left >= metrics.shellRect.left - 0.5);
    assert(metrics.image.right <= metrics.shellRect.right + 0.5);
    assert(metrics.image.naturalWidth > 1 && metrics.image.naturalHeight > 1);
    const naturalRatio =
      metrics.image.naturalWidth / metrics.image.naturalHeight;
    const cssRatio = metrics.image.width / metrics.image.height;
    assert(Math.abs(naturalRatio - cssRatio) < 0.02);
    assert(metrics.action.height >= 44);
    assert.equal(metrics.sha.overflowWrap, "anywhere");
    assert.notEqual(metrics.sha.whiteSpace, "nowrap");
    assert(metrics.sha.scrollWidth <= metrics.sha.clientWidth + 1);
  } catch (error) {
    throw new Error(`responsive PDF assertion failed (${label}, ${width}px)`, {
      cause: error,
    });
  }
}

describe("responsive PDF share page", () => {
  it("runs Chromium coverage", () => {
    assert(browsers.some(({ name }) => name === "chromium"));
  });

  it(
    "runs WebKit coverage when the engine is installed",
    { skip: !webkitInstalled },
    () => {
      assert(browsers.some(({ name }) => name === "webkit"));
    },
  );

  it("fits portrait and landscape first pages with all metadata at every supported width", async () => {
    const pages = [
      { orientation: "portrait", html: await htmlFor("portrait") },
      { orientation: "landscape", html: await htmlFor("landscape") },
    ] as const;
    for (const { name, browser } of browsers) {
      const cases = pages.flatMap(({ orientation, html }) =>
        widths.map((width) => ({ orientation, html, width })),
      );
      for (let start = 0; start < cases.length; start += 3) {
        await Promise.all(
          cases
            .slice(start, start + 3)
            .map(async ({ orientation, html, width }) => {
              const label = `${name}/${orientation}/${width}px`;
              const page = await bounded(
                `${label}: page creation`,
                browser.newPage({
                  viewport: { width, height: 900 },
                  deviceScaleFactor: 2,
                  isMobile: width <= 430,
                }),
              );
              page.setDefaultTimeout(30_000);
              try {
                const metrics = await loadPreview(page, html, label);
                assertResponsive(metrics, width, label);
              } finally {
                await bounded(`${label}: page cleanup`, page.close());
              }
            }),
        );
      }
    }
  });

  it("rejects fixed-width PDF and unbreakable-hash mutants in every available engine", async () => {
    const html = await htmlFor("portrait");
    const fixedWidth = html.replace(
      "</style>",
      ".pdf-page-preview{width:800px!important;max-width:none!important}</style>",
    );
    const unbreakableHash = html.replace(
      "</style>",
      ".metadata-break{white-space:nowrap!important;overflow-wrap:normal!important;word-break:normal!important}</style>",
    );
    for (const { name, browser } of browsers) {
      for (const { mutant, width, html: mutantHtml } of [
        { mutant: "fixed-width", width: 390, html: fixedWidth },
        { mutant: "unbreakable-hash", width: 320, html: unbreakableHash },
      ] as const) {
        const label = `${name}/${mutant}-mutant`;
        const page = await bounded(
          `${label}: page creation`,
          browser.newPage({
            viewport: { width, height: 900 },
            deviceScaleFactor: 2,
            isMobile: true,
          }),
        );
        page.setDefaultTimeout(30_000);
        try {
          const metrics = await loadPreview(page, mutantHtml, label);
          assert.throws(() => assertResponsive(metrics, width, label));
        } finally {
          await bounded(`${label}: page cleanup`, page.close());
        }
      }
    }
  });
});
