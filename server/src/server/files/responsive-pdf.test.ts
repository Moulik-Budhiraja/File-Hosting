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
    browser: await type.launch({ headless: true, executablePath }),
  });
}

before(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pdf-responsive-"));
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
});

after(async () => {
  await Promise.all(browsers.map(({ browser }) => browser.close()));
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

async function assertResponsive(
  browser: Browser,
  html: string,
  width: number,
): Promise<void> {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
    isMobile: width <= 430,
  });
  try {
    const cspHtml = html.replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CONTENT_SECURITY_POLICY}">`,
    );
    await page.setContent(cspHtml, { waitUntil: "load" });
    const metrics = await page.evaluate<ResponsiveMetrics>(`(() => {
      const root = document.documentElement;
      const viewportWidth = window.visualViewport?.width ?? root.clientWidth;
      const selectors = [".pdf-page-shell", ".raw-action", ".metadata", ".file-title", ".metadata-row:last-child dd"];
      const rectangles = Object.fromEntries(selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error("missing " + selector);
        const rect = element.getBoundingClientRect();
        return [selector, {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }];
      }));
      const image = document.querySelector(".pdf-page-preview");
      if (!image) throw new Error("missing fitted PDF first-page image");
      const imageRect = image.getBoundingClientRect();
      const sha = [...document.querySelectorAll(".metadata-row")].find(
        (row) => row.querySelector("dt")?.textContent === "SHA-256",
      )?.querySelector("dd");
      if (!sha) throw new Error("missing SHA-256 metadata row");
      const shaStyle = getComputedStyle(sha);
      return {
        viewportWidth,
        rootScrollWidth: root.scrollWidth,
        rootClientWidth: root.clientWidth,
        shellRect: rectangles[".pdf-page-shell"],
        image: {
          left: imageRect.left,
          right: imageRect.right,
          width: imageRect.width,
          height: imageRect.height,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
        },
        action: rectangles[".raw-action"],
        metadata: rectangles[".metadata"],
        title: rectangles[".file-title"],
        sha: {
          ...rectangles[".metadata-row:last-child dd"],
          overflowWrap: shaStyle.overflowWrap,
          wordBreak: shaStyle.wordBreak,
          whiteSpace: shaStyle.whiteSpace,
        },
      };
    })()`);

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
  } finally {
    await page.close();
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
    const pages = [await htmlFor("portrait"), await htmlFor("landscape")];
    for (const { browser } of browsers) {
      for (const html of pages) {
        for (const width of widths)
          await assertResponsive(browser, html, width);
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
    for (const { browser } of browsers) {
      await assert.rejects(() => assertResponsive(browser, fixedWidth, 390));
      await assert.rejects(() =>
        assertResponsive(browser, unbreakableHash, 320),
      );
    }
  });
});
