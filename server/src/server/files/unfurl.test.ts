import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import sharp from "sharp";

import { BoundedWorkerPool, RASTER_WORKER_LIMITS } from "./raster-worker";
import type { FileService } from "./service";
import type { StoredFile } from "./types";
import {
  buildUnfurlModel,
  publicShareUrl,
  rasterEnvelopeEligible,
  renderUnfurlHead,
  sanitizeUnfurlText,
} from "./unfurl";

const PUBLIC_URL = "https://files.example.test";
const temporaryDirectories: string[] = [];

function storedFile(overrides: Partial<StoredFile> = {}): StoredFile {
  return {
    id: "Ab3dE5g",
    name: "notes.md",
    size: 12,
    mimeType: "text/markdown",
    sha256: "f".repeat(64),
    visibility: "public",
    ownerId: "owner-user-123",
    storageKey: "secret-storage-key",
    archive: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    tags: ["secret-tag", "internal-project"],
    ...overrides,
  };
}

async function fakeService(contents: string | Buffer): Promise<FileService> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fs-unfurl-test-"));
  temporaryDirectories.push(directory);
  const objectPath = path.join(directory, "object");
  await writeFile(objectPath, contents);
  return {
    config: { publicUrl: PUBLIC_URL },
    storagePath: () => objectPath,
  } as unknown as FileService;
}

async function modelFor(
  contents: string | Buffer,
  overrides: Partial<StoredFile> = {},
) {
  const service = await fakeService(contents);
  const file = storedFile({
    size: Buffer.byteLength(contents),
    ...overrides,
  });
  return buildUnfurlModel(service, file);
}

function metaTags(head: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const match of head.matchAll(
    /<meta (?:property|name)="([^"]+)" content="([^"]*)">/gu,
  )) {
    tags.set(match[1]!, match[2]!);
  }
  return tags;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("unfurl text sanitizer", () => {
  it("normalizes to NFC and strips controls, newlines, and bidi controls", () => {
    // NFC: "e" + combining acute composes to a single code point.
    assert.equal(sanitizeUnfurlText("résumé.md", 300), "résumé.md");
    assert.equal(
      sanitizeUnfurlText("evil\r\nSet-Cookie: x=1", 300),
      "evil Set-Cookie: x=1",
    );
    assert.equal(
      sanitizeUnfurlText("‮gpj.exe‬ name ⁦iso⁩ ‎mark", 300),
      "gpj.exe name iso mark",
    );
    assert.equal(sanitizeUnfurlText("nul \0byte\0end", 300), "nul byteend");
    assert.equal(sanitizeUnfurlText("tab\tnext ", 300), "tab next");
    assert.equal(
      sanitizeUnfurlText("line\u2028next\u2029bad\uFFFFscalar", 300),
      "line next badscalar",
    );
  });

  it("collapses whitespace runs and trims", () => {
    assert.equal(sanitizeUnfurlText("  a   b  c  ", 300), "a b c");
  });

  it("caps by UTF-8 bytes without splitting code points", () => {
    // U+00E9 is 2 bytes; a 5-byte cap keeps 5 bytes and stops before
    // splitting the next 2-byte character.
    assert.equal(sanitizeUnfurlText("aééé", 5), "aéé");
    // 4-byte emoji must be dropped whole rather than split.
    assert.equal(sanitizeUnfurlText("ab\u{1F600}c", 5), "ab");
    assert.equal(sanitizeUnfurlText("", 300), "");
  });

  it("keeps plain HTML-dangerous characters for the sink escaper", () => {
    // Escaping happens at the HTML/SVG sink, not during normalization.
    assert.equal(
      sanitizeUnfurlText(`<img src=x onerror=alert(1)>&"'.md`, 300),
      `<img src=x onerror=alert(1)>&"'.md`,
    );
  });
});

describe("public share URL derivation", () => {
  it("builds canonical URLs only from the configured origin and a valid slug", () => {
    assert.equal(
      publicShareUrl(PUBLIC_URL, "Ab3dE5g"),
      "https://files.example.test/Ab3dE5g",
    );
  });

  it("rejects slugs that are not the public base62 routing id", () => {
    for (const bad of ["../etc", "Ab3dE5g/..", "x", "Ab3dE5g?x=1", "Ab3dE5%"]) {
      assert.throws(() => publicShareUrl(PUBLIC_URL, bad));
    }
  });
});

describe("raster safety envelope", () => {
  it("isolates anonymous decoding behind bounded worker resources", () => {
    assert.deepEqual(RASTER_WORKER_LIMITS, {
      maxConcurrent: 2,
      maxQueued: 16,
      maxOldSpaceMiB: 256,
      maxOutputBytes: 8 * 1024 * 1024,
      queueTimeoutMs: 2_500,
      wallTimeoutMs: 2_500,
    });
  });

  it("rejects excess and stale raster worker waiters", async () => {
    const pool = new BoundedWorkerPool(2, 1, 20);
    await pool.acquire();
    await pool.acquire();
    const queued = pool.acquire();

    await assert.rejects(pool.acquire(), /queue is full/u);
    await assert.rejects(queued, /queue wait timed out/u);

    pool.release();
    pool.release();
  });

  it("enforces the inclusive 20 MiB and 40 megapixel boundaries", () => {
    assert.equal(rasterEnvelopeEligible(20 * 1024 * 1024, 8000, 5000), true);
    assert.equal(
      rasterEnvelopeEligible(20 * 1024 * 1024 + 1, 8000, 5000),
      false,
    );
    assert.equal(rasterEnvelopeEligible(20 * 1024 * 1024, 8001, 5000), false);
    assert.equal(rasterEnvelopeEligible(1, 0, 5000), false);
  });
});

