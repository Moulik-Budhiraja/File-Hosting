import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import sharp from "sharp";

import { nativeAdmissionState } from "./native-admission";
import { composeOgCardSvg, renderOgImage, renderSvgInWorker } from "./og-image";
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function transitiveRssKiB(): number {
  if (process.platform === "win32") return process.memoryUsage().rss / 1024;
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      return match
        ? {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rss: Number(match[3]),
            command: match[4] ?? "",
          }
        : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const owned = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!owned.has(row.pid) && owned.has(row.ppid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  return rows
    .filter((row) => owned.has(row.pid) && !/(?:^|\/)ps$/u.test(row.command))
    .reduce((total, row) => total + row.rss, 0);
}

describe("OG Social Cards V2 byte-derived rendering", () => {
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
          { left: 88, top: 48, width: 56, height: 56 },
          { left: 92, top: 156, width: 40, height: 40 },
          { left: 75, top: 215, width: 32, height: 32 },
          ...[279, 313, 347, 381, 415].map((baseline) => ({
            left: 52,
            top: baseline - 23,
            width: 32,
            height: 32,
          })),
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

  it(
    "keeps concurrent 6324px raster extraction and OG rendering below the transitive RSS envelope",
    { skip: process.platform === "win32" },
    async () => {
      const generated = await runKillableProcess(
        path.resolve(process.cwd(), "node_modules/ffmpeg-static/ffmpeg"),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=#4b78a8:s=6324x6324",
          "-frames:v",
          "1",
          "-c:v",
          "mjpeg",
          "-f",
          "image2pipe",
          "pipe:1",
        ],
        {
          timeoutMs: 10_000,
          maxOutputBytes: 8 * 1024 * 1024,
          allowSubprocesses: true,
        },
      );
      const encoded = generated.stdout;
      const targetBytes = 20 * 1024 * 1024;
      let source = Buffer.concat([
        encoded,
        Buffer.alloc(Math.max(0, targetBytes - encoded.length), 0x5a),
      ]);
      assert.equal(source.length, targetBytes);
      const sourceSha256 = createHash("sha256").update(source).digest("hex");
      const directory = await mkdtemp(path.join(os.tmpdir(), "fs-og-rss-"));
      temporaryDirectories.push(directory);
      const sourcePath = path.join(directory, "large.jpg");
      await writeFile(sourcePath, source);
      source = Buffer.alloc(0);
      const file: StoredFile = {
        id: "RsS6324",
        name: "large.jpg",
        size: targetBytes,
        mimeType: "image/jpeg",
        sha256: sourceSha256,
        visibility: "public",
        ownerId: null,
        storageKey: "rss-probe",
        archive: null,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
        tags: [],
      };
      const service = {
        config: { publicUrl: "https://files.example.test" },
        storagePath: () => sourcePath,
      } as unknown as FileService;
      let peakKiB = transitiveRssKiB();
      const sampler = setInterval(() => {
        peakKiB = Math.max(peakKiB, transitiveRssKiB());
      }, 25);
      try {
        const cards = await Promise.all(
          Array.from({ length: 3 }, async () => {
            const model = await buildUnfurlModel(service, file);
            return renderOgImage(service, file, model);
          }),
        );
        for (const card of cards)
          assert.equal(card.subarray(1, 4).toString("ascii"), "PNG");
      } finally {
        clearInterval(sampler);
      }
      const peakMiB = peakKiB / 1024;
      process.stdout.write(
        `# transitive RSS probe peak: ${peakMiB.toFixed(1)} MiB\n`,
      );
      assert.ok(
        peakMiB < 360,
        `transitive RSS ${peakMiB.toFixed(1)} MiB exceeded 360 MiB`,
      );
      assert.deepEqual(nativeAdmissionState(), {
        active: 0,
        queued: 0,
        budgetMiB: 384,
      });
      const recovery = await subject(
        Buffer.from("recovery"),
        "text/plain",
        "recovery.txt",
      );
      assert.equal(recovery.png.subarray(1, 4).toString("ascii"), "PNG");
    },
  );

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
