import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";

import {
  composeOgCardSvg,
  renderOgImage,
  renderSvgInWorker,
  truncateDisplayText,
} from "./og-image";
import { runKillableProcess } from "./process-tree";
import type { FileService } from "./service";
import type { StoredFile } from "./types";
import { buildUnfurlModel } from "./unfurl";

const temporaryDirectories: string[] = [];

async function subject(bytes: Buffer, mimeType: string, name: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fs-og-v2-"));
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, "object");
  await writeFile(sourcePath, bytes);
  const file: StoredFile = {
    id: "Ab3dE5g",
    name,
    size: bytes.length,
    mimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    visibility: "public",
    ownerId: "synthetic-owner",
    storageKey: "synthetic-storage",
    archive: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    tags: [],
  };
  const service = {
    config: { publicUrl: "https://files.example.test" },
    storagePath: () => sourcePath,
  } as unknown as FileService;
  const model = await buildUnfurlModel(service, file);
  return {
    file,
    service,
    model,
    png: await renderOgImage(service, file, model),
  };
}

async function structuredPdf(
  width: number,
  height: number,
  color: { red: number; green: number; blue: number },
  title: string,
): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([width, height]);
  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height,
    color: rgb(0.97, 0.96, 0.92),
  });
  page.drawRectangle({
    x: 0,
    y: height - Math.max(72, height * 0.16),
    width,
    height: Math.max(72, height * 0.16),
    color: rgb(color.red, color.green, color.blue),
  });
  page.drawText(title, { x: 42, y: height - 58, size: 26 });
  for (let index = 0; index < 10; index += 1) {
    page.drawRectangle({
      x: 42,
      y: height - 130 - index * 42,
      width: Math.max(80, width - 84 - (index % 3) * 70),
      height: 12,
      color: rgb(0.2, 0.22, 0.24),
    });
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function nonDarkRatio(
  png: Buffer,
  region: { left: number; top: number; width: number; height: number },
): Promise<number> {
  const { data, info } = await sharp(png)
    .extract(region)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let nonDark = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (
      (data[offset] ?? 0) > 90 ||
      (data[offset + 1] ?? 0) > 90 ||
      (data[offset + 2] ?? 0) > 90
    ) {
      nonDark += 1;
    }
  }
  return nonDark / (region.width * region.height);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OG Social Cards V2 byte-derived rendering", () => {
  it("matches the second iMessage review geometry and effective type scale", async () => {
    const raster = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: "#b64f45" },
    })
      .png()
      .toBuffer();
    const base = {
      title: "Readable review title",
      description: "MP4 · 12.4 MB · 01:24",
      ogType: "website" as const,
      twitterCard: "summary_large_image" as const,
      canonicalUrl: "https://example.test/review",
      imageUrl: "https://example.test/og/review.png",
      imageAlt: "review",
    };
    const video = composeOgCardSvg({
      ...base,
      kind: "video",
      preview: {
        family: "video",
        label: "MP4",
        title: base.title,
        facts: ["12.4 MB", "01:24"],
        sourceDigest: "1".repeat(64),
        visual: { kind: "poster", raster },
      },
    }).toString("utf8");
    assert.match(
      video,
      /<image[^>]+x="0" y="0" width="1200" height="630"[^>]+xMidYMid slice/u,
      "video poster must fill the complete 1200x630 visual plane",
    );
    assert.match(video, /font-size="72"[^>]+font-weight="700"/u);
    assert.match(video, /font-size="28"[^>]+data-max-width/u);

    const pdf = composeOgCardSvg({
      ...base,
      title: "annual-report-2025.pdf",
      description: "PDF · 4.2 MB",
      kind: "pdf",
      preview: {
        family: "pdf",
        label: "PDF",
        title: "annual-report-2025.pdf",
        facts: ["4.2 MB"],
        sourceDigest: "2".repeat(64),
        visual: {
          kind: "page",
          raster: await sharp(raster).resize(927, 1200).png().toBuffer(),
        },
      },
    }).toString("utf8");
    assert.match(
      pdf,
      /<image[^>]+x="4\d\d" y="-?\d+" width="(?:8\d\d|9\d\d)" height="(?:9\d\d|1\d{3})"[^>]+xMidYMin/u,
      "portrait PDF must use an enlarged upper-page crop rather than fitting the page",
    );
    assert.match(
      pdf,
      /font-size="56"[^>]+font-weight="700"[^>]*>annual-<\/text>/u,
    );
    assert.match(
      pdf,
      /font-size="56"[^>]+font-weight="700"[^>]*>report-<\/text>/u,
    );
    assert.match(
      pdf,
      /font-size="56"[^>]+font-weight="700"[^>]*>2025\.pdf<\/text>/u,
    );

    const markdown = composeOgCardSvg({
      ...base,
      title: "Readable runbook.md",
      description: "Markdown · 18 KB",
      kind: "markdown",
      preview: {
        family: "markdown",
        label: "Markdown",
        title: "Readable runbook.md",
        facts: ["18 KB"],
        sourceDigest: "3".repeat(64),
        visual: {
          kind: "markdown",
          lines: [
            "# Deployment Runbook",
            "Order of operations for promoting a build.",
            "## Pre-flight checks",
            "- Verify the target tag exists",
            "- Confirm storage headroom",
            "- This sixth dense line must not render",
          ],
        },
      },
    }).toString("utf8");
    assert.match(markdown, /font-size="58"[^>]+font-weight="700"/u);
    assert.match(markdown, /font-size="30"[^>]+data-max-width/u);
    assert.doesNotMatch(markdown, /This sixth dense line must not render/u);
    assert.match(markdown, /<rect x="901" y="576" width="9" height="9"/u);
    assert.match(markdown, /<text x="1144" y="588"[^>]+text-anchor="end"/u);
  });

  it("keeps low-amplitude audio structure and unavailable hierarchy visible at iMessage scale", async () => {
    const samples = Array.from(
      { length: 48 },
      (_, index) => 0.02 + (index % 7) * 0.003,
    );
    const audio = composeOgCardSvg({
      title: "quiet-interview.ogg",
      description: "Audio · 102 KB · 00:06",
      ogType: "website",
      twitterCard: "summary_large_image",
      canonicalUrl: "https://example.test/audio",
      imageUrl: "https://example.test/og/audio.png",
      imageAlt: "audio",
      kind: "audio",
      preview: {
        family: "audio",
        label: "Audio",
        title: "quiet-interview.ogg",
        facts: ["102 KB", "00:06"],
        sourceDigest: "4".repeat(64),
        visual: { kind: "waveform", samples },
      },
    }).toString("utf8");
    const bars = [
      ...audio.matchAll(
        /<rect x="[\d.]+" y="[\d.]+" width="1[024]" height="(\d+)" rx="[567]" fill="#([0-9a-f]{6})"/gu,
      ),
    ];
    const heights = bars.map((match) => Number(match[1]));
    const fills = new Set(bars.map((match) => match[2]));
    assert.equal(heights.length, 48);
    assert.ok(
      Math.min(...heights) >= 64,
      "waveform must remain tall after phone downscale",
    );
    assert.ok(
      Math.max(...heights) - Math.min(...heights) >= 72,
      "low-amplitude structure must be visibly normalized",
    );
    assert.deepEqual(
      [...fills],
      ["8b919b"],
      "waveform must use the approved high-contrast neutral",
    );

    const unavailable = await readFile(
      path.resolve("runtime/assets/unavailable.png"),
    );
    const phone = await sharp(unavailable)
      .resize(332, 174)
      .removeAlpha()
      .raw()
      .toBuffer();
    const width = 332;
    const changedIn = (
      left: number,
      top: number,
      regionWidth: number,
      height: number,
    ) => {
      let changed = 0;
      for (let y = top; y < top + height; y += 1) {
        for (let x = left; x < left + regionWidth; x += 1) {
          const offset = (y * width + x) * 3;
          const distance = Math.max(
            Math.abs((phone[offset] ?? 13) - 13),
            Math.abs((phone[offset + 1] ?? 14) - 14),
            Math.abs((phone[offset + 2] ?? 16) - 16),
          );
          if (distance > 24) changed += 1;
        }
      }
      return changed;
    };
    assert.ok(
      changedIn(132, 33, 68, 48) >= 420,
      "unavailable artwork must be prominent at 332px",
    );
    assert.ok(
      changedIn(70, 103, 192, 20) >= 780,
      "unavailable title must have large effective occupancy",
    );
  });

  it("uses useful portrait and landscape PDF hero occupancy through the production renderer", async () => {
    const portrait = await subject(
      await structuredPdf(
        612,
        792,
        { red: 0.05, green: 0.35, blue: 0.7 },
        "PORTRAIT REPORT",
      ),
      "application/pdf",
      "Field report.pdf",
    );
    const landscape = await subject(
      await structuredPdf(
        792,
        500,
        { red: 0.7, green: 0.24, blue: 0.08 },
        "LANDSCAPE REPORT",
      ),
      "application/pdf",
      "Landscape report.pdf",
    );
    assert.equal(portrait.model.preview?.visual.kind, "page");
    assert.equal(landscape.model.preview?.visual.kind, "page");
    assert.ok(
      (await nonDarkRatio(portrait.png, {
        left: 560,
        top: 32,
        width: 600,
        height: 566,
      })) > 0.72,
      "portrait first page must occupy most of its hero instead of shrinking inside black space",
    );
    assert.ok(
      (await nonDarkRatio(landscape.png, {
        left: 40,
        top: 20,
        width: 1120,
        height: 350,
      })) > 0.72,
      "landscape first page must occupy a substantial wide hero region",
    );
    assert.notDeepEqual(portrait.png, landscape.png);
  });

  it("adds intentional whole-grapheme ellipses at display boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const clipped = truncateDisplayText(`${"W".repeat(40)}${family}`, 18);
    assert.match(clipped, /…$/u);
    assert.doesNotMatch(clipped, /[\u200d\ud800-\udfff]…$/u);
    assert.equal(truncateDisplayText("Mountain photo", 40), "Mountain photo");
    assert.equal(truncateDisplayText("Field report", 40), "Field report");
    assert.equal(truncateDisplayText("check", 40), "check");
  });

  it("keeps measured title, metadata, and excerpt glyphs inside the production safe edge", async () => {
    const cases = [
      {
        title: "Mountain photo",
        description: `${"TypeScript source · ".repeat(30)}99 MB`,
        kind: "binary" as const,
        visual: { kind: "binary" as const },
      },
      {
        title: "Field report",
        description: "TypeScript source · 99 MB",
        kind: "code" as const,
        visual: {
          kind: "code" as const,
          lines: [`    ${"W".repeat(180)}👨‍👩‍👧‍👦`],
        },
      },
      {
        title: "check",
        description: "Markdown · 1 KB",
        kind: "markdown" as const,
        visual: {
          kind: "markdown" as const,
          lines: [`# ${"界".repeat(120)}👨‍👩‍👧‍👦`],
        },
      },
    ];
    for (const [index, item] of cases.entries()) {
      const png = await renderOgImage(
        null as unknown as FileService,
        null as unknown as StoredFile,
        {
          title: item.title,
          description: item.description,
          ogType: "website",
          twitterCard: "summary_large_image",
          canonicalUrl: "https://example.test/safe",
          imageUrl: "https://example.test/og/safe.png",
          imageAlt: "safe",
          kind: item.kind,
          preview: {
            family: item.kind,
            label: item.kind.toUpperCase(),
            title: item.title,
            facts: ["99 MB"],
            sourceDigest: "d".repeat(64),
            visual: item.visual,
          },
        },
      );
      const edge = await sharp(png)
        .extract({ left: 1160, top: 72, width: 40, height: 520 })
        .removeAlpha()
        .raw()
        .toBuffer();
      let changed = 0;
      for (let offset = 0; offset < edge.length; offset += 3) {
        if (
          Math.abs((edge[offset] ?? 13) - 13) +
            Math.abs((edge[offset + 1] ?? 14) - 14) +
            Math.abs((edge[offset + 2] ?? 16) - 16) >
          30
        ) {
          changed += 1;
        }
      }
      assert.equal(
        changed,
        0,
        `case ${index} drew text into the 40px right safe edge`,
      );
    }
  });

  it("renders every final title grapheme instead of cropping it from the text raster", async () => {
    const card = async (title: string) =>
      renderOgImage(null as never, null as never, {
        title,
        description: "Markdown · 153 B",
        ogType: "article",
        twitterCard: "summary_large_image",
        canonicalUrl: "https://example.test/final-glyph",
        imageUrl: "https://example.test/og/final-glyph.png",
        imageAlt: "Safe preview",
        kind: "markdown",
        preview: {
          family: "markdown",
          label: "Markdown",
          title,
          facts: ["153 B"],
          sourceDigest: "f".repeat(64),
          visual: { kind: "markdown", lines: ["# Field notes"] },
        },
      });
    for (const [withoutFinal, complete] of [
      ["Field repor", "Field report"],
      ["Mountain phot", "Mountain photo"],
      ["Release runbook.m", "Release runbook.md"],
      ["chunked_upload.p", "chunked_upload.py"],
    ] as const) {
      const [shortPixels, completePixels] = await Promise.all([
        sharp(await card(withoutFinal))
          .removeAlpha()
          .raw()
          .toBuffer(),
        sharp(await card(complete))
          .removeAlpha()
          .raw()
          .toBuffer(),
      ]);
      let changed = 0;
      let rightmostChanged = 0;
      for (let offset = 0; offset < shortPixels.length; offset += 3) {
        if (
          Math.max(
            Math.abs(
              (shortPixels[offset] ?? 0) - (completePixels[offset] ?? 0),
            ),
            Math.abs(
              (shortPixels[offset + 1] ?? 0) -
                (completePixels[offset + 1] ?? 0),
            ),
            Math.abs(
              (shortPixels[offset + 2] ?? 0) -
                (completePixels[offset + 2] ?? 0),
            ),
          ) > 12
        ) {
          changed += 1;
          rightmostChanged = Math.max(rightmostChanged, (offset / 3) % 1200);
        }
      }
      assert(
        changed > 20,
        `${complete} must visibly render its final grapheme`,
      );
      assert(
        rightmostChanged > 180,
        `${complete} final grapheme must occupy its expected title tail`,
      );
    }
  });

  it("changes SVG preview and final pixels for same-size valid source mutations without active rasterization", async () => {
    const svg = (fill: string) =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="${fill}"/></svg>`,
      );
    const firstBytes = svg("red");
    const secondBytes = svg("tan");
    assert.equal(firstBytes.length, secondBytes.length);

    const first = await subject(firstBytes, "image/svg+xml", "same.svg");
    const second = await subject(secondBytes, "image/svg+xml", "same.svg");

    assert.equal(first.model.preview?.label, "SVG");
    assert.equal(first.model.preview?.visual.kind, "svg-source");
    assert.equal(second.model.preview?.visual.kind, "svg-source");
    assert.notDeepEqual(
      first.model.preview?.visual,
      second.model.preview?.visual,
    );
    assert.notDeepEqual(first.png, second.png);

    const hostile = await subject(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.executed=true"><script>globalThis.executed=true</script><image href="https://attacker.invalid/a.png"/></svg>',
      ),
      "image/svg+xml",
      "hostile.svg",
    );
    const composed = composeOgCardSvg(hostile.model).toString("utf8");
    assert.equal(hostile.model.preview?.label, "SVG");
    assert.equal(hostile.model.preview?.visual.kind, "svg-source");
    assert.doesNotMatch(composed, /<script|onload=|attacker\.invalid/u);
    assert.doesNotMatch(composed, /PHN2Zy/u);
  });

  it("changes archive pixels when same-size validated TAR.GZ entries change", async () => {
    const tar = (name: string) => {
      const header = Buffer.alloc(512);
      header.write(name, 0, 100);
      header.write("0000644\0", 100, 8);
      header.write("0000000\0", 108, 8);
      header.write("0000000\0", 116, 8);
      header.write("00000000004\0", 124, 12);
      header.write("00000000000\0", 136, 12);
      header.fill(0x20, 148, 156);
      header[156] = 0x30;
      header.write("ustar\0", 257, 6);
      const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
      return Buffer.concat([
        header,
        Buffer.from("data"),
        Buffer.alloc(508),
        Buffer.alloc(1024),
      ]);
    };
    const alpha = gzipSync(tar("alpha.txt"), { level: 9 });
    const bravo = gzipSync(tar("bravo.txt"), { level: 9 });
    assert.equal(alpha.length, bravo.length);
    const first = await subject(alpha, "application/gzip", "same.tar.gz");
    const second = await subject(bravo, "application/gzip", "same.tar.gz");
    assert.notDeepEqual(first.png, second.png);
  });

  it("composes excerpts without UTF-16 splits and preserves code indentation", () => {
    const boundary = `${"a".repeat(91)}👨‍👩‍👧‍👦é日本語`;
    const svg = composeOgCardSvg({
      title: "unicode.md",
      description: "TS · 1 B",
      ogType: "article",
      twitterCard: "summary_large_image",
      canonicalUrl: "https://example.test/a",
      imageUrl: "https://example.test/og/a.png",
      imageAlt: "safe",
      kind: "code",
      preview: {
        family: "code",
        label: "TS",
        title: "unicode.md",
        facts: ["1 B"],
        sourceDigest: "a".repeat(64),
        visual: { kind: "code", lines: [`            ${boundary}`] },
      },
    });
    const text = svg.toString("utf8");
    assert.doesNotMatch(text, /�/u);
    assert.match(text, /xml:space="preserve"/u);
    assert.match(text, />            a/u);
  });

  it("renders broad emoji, Japanese, Arabic, combining marks, and ZWJ clusters without tofu", async () => {
    const international = "🎉 ❤️ 🇯🇵 👨‍👩‍👧‍👦 日本語 العربية e\u0301";
    const model = {
      title: international,
      description: "TEXT · 1 B",
      ogType: "article" as const,
      twitterCard: "summary_large_image" as const,
      canonicalUrl: "https://example.test/i18n",
      imageUrl: "https://example.test/og/i18n.png",
      imageAlt: "safe",
      kind: "text" as const,
      preview: {
        family: "text" as const,
        label: "TEXT",
        title: international,
        facts: ["1 B"],
        sourceDigest: "b".repeat(64),
        visual: {
          kind: "text" as const,
          lines: [
            "🎉 party",
            "❤️ heart",
            "🇯🇵 flag",
            "👨‍👩‍👧‍👦 family",
            "📡 satellite",
            "日本語",
            "العربية",
            "e\u0301",
          ],
        },
      },
    };
    const svg = composeOgCardSvg(model).toString("utf8");
    assert.match(svg, /日本語/u);
    assert.match(svg, /العربية/u);
    assert.doesNotMatch(svg, /□|�/u);
    assert.equal(
      (svg.match(/data:image\/svg\+xml;base64/gu) ?? []).length,
      9,
      "title and body party, heart, flag, family ZWJ, and satellite must use bundled deterministic artwork",
    );
    const png = await renderOgImage(
      null as unknown as FileService,
      null as unknown as StoredFile,
      model,
    );
    const colorfulPixels = async (region: {
      left: number;
      top: number;
      width: number;
      height: number;
    }) => {
      const pixels = await sharp(png)
        .extract(region)
        .removeAlpha()
        .raw()
        .toBuffer();
      let colorful = 0;
      for (let offset = 0; offset < pixels.length; offset += 3) {
        const channels = [
          pixels[offset] ?? 0,
          pixels[offset + 1] ?? 0,
          pixels[offset + 2] ?? 0,
        ];
        if (Math.max(...channels) - Math.min(...channels) > 24) colorful += 1;
      }
      return colorful;
    };
    const emojiRegions: {
      left: number;
      top: number;
      width: number;
      height: number;
    }[] = [
      { left: 704, top: 92, width: 40, height: 40 },
      { left: 704, top: 146, width: 32, height: 30 },
      { left: 704, top: 194, width: 32, height: 30 },
      { left: 704, top: 242, width: 32, height: 30 },
      { left: 704, top: 290, width: 32, height: 30 },
    ];
    for (const [index, region] of emojiRegions.entries()) {
      assert.ok(
        (await colorfulPixels(region)) > 18,
        `body emoji region ${index} must contain bundled color artwork, not monochrome tofu`,
      );
    }

    const replacementModel = {
      ...model,
      preview: {
        ...model.preview,
        visual: {
          kind: "text" as const,
          lines: [
            "party",
            "heart",
            "flag",
            "family",
            "satellite",
            "�",
            "�",
            "�",
          ],
        },
      },
    };
    const replacement = await renderOgImage(
      null as unknown as FileService,
      null as unknown as StoredFile,
      replacementModel,
    );
    const scriptRegions: {
      left: number;
      top: number;
      width: number;
      height: number;
    }[] = [
      { left: 690, top: 325, width: 180, height: 44 },
      { left: 660, top: 373, width: 210, height: 44 },
      { left: 690, top: 421, width: 100, height: 44 },
    ];
    for (const [index, region] of scriptRegions.entries()) {
      const [actual, tofu] = await Promise.all([
        sharp(png).extract(region).removeAlpha().raw().toBuffer(),
        sharp(replacement).extract(region).removeAlpha().raw().toBuffer(),
      ]);
      assert.notDeepEqual(
        actual,
        tofu,
        `script region ${index} must differ from replacement-glyph rendering`,
      );
      const width = region.width;
      const ink = (x: number, y: number) => {
        const offset = (y * width + x) * 3;
        return (
          Math.abs((actual[offset] ?? 246) - 246) +
            Math.abs((actual[offset + 1] ?? 245) - 245) +
            Math.abs((actual[offset + 2] ?? 241) - 241) >
          45
        );
      };
      const borderInk =
        Array.from({ length: region.width }, (_, x) => ink(x, 0)).filter(
          Boolean,
        ).length +
        Array.from({ length: region.width }, (_, x) =>
          ink(x, region.height - 1),
        ).filter(Boolean).length;
      assert.ok(
        borderInk <= 4,
        `script region ${index} must not clip vertically (${borderInk} border pixels)`,
      );
    }
  });

  it("renders bundled emoji artwork in document, code, and Markdown body regions", async () => {
    const cases = [
      {
        kind: "document" as const,
        visualKind: "text" as const,
        lines: ["🚀 Heading", "😀 body", "🧑🏽‍💻 body"],
        regions: [
          { left: 308, top: 176, width: 56, height: 56 },
          { left: 308, top: 316, width: 30, height: 30 },
          { left: 308, top: 346, width: 30, height: 30 },
        ],
      },
      {
        kind: "markdown" as const,
        visualKind: "markdown" as const,
        lines: [
          "# 🎉 H1",
          "## ❤️ H2",
          "- 🇯🇵 bullet",
          "👨‍👩‍👧‍👦 plain",
          "🧑🏽‍💻 technologist",
          "📡 satellite",
          "🚀 rocket",
          "😀 smile",
        ],
        regions: [
          { left: 100, top: 50, width: 68, height: 68 },
          { left: 108, top: 172, width: 50, height: 50 },
          { left: 84, top: 234, width: 42, height: 42 },
          { left: 52, top: 281, width: 42, height: 42 },
          { left: 52, top: 327, width: 42, height: 42 },
        ],
      },
      {
        kind: "code" as const,
        visualKind: "code" as const,
        lines: ["🎉", "❤️", "🇯🇵", "👨‍👩‍👧‍👦", "🧑🏽‍💻", "📡", "🚀", "😀"],
        regions: [82, 126, 170, 214, 258, 302, 346, 390].map((baseline) => ({
          left: 52,
          top: baseline - 21,
          width: 30,
          height: 28,
        })),
      },
    ];

    for (const item of cases) {
      const model = {
        title: `${item.kind}.txt`,
        description: "1 B",
        ogType: "article" as const,
        twitterCard: "summary_large_image" as const,
        canonicalUrl: "https://example.test/u",
        imageUrl: "https://example.test/og/u.png",
        imageAlt: "safe",
        kind: item.kind,
        preview: {
          family: item.kind,
          label: item.kind.toUpperCase(),
          title: `${item.kind}.txt`,
          facts: ["1 B"],
          sourceDigest: "c".repeat(64),
          visual: { kind: item.visualKind, lines: item.lines },
        },
      };
      const svg = composeOgCardSvg(model);
      assert.equal(
        (svg.toString("utf8").match(/data:image\/svg\+xml;base64/gu) ?? [])
          .length,
        item.regions.length,
        `${item.kind} body must substitute every required emoji grapheme`,
      );
      const png = await renderSvgInWorker(svg);
      for (const [index, region] of item.regions.entries()) {
        const { data, info } = await sharp(png)
          .extract(region)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        let colorful = 0;
        for (let offset = 0; offset < data.length; offset += info.channels) {
          const channels = [...data.subarray(offset, offset + 3)];
          if (Math.max(...channels) - Math.min(...channels) > 24) colorful += 1;
        }
        assert.ok(
          colorful > 12,
          `${item.kind} body emoji region ${index} must contain color artwork without tofu, overlap, or clipping`,
        );
      }
    }
  });

  it("loads bundled Inter and JetBrains Mono in the production OG worker", async () => {
    const renderTextProbe = (family: string, text: string) =>
      renderSvgInWorker(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="140"><rect width="900" height="140" fill="white"/><text x="20" y="100" fill="black" font-family="${family}" font-size="72">${text}</text></svg>`,
        ),
      );

    const [inter, unknownSans, helvetica, mono, unknownMono, menlo] =
      await Promise.all([
        renderTextProbe("Inter", "Hamburgefonstiv 018"),
        renderTextProbe("ZzNope,sans-serif", "Hamburgefonstiv 018"),
        renderTextProbe("Helvetica", "Hamburgefonstiv 018"),
        renderTextProbe("JetBrains Mono", "Hamburgefonstiv 018"),
        renderTextProbe("ZzNope,monospace", "Hamburgefonstiv 018"),
        renderTextProbe("Menlo", "Hamburgefonstiv 018"),
      ]);

    assert.notDeepEqual(inter, unknownSans);
    assert.notDeepEqual(inter, helvetica);
    assert.notDeepEqual(mono, unknownMono);
    assert.notDeepEqual(mono, menlo);
  });

  it("renders bundled Latin, CJK, and Arabic fonts through native worker PNG probes", async () => {
    const probe = async (family: string, text: string, file?: string) => {
      const result = await runKillableProcess(
        process.execPath,
        [path.resolve(process.cwd(), "runtime/font-probe-worker.mjs")],
        {
          timeoutMs: 2_500,
          maxOutputBytes: 2 * 1024 * 1024,
          input: Buffer.from(JSON.stringify({ family, text, file })),
          allowSubprocesses: true,
        },
      );
      const metadata = await sharp(result.stdout).trim().metadata();
      assert.ok((metadata.width ?? 0) > 20);
      assert.ok((metadata.height ?? 0) > 20);
      return result.stdout;
    };

    const unknown = await probe("ZzNoSuchFont123", "Wim 012");
    const inter = await probe("Inter", "Wim 012", "Inter.ttf");
    const mono = await probe("JetBrains Mono", "Wim 012", "JetBrainsMono.ttf");
    assert.notDeepEqual(inter, unknown);
    assert.notDeepEqual(mono, unknown);
    assert.notDeepEqual(inter, mono);
    await probe(
      "Noto Sans CJK JP",
      "日本語の資料",
      "NotoSansCJKjp-Regular.otf",
    );
    await probe("Noto Sans Arabic", "العربية", "NotoSansArabic.ttf");
  });

  it("renders the actual bounded Markdown body so same-title byte changes alter pixels", async () => {
    const first = await subject(
      Buffer.from("# Same title\n\nAlpha release body\n"),
      "text/markdown",
      "runbook.md",
    );
    const second = await subject(
      Buffer.from("# Same title\n\nBravo release body\n"),
      "text/markdown",
      "runbook.md",
    );
    assert.equal(first.model.preview?.visual.kind, "markdown");
    assert.equal(second.model.preview?.visual.kind, "markdown");
    assert.notDeepEqual(first.png, second.png);
  });

  it("uses real uploaded image pixels as the hero and strips source metadata", async () => {
    const source = await sharp({
      create: { width: 120, height: 80, channels: 3, background: "#e02626" },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: "forbidden-synthetic-metadata" } })
      .toBuffer();
    const card = await subject(source, "image/jpeg", "landscape.jpg");
    assert.equal(card.model.preview?.visual.kind, "image");
    const hero = await sharp(card.png)
      .extract({ left: 600, top: 180, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    assert.ok((hero[0] ?? 0) > 160);
    assert.ok((hero[1] ?? 255) < 90);
    assert.equal(
      card.png.includes(Buffer.from("forbidden-synthetic-metadata")),
      false,
    );
  });

  it("keeps locator-like names and URLs out of public title, alt, and renderer text", async () => {
    const card = await subject(
      Buffer.from(
        "# https://secret.example/token\n\nfetch https://other.invalid/a\nSafe line\n",
      ),
      "text/markdown",
      "https-secret.example-token.md",
    );
    const serialized = JSON.stringify(
      card.model,
      (_key: string, value: unknown): unknown =>
        Buffer.isBuffer(value) ? "[buffer]" : value,
    );
    assert.doesNotMatch(
      serialized,
      /secret\.example|other\.invalid|https-secret/u,
    );
    assert.match(card.model.title, /Untitled|File/u);
  });

  it("renders byte-derived hex for generic binary and never draws a fake PDF page", async () => {
    const first = await subject(
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01]),
      "application/octet-stream",
      "firmware.bin",
    );
    const second = await subject(
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]),
      "application/octet-stream",
      "firmware.bin",
    );
    assert.notDeepEqual(first.png, second.png);

    const fallback = await subject(
      Buffer.from("%PDF-broken"),
      "application/pdf",
      "report.pdf",
    );
    assert.equal(fallback.model.preview?.visual.kind, "binary");
    const pageRegion = await sharp(fallback.png)
      .extract({ left: 700, top: 100, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    assert.ok(
      [...pageRegion].every((channel) => channel < 80),
      "type-led PDF fallback must not draw a fake white page",
    );
  });

  it("produces deterministic opaque 1200x630 PNGs for identical bytes", async () => {
    const bytes = Buffer.from("deterministic synthetic text");
    const first = await subject(bytes, "text/plain", "notes.txt");
    const second = await subject(bytes, "text/plain", "notes.txt");
    assert.deepEqual(first.png, second.png);
    const metadata = await sharp(first.png).metadata();
    assert.equal(metadata.width, 1200);
    assert.equal(metadata.height, 630);
    assert.equal(metadata.hasAlpha, false);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(metadata.icc, undefined);
  });
});