describe("public unfurl view-model", () => {
  it("queues concurrent anonymous raster workers without changing metadata", async () => {
    const raster = await sharp({
      create: {
        width: 16,
        height: 9,
        channels: 3,
        background: "red",
      },
    })
      .png()
      .toBuffer();
    const service = await fakeService(raster);
    const file = storedFile({
      name: "bounded.png",
      mimeType: "image/png",
      size: raster.length,
    });
    const models = await Promise.all(
      Array.from({ length: 3 }, () => buildUnfurlModel(service, file)),
    );
    assert.equal(models.filter((model) => model.eligibleRaster).length, 3);
    assert.equal(
      models.filter((model) => model.twitterCard === "summary").length,
      0,
    );
  });

  it("reads only the capped Markdown prefix from a large sparse public file", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-unfurl-sparse-"),
    );
    temporaryDirectories.push(directory);
    const objectPath = path.join(directory, "object");
    const handle = await open(objectPath, "w");
    const heading = Buffer.from("# Sparse heading\n");
    await handle.write(heading, 0, heading.length, 0);
    await handle.truncate(128 * 1024 * 1024);
    await handle.close();
    const service = {
      config: { publicUrl: PUBLIC_URL },
      storagePath: () => objectPath,
    } as unknown as FileService;

    const model = await buildUnfurlModel(
      service,
      storedFile({ size: 128 * 1024 * 1024 }),
    );
    assert.equal(model.title, "Sparse heading");
  });

  it("uses the sanitized first Markdown heading as title, article type, summary card", async () => {
    const model = await modelFor("# Deploy Runbook\n\nSecret body text.\n");
    assert.equal(model.title, "Deploy Runbook");
    assert.equal(model.ogType, "article");
    assert.equal(model.twitterCard, "summary");
    assert.match(model.description ?? "", /^Markdown · \d+ B$/u);
    assert.equal(model.canonicalUrl, `${PUBLIC_URL}/Ab3dE5g`);
    assert.equal(model.imageUrl, `${PUBLIC_URL}/og/Ab3dE5g.png`);
    // Never body excerpts or generated prose.
    assert.doesNotMatch(model.description ?? "", /Secret body/u);
  });

  it("treats non-Markdown text as a document without quoting its body", async () => {
    const model = await modelFor("synthetic body must never become metadata", {
      name: "notes.txt",
      mimeType: "text/plain",
    });
    assert.equal(model.kind, "document");
    assert.equal(model.ogType, "article");
    assert.match(model.description ?? "", /^Text document · \d+ B$/u);
    assert.doesNotMatch(model.description ?? "", /synthetic body/u);
  });

  it("uses the inherited Markdown token text for formatted headings without markup or URLs", async () => {
    const model = await modelFor(
      "# Deploy *world* [runbook](https://secret.example/path) `now`\n",
    );
    assert.equal(model.title, "Deploy world runbook now");
    assert.doesNotMatch(model.title, /secret\.example/u);
    assert.equal(
      ["*", "`", "[", "]", "(", ")"].some((character) =>
        model.title.includes(character),
      ),
      false,
    );
  });

  it("falls back to the sanitized filename when no heading exists", async () => {
    const model = await modelFor("plain paragraph only\n");
    assert.equal(model.title, "notes.md");
  });

  it("falls back when the first Markdown heading sanitizes to empty", async () => {
    const model = await modelFor("# \u202E\u202D\u200E\u200F\n", {
      name: "safe-fallback.md",
    });
    assert.equal(model.title, "safe-fallback.md");
    assert.equal(
      model.imageAlt,
      "File-Hosting preview card: safe-fallback.md, Markdown document",
    );
  });

  it("rejects malformed UTF-8 headings and falls back without replacement characters", async () => {
    const model = await modelFor(Buffer.from([0x23, 0x20, 0xc3, 0x28]), {
      name: "safe-fallback.md",
      mimeType: "text/markdown",
    });
    assert.equal(model.title, "safe-fallback.md");
    assert.doesNotMatch(model.title, /�/u);
  });

  it("sanitizes hostile heading text before it reaches any sink", async () => {
    const model = await modelFor("# ‮Evil <script>alert(1)</script> heading\n");
    assert.doesNotMatch(model.title, /[‮\r\n]/u);
    const head = renderUnfurlHead(model);
    assert.doesNotMatch(head, /<script/u);
    assert.doesNotMatch(
      head,
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u,
    );
  });

  it("classifies public raster images as summary_large_image with neutral alt", async () => {
    const png = await sharp({
      create: {
        width: 16,
        height: 9,
        channels: 3,
        background: "#6ea8dc",
      },
    })
      .png()
      .toBuffer();
    const model = await modelFor(png, {
      name: "survey.png",
      mimeType: "image/png",
    });
    assert.equal(model.ogType, "website");
    assert.equal(model.twitterCard, "summary_large_image");
    assert.match(model.description ?? "", /^PNG image · 16 × 9 · \d+ B$/u);
    assert.equal(model.imageAlt, "Image hosted on File-Hosting: survey.png");
  });

  it("uses a summary card when declared raster bytes are malformed or MIME-mismatched", async () => {
    const malformed = await modelFor("not-really-png", {
      name: "broken.png",
      mimeType: "image/png",
    });
    assert.equal(malformed.twitterCard, "summary");
    assert.equal(malformed.eligibleRaster, false);

    const jpeg = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "#15171c",
      },
    })
      .jpeg()
      .toBuffer();
    const mismatched = await modelFor(jpeg, {
      name: "spoofed.png",
      mimeType: "image/png",
    });
    assert.equal(mismatched.twitterCard, "summary");
    assert.equal(mismatched.eligibleRaster, false);
  });

  it("keeps oversized or non-raster images on the plain summary card", async () => {
    const oversized = await modelFor("x", {
      name: "huge.png",
      mimeType: "image/png",
      size: 21 * 1024 * 1024,
    });
    assert.equal(oversized.twitterCard, "summary");
    const svg = await modelFor("<svg/>", {
      name: "vector.svg",
      mimeType: "image/svg+xml",
    });
    assert.equal(svg.twitterCard, "summary");
    const gif = await modelFor("gif", {
      name: "anim.gif",
      mimeType: "image/gif",
    });
    assert.equal(gif.twitterCard, "summary");
  });

  it("describes PDF, audio, video, and binary with terse structural facts only", async () => {
    const cases: Array<[Partial<StoredFile>, RegExp, string, string]> = [
      [
        { name: "audit.pdf", mimeType: "application/pdf" },
        /^PDF · \d+ B$/u,
        "article",
        "summary",
      ],
      [
        { name: "standup.m4a", mimeType: "audio/mp4" },
        /^Audio · \d+ B$/u,
        "website",
        "summary",
      ],
      [
        { name: "demo.mp4", mimeType: "video/mp4" },
        /^Video · \d+ B$/u,
        "website",
        "summary",
      ],
      [
        { name: "firmware.bin", mimeType: "application/octet-stream" },
        /^Binary file · \d+ B$/u,
        "website",
        "summary",
      ],
    ];
    for (const [overrides, description, ogType, twitterCard] of cases) {
      const model = await modelFor("some bytes", overrides);
      assert.equal(model.title, overrides.name);
      assert.match(model.description ?? "", description);
      assert.equal(model.ogType, ogType);
      assert.equal(model.twitterCard, twitterCard);
    }
  });
});

