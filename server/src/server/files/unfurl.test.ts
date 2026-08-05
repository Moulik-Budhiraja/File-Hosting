import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import sharp from "sharp";

import { BoundedWorkerPool, RASTER_WORKER_LIMITS } from "./raster-worker";
import type { FileService } from "./service";
import { sanitizeExcerptLine, sanitizeLocatorFreeText } from "./text-safety";
import type { StoredFile } from "./types";
import {
  buildUnfurlModel,
  publicShareUrl,
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
    sha256: createHash("sha256").update(contents).digest("hex"),
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

  it("removes raw, encoded, Unicode-obscured, email, host, and path locators while preserving safe filenames", () => {
    assert.equal(sanitizeLocatorFreeText("notes.md", 300, "File"), "notes.md");
    assert.equal(
      sanitizeLocatorFreeText("quarterly report.pdf", 300, "File"),
      "quarterly report.pdf",
    );
    assert.equal(
      sanitizeLocatorFreeText("研究データ📡-résumé-Δ.md", 300, "File"),
      "研究データ📡-résumé-Δ.md",
    );
    assert.equal(
      sanitizeLocatorFreeText("👨🏽‍💻-research.md", 300, "File"),
      "👨🏽‍💻-research.md",
    );
    assert.equal(
      sanitizeLocatorFreeText("intranet?token=synthetic-secret", 300, "File"),
      "File",
    );
    assert.equal(
      sanitizeExcerptLine("# intranet?token=synthetic-secret", 300),
      "# ",
    );
    for (const hostile of [
      "https://secret.example/token",
      "https%253A%252F%252Fsecret.example%252Ftoken",
      "www.secret.example",
      "person@secret.example",
      "/private/storage/object",
      "..\\private\\storage",
      "SENSITIVE—https://secret.example/a",
      "secret.example.com",
      "https-secret.example-token.md",
    ]) {
      assert.equal(sanitizeLocatorFreeText(hostile, 300, "File"), "File");
    }
    assert.equal(
      sanitizeLocatorFreeText(
        "Safe line https://secret.example/a remains",
        300,
        "File",
      ),
      "Safe line remains",
    );
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
      sha256: createHash("sha256").update(raster).digest("hex"),
    });
    const models = await Promise.all(
      Array.from({ length: 3 }, () => buildUnfurlModel(service, file)),
    );
    assert.equal(models.length, 3);
    assert.equal(
      models.filter((model) => model.twitterCard === "summary").length,
      0,
    );
  });

  it("uses a metadata-only card for large public sources without rereading bytes", async () => {
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
    await chmod(objectPath, 0o000);
    const service = {
      config: { publicUrl: PUBLIC_URL },
      storagePath: () => objectPath,
    } as unknown as FileService;
    const file = storedFile({
      name: "large-public.bin",
      size: 128 * 1024 * 1024,
    });

    const model = await buildUnfurlModel(service, file);
    assert.equal(model.kind, "binary");
    assert.equal(model.title, "large-public.bin");
    assert.equal(model.description, "FILE · 128 MB");
    assert.equal(model.preview?.sourceDigest, file.sha256);
    assert.deepEqual(model.preview?.visual, { kind: "binary" });
  });

  it("uses the approved filename title and keeps Markdown headings in the excerpt", async () => {
    const model = await modelFor("# Deploy Runbook\n\nSecret body text.\n", {
      name: "Release runbook.md",
    });
    assert.equal(model.title, "Release runbook.md");
    assert.equal(model.ogType, "article");
    assert.equal(model.twitterCard, "summary_large_image");
    assert.match(model.description ?? "", /^Markdown · \d+ B$/u);
    assert.equal(model.canonicalUrl, `${PUBLIC_URL}/Ab3dE5g`);
    assert.equal(model.imageUrl, `${PUBLIC_URL}/og/Ab3dE5g.png`);
    assert.deepEqual(
      model.preview?.visual.kind === "markdown"
        ? model.preview.visual.lines.slice(0, 1)
        : [],
      ["# Deploy Runbook"],
    );
    assert.doesNotMatch(model.description ?? "", /Secret body/u);
  });

  it("treats non-Markdown text as a document without quoting its body", async () => {
    const model = await modelFor("synthetic body must never become metadata", {
      name: "notes.txt",
      mimeType: "text/plain",
    });
    assert.equal(model.kind, "text");
    assert.equal(model.ogType, "article");
    assert.match(model.description ?? "", /^TXT · \d+ B$/u);
    assert.doesNotMatch(model.description ?? "", /synthetic body/u);
  });

  it("keeps hostile Markdown heading locators out of the excerpt while retaining the filename title", async () => {
    const model = await modelFor(
      "# Deploy *world* [runbook](https://secret.example/path) `now`\n",
    );
    assert.equal(model.title, "notes.md");
    const lines =
      model.preview?.visual.kind === "markdown"
        ? model.preview.visual.lines.join(" ")
        : "";
    assert.doesNotMatch(lines, /secret\.example/u);
    assert.match(lines, /^# Deploy/u);
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
      `File-Hosting preview card: safe-fallback.md, ${model.description}`,
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
    assert.match(model.description ?? "", /^PNG · \d+ B · 16×9$/u);
    assert.equal(
      model.imageAlt,
      `File-Hosting preview card: survey.png, ${model.description}`,
    );
  });

  it("uses a summary card when declared raster bytes are malformed or MIME-mismatched", async () => {
    const malformed = await modelFor("not-really-png", {
      name: "broken.png",
      mimeType: "image/png",
    });
    assert.equal(malformed.twitterCard, "summary_large_image");

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
    assert.equal(mismatched.twitterCard, "summary_large_image");
  });

  it("fails closed on source identity mismatches and uses truthful family fallbacks", async () => {
    await assert.rejects(
      modelFor("x", {
        name: "huge.png",
        mimeType: "image/png",
        size: 21 * 1024 * 1024,
      }),
      /preview source unavailable/u,
    );
    const svg = await modelFor("<svg/>", {
      name: "vector.svg",
      mimeType: "image/svg+xml",
    });
    assert.equal(svg.twitterCard, "summary_large_image");
    assert.equal(svg.preview?.family, "image");
    const gif = await modelFor("gif", {
      name: "anim.gif",
      mimeType: "image/gif",
    });
    assert.equal(gif.twitterCard, "summary_large_image");
    assert.equal(gif.preview?.visual.kind, "binary");
  });

  it("describes PDF, audio, video, and binary with terse structural facts only", async () => {
    const cases: Array<
      [Partial<StoredFile>, RegExp, string, string, string, string]
    > = [
      [
        { name: "audit.pdf", mimeType: "application/pdf" },
        /^PDF · \d+ B$/u,
        "article",
        "summary_large_image",
        "pdf",
        "PDF",
      ],
      [
        { name: "standup.m4a", mimeType: "audio/mp4" },
        /^Audio · \d+ B$/u,
        "website",
        "summary_large_image",
        "audio",
        "Audio",
      ],
      [
        { name: "demo.mp4", mimeType: "video/mp4" },
        /^MP4 · \d+ B$/u,
        "website",
        "summary_large_image",
        "video",
        "MP4",
      ],
      [
        { name: "firmware.bin", mimeType: "application/octet-stream" },
        /^Binary · \d+ B$/u,
        "website",
        "summary_large_image",
        "binary",
        "Binary",
      ],
    ];
    const contents = "some bytes";
    const sourceDigest = createHash("sha256").update(contents).digest("hex");
    for (const [
      overrides,
      description,
      ogType,
      twitterCard,
      family,
      label,
    ] of cases) {
      const service = await fakeService(contents);
      const file = storedFile({
        size: Buffer.byteLength(contents),
        sha256: sourceDigest,
        ...overrides,
      });
      const model = await buildUnfurlModel(service, file, {
        family: family as "pdf" | "audio" | "video" | "binary",
        label,
        title: file.name,
        facts: [`${file.size} B`],
        sourceDigest,
        visual: { kind: "binary" },
      });
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
    assert.equal(tags.get("og:title"), "notes.md");
    assert.equal(tags.get("og:type"), "article");
    assert.equal(tags.get("og:url"), `${PUBLIC_URL}/Ab3dE5g`);
    assert.equal(tags.get("og:image"), `${PUBLIC_URL}/og/Ab3dE5g.png`);
    assert.equal(tags.get("og:image:width"), "1200");
    assert.equal(tags.get("og:image:height"), "630");
    assert.equal(tags.get("og:image:type"), "image/png");
    assert.equal(tags.get("twitter:card"), "summary_large_image");
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