describe("unfurl head rendering", () => {
  it("emits the exact escaped tag set with twitter mirroring og byte-for-byte", async () => {
    const model = await modelFor('# A "quoted" & <angled> title\n');
    const head = renderUnfurlHead(model);
    const tags = metaTags(head);
    assert.equal(tags.get("og:site_name"), "File-Hosting");
    assert.equal(
      tags.get("og:title"),
      "A &quot;quoted&quot; &amp; &lt;angled&gt; title",
    );
    assert.equal(tags.get("og:type"), "article");
    assert.equal(tags.get("og:url"), `${PUBLIC_URL}/Ab3dE5g`);
    assert.equal(tags.get("og:image"), `${PUBLIC_URL}/og/Ab3dE5g.png`);
    assert.equal(tags.get("og:image:width"), "1200");
    assert.equal(tags.get("og:image:height"), "630");
    assert.equal(tags.get("og:image:type"), "image/png");
    assert.equal(tags.get("twitter:card"), "summary");
    assert.equal(tags.get("twitter:title"), tags.get("og:title"));
    assert.equal(tags.get("twitter:description"), tags.get("og:description"));
    assert.equal(tags.get("twitter:image"), tags.get("og:image"));
    assert.match(
      head,
      new RegExp(`<link rel="canonical" href="${PUBLIC_URL}/Ab3dE5g">`, "u"),
    );
  });

  it("never leaks forbidden fields into the head", async () => {
    const model = await modelFor("# Title\n", {
      name: "public-name.md",
    });
    const head = renderUnfurlHead(model);
    const serializedModel = JSON.stringify(model);
    assert.equal("file" in model, false);
    for (const forbidden of [
      "secret-tag",
      "internal-project",
      "owner-user-123",
      "f".repeat(64),
      "secret-storage-key",
      "/raw/",
      "visibility",
      "Public",
      "sha",
    ]) {
      assert.ok(
        !head.includes(forbidden) && !serializedModel.includes(forbidden),
        `head and sanitized model must not contain ${forbidden}`,
      );
    }
  });
});
