import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import ffmpegPath from "ffmpeg-static";
import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";
import { ZipFile } from "yazl";

import {
  derivePreview,
  PreviewRendererRegistry,
  type RendererInput,
} from "./preview-renderers";

const require = createRequire(import.meta.url);
const ffprobePath = (require("ffprobe-static") as { path: string }).path;

const temporaryDirectories: string[] = [];

async function fixture(
  bytes: Buffer,
  mime: string,
  name: string,
): Promise<RendererInput> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fs-preview-derive-"));
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, "object");
  await writeFile(sourcePath, bytes);
  return {
    trustedMime: mime,
    name,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourcePath,
  };
}

function zip(
  entries: Array<{
    name: string;
    bytes: Buffer;
    encrypted?: boolean;
    declaredSize?: number;
  }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.encrypted ? 1 : 0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.declaredSize ?? entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    chunks.push(header, name, entry.bytes);
  }
  return Buffer.concat(chunks);
}

function tarWithEntry(name: string, contents: string): Buffer {
  const header = Buffer.alloc(512);
  Buffer.from(name).copy(header, 0, 0, 100);
  Buffer.from("0000644\0").copy(header, 100);
  Buffer.from("0000000\0").copy(header, 108);
  Buffer.from("0000000\0").copy(header, 116);
  Buffer.from(contents.length.toString(8).padStart(11, "0") + "\0").copy(
    header,
    124,
  );
  Buffer.from("00000000000\0").copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from("00").copy(header, 263);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);
  const body = Buffer.from(contents);
  const paddedBody = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(paddedBody);
  return Buffer.concat([header, paddedBody, Buffer.alloc(1024)]);
}

function wav(samples: readonly number[]): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  const output = Buffer.alloc(44 + pcm.length);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + pcm.length, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(8000, 24);
  output.writeUInt32LE(16000, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(pcm.length, 40);
  pcm.copy(output, 44);
  return output;
}

async function docx(text: string): Promise<Buffer> {
  const archive = new ZipFile();
  archive.addBuffer(
    Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
    "word/document.xml",
  );
  archive.end();
  const chunks: Buffer[] = [];
  for await (const chunk of archive.outputStream)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function coloredPdf(
  red: number,
  green: number,
  blue: number,
): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 315]);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: 600,
    height: 315,
    color: rgb(red, green, blue),
  });
  page.drawText("REAL SYNTHETIC PAGE", { x: 40, y: 150, size: 32 });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function generatedMedia(
  arguments_: readonly string[],
  extension: string,
): Promise<Buffer> {
  assert.ok(ffmpegPath, "ffmpeg-static must provide a packaged binary");
  const directory = await mkdtemp(path.join(os.tmpdir(), "fs-preview-media-"));
  temporaryDirectories.push(directory);
  const outputPath = path.join(directory, `fixture.${extension}`);
  const result = spawnSync(ffmpegPath, [...arguments_, "-y", outputPath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const probeReady = spawnSync(ffprobePath, ["-version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(probeReady.status, 0, probeReady.stderr);
  return readFile(outputPath);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("actual-byte preview derivation", () => {
  it("derives image pixels and changes the raster when source pixels change", async () => {
    const red = await sharp({
      create: { width: 20, height: 12, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const blue = await sharp({
      create: { width: 20, height: 12, channels: 3, background: "#0000ff" },
    })
      .png()
      .toBuffer();
    const first = await derivePreview(
      await fixture(red, "image/png", "pixels.png"),
    );
    const second = await derivePreview(
      await fixture(blue, "image/png", "pixels.png"),
    );
    assert.equal(first.visual.kind, "image");
    assert.equal(second.visual.kind, "image");
    assert.notDeepEqual(first.visual, second.visual);
    if (first.visual.kind !== "image") return;
    assert.deepEqual(
      await sharp(first.visual.raster)
        .metadata()
        .then(({ width, height }) => ({ width, height })),
      {
        width: 1200,
        height: 630,
      },
    );
    assert.deepEqual(first.facts.slice(0, 2), [`${red.length} B`, "20×12"]);
  });

  it("renders a real PDF first page and changes when page bytes change", async () => {
    const red = await derivePreview(
      await fixture(
        await coloredPdf(0.8, 0.05, 0.05),
        "application/pdf",
        "report.pdf",
      ),
    );
    const blue = await derivePreview(
      await fixture(
        await coloredPdf(0.05, 0.1, 0.8),
        "application/pdf",
        "report.pdf",
      ),
    );
    assert.equal(red.visual.kind, "page");
    assert.equal(blue.visual.kind, "page");
    if (red.visual.kind !== "page" || blue.visual.kind !== "page") return;
    assert.notDeepEqual(red.visual.raster, blue.visual.raster);
    assert.deepEqual(
      await sharp(red.visual.raster)
        .metadata()
        .then(({ width, height, format }) => ({ width, height, format })),
      {
        width: 1200,
        height: 630,
        format: "png",
      },
    );
  });

  it("derives a bounded real DOCX excerpt without executing document content", async () => {
    const alpha = await derivePreview(
      await fixture(
        await docx("Alpha release note"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "report.docx",
      ),
    );
    const beta = await derivePreview(
      await fixture(
        await docx("Beta release note"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "report.docx",
      ),
    );
    assert.equal(alpha.visual.kind, "text");
    if (alpha.visual.kind !== "text" || beta.visual.kind !== "text") return;
    assert.deepEqual(alpha.visual.lines, ["Alpha release note"]);
    assert.deepEqual(beta.visual.lines, ["Beta release note"]);
  });

  it("derives a real video poster and duration from supported uploaded bytes", async () => {
    const red = await generatedMedia(
      [
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=64x36:d=0.3",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
      ],
      "mp4",
    );
    const blue = await generatedMedia(
      [
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=64x36:d=0.3",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
      ],
      "mp4",
    );
    const first = await derivePreview(
      await fixture(red, "video/mp4", "clip.mp4"),
    );
    const second = await derivePreview(
      await fixture(blue, "video/mp4", "clip.mp4"),
    );
    assert.equal(first.visual.kind, "poster");
    assert.equal(second.visual.kind, "poster");
    assert.notDeepEqual(first.visual, second.visual);
    if (first.visual.kind !== "poster") return;
    assert.deepEqual(
      await sharp(first.visual.raster)
        .metadata()
        .then(({ width, height }) => ({ width, height })),
      { width: 1200, height: 630 },
    );
    assert.match(first.facts.join(" · "), /00:00/u);
  });

  it("derives bounded markdown, text, and code excerpts from real decoded bytes", async () => {
    const cases = [
      [
        "text/markdown",
        "runbook.md",
        "# Alpha\n\n- first",
        "# Beta\n\n- second",
        "markdown",
      ],
      ["text/plain", "notes.txt", "alpha line", "beta line", "text"],
      ["application/json", "data.json", '{"alpha":1}', '{"beta":2}', "code"],
    ] as const;
    for (const [mime, name, one, two, kind] of cases) {
      const first = await derivePreview(
        await fixture(Buffer.from(one), mime, name),
      );
      const second = await derivePreview(
        await fixture(Buffer.from(two), mime, name),
      );
      assert.equal(first.visual.kind, kind);
      assert.notDeepEqual(first.visual, second.visual);
    }
  });

  it("derives PDF first-page text when safely parseable and never invents missing content", async () => {
    const one = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\nBT (Synthetic Alpha) Tj ET\n%%EOF",
    );
    const two = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\nBT (Synthetic Beta) Tj ET\n%%EOF",
    );
    const first = await derivePreview(
      await fixture(one, "application/pdf", "paper.pdf"),
    );
    const second = await derivePreview(
      await fixture(two, "application/pdf", "paper.pdf"),
    );
    assert.equal(first.visual.kind, "text");
    assert.deepEqual(first.visual.lines, ["Synthetic Alpha"]);
    assert.notDeepEqual(first.visual, second.visual);

    const malformed = await derivePreview(
      await fixture(
        Buffer.from("%PDF-broken"),
        "application/pdf",
        "broken.pdf",
      ),
    );
    assert.equal(malformed.visual.kind, "binary");
    assert.equal(JSON.stringify(malformed).includes("Synthetic"), false);
  });

  it("derives audio waveform samples from PCM bytes", async () => {
    const quiet = wav([0, 1000, -1000, 500, -500, 0, 800, -800]);
    const loud = wav([0, 16000, -16000, 8000, -8000, 0, 12000, -12000]);
    const first = await derivePreview(
      await fixture(quiet, "audio/wav", "tone.wav"),
    );
    const second = await derivePreview(
      await fixture(loud, "audio/wav", "tone.wav"),
    );
    assert.equal(first.visual.kind, "waveform");
    assert.notDeepEqual(first.visual, second.visual);
    assert.match(first.facts.join(" · "), /00:00/u);
  });

  it("uses safe embedded audio artwork before falling back to a waveform", async () => {
    const red = await generatedMedia(
      [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=8000:duration=0.25",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=64x64:d=0.1",
        "-map",
        "0:a",
        "-map",
        "1:v:0",
        "-c:a",
        "libmp3lame",
        "-c:v",
        "png",
        "-disposition:v",
        "attached_pic",
        "-id3v2_version",
        "3",
        "-metadata:s:v",
        "title=Album cover",
        "-metadata:s:v",
        "comment=Cover (front)",
      ],
      "mp3",
    );
    const blue = await generatedMedia(
      [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=8000:duration=0.25",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=64x64:d=0.1",
        "-map",
        "0:a",
        "-map",
        "1:v:0",
        "-c:a",
        "libmp3lame",
        "-c:v",
        "png",
        "-disposition:v",
        "attached_pic",
        "-id3v2_version",
        "3",
        "-metadata:s:v",
        "title=Album cover",
        "-metadata:s:v",
        "comment=Cover (front)",
      ],
      "mp3",
    );
    const first = await derivePreview(
      await fixture(red, "audio/mpeg", "track.mp3"),
    );
    const second = await derivePreview(
      await fixture(blue, "audio/mpeg", "track.mp3"),
    );
    assert.equal(first.visual.kind, "artwork");
    assert.equal(second.visual.kind, "artwork");
    if (first.visual.kind !== "artwork" || second.visual.kind !== "artwork")
      return;
    assert.notDeepEqual(first.visual.raster, second.visual.raster);
  });

  it("derives a real waveform and duration from supported compressed audio bytes", async () => {
    const low = await generatedMedia(
      [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:sample_rate=8000:duration=0.4",
        "-filter:a",
        "volume=0.1",
        "-c:a",
        "libmp3lame",
      ],
      "mp3",
    );
    const high = await generatedMedia(
      [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=8000:duration=0.4",
        "-filter:a",
        "volume=0.9",
        "-c:a",
        "libmp3lame",
      ],
      "mp3",
    );
    const first = await derivePreview(
      await fixture(low, "audio/mpeg", "voice.mp3"),
    );
    const second = await derivePreview(
      await fixture(high, "audio/mpeg", "voice.mp3"),
    );
    assert.equal(first.visual.kind, "waveform");
    assert.equal(second.visual.kind, "waveform");
    assert.notDeepEqual(first.visual, second.visual);
    assert.match(first.facts.join(" · "), /00:00/u);
  });

  it("validates bounded ZIP metadata without unpacking or exposing traversal names", async () => {
    const first = zip([
      { name: "safe/report.txt", bytes: Buffer.from("alpha") },
      { name: "../../private.txt", bytes: Buffer.from("do-not-expose") },
      { name: "locked.bin", bytes: Buffer.from("secret"), encrypted: true },
      { name: "bomb.bin", bytes: Buffer.alloc(0), declaredSize: 2_000_000_000 },
    ]);
    const second = zip([
      { name: "safe/revised.txt", bytes: Buffer.from("beta") },
    ]);
    const one = await derivePreview(
      await fixture(first, "application/zip", "entries.zip"),
    );
    const two = await derivePreview(
      await fixture(second, "application/zip", "entries.zip"),
    );
    assert.equal(one.visual.kind, "archive");
    if (one.visual.kind !== "archive" || two.visual.kind !== "archive") return;
    assert.deepEqual(one.visual.entries, ["report.txt"]);
    assert.deepEqual(two.visual.entries, ["revised.txt"]);
    assert.notDeepEqual(one.visual.entries, two.visual.entries);
  });

  it("reads only validated bounded archive entry metadata and changes with entry bytes", async () => {
    const first = await derivePreview(
      await fixture(
        tarWithEntry("alpha.txt", "one"),
        "application/x-tar",
        "bundle.tar",
      ),
    );
    const second = await derivePreview(
      await fixture(
        tarWithEntry("beta.txt", "two"),
        "application/x-tar",
        "bundle.tar",
      ),
    );
    assert.equal(first.visual.kind, "archive");
    assert.deepEqual(first.visual.entries, ["alpha.txt"]);
    assert.notDeepEqual(first.visual, second.visual);
  });

  it("fails closed on parser bombs, malformed containers, and symlink sources", async () => {
    const oversizedDocument = await docx("x".repeat(300 * 1024));
    const document = await derivePreview(
      await fixture(
        oversizedDocument,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "bomb.docx",
      ),
    );
    assert.equal(document.visual.kind, "binary");

    const malformedPdf = await derivePreview(
      await fixture(
        Buffer.concat([
          Buffer.from("%PDF-1.7\n"),
          Buffer.alloc(128 * 1024, 0x41),
        ]),
        "application/pdf",
        "malformed.pdf",
      ),
    );
    assert.equal(["binary", "text"].includes(malformedPdf.visual.kind), true);

    if (process.platform !== "win32") {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "fs-preview-link-"),
      );
      temporaryDirectories.push(directory);
      const target = path.join(directory, "target.bin");
      const link = path.join(directory, "source.bin");
      const bytes = Buffer.from("safe");
      await writeFile(target, bytes);
      await import("node:fs/promises").then(({ symlink }) =>
        symlink(target, link),
      );
      await assert.rejects(
        () =>
          derivePreview({
            trustedMime: "application/octet-stream",
            name: "source.bin",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sourcePath: link,
          }),
        /preview source unavailable/u,
      );
    }
  });

  it("rejects source replacement between probe and extraction for every registered strategy", async () => {
    const candidate = await fixture(
      Buffer.from("alpha"),
      "application/x-race",
      "race.bin",
    );
    const registry = new PreviewRendererRegistry().register({
      id: "race",
      priority: 1,
      matches: () => true,
      async probe(input) {
        return { rendererId: "race", input, validated: {} };
      },
      async extract(probe) {
        await writeFile(probe.input.sourcePath, "bravo");
        return {
          family: "binary",
          label: "Binary",
          title: "race.bin",
          facts: [],
          sourceDigest: probe.input.sha256,
          visual: { kind: "binary" },
        };
      },
      renderMetadata(extraction) {
        return extraction;
      },
    });
    await assert.rejects(
      () => derivePreview(candidate, registry),
      /preview source unavailable/u,
    );
  });

  it("preserves safe Markdown structure and code punctuation through the real derivation pipeline", async () => {
    const markdown = await derivePreview(
      await fixture(
        Buffer.from("# Rollout plan\n\n## Checks\n- Verify target\n"),
        "text/markdown",
        "Release runbook.md",
      ),
    );
    assert.equal(markdown.visual.kind, "markdown");
    if (markdown.visual.kind === "markdown") {
      assert.deepEqual(markdown.visual.lines, [
        "# Rollout plan",
        "## Checks",
        "- Verify target",
      ]);
    }

    const code = await derivePreview(
      await fixture(
        Buffer.from(
          "def upload_chunked(path):\n    total = os.path.getsize(path)\n",
        ),
        "text/x-python",
        "upload.py",
      ),
    );
    assert.equal(code.visual.kind, "code");
    if (code.visual.kind === "code") {
      assert.deepEqual(code.visual.lines, [
        "def upload_chunked(path):",
        "    total = os.path.getsize(path)",
      ]);
    }
  });

  it("always checksum-binds sources above 25 MiB and rejects same-size replacement", async () => {
    const original = Buffer.alloc(26 * 1024 * 1024, 0x61);
    const source = await fixture(original, "text/plain", "large.txt");
    await writeFile(source.sourcePath, Buffer.alloc(original.length, 0x62));
    await assert.rejects(derivePreview(source), /preview source unavailable/u);
  });

  it("derives bounded TAR.GZ metadata from compressed bytes", async () => {
    const first = gzipSync(tarWithEntry("manifest.json", "one"), {
      level: 9,
    });
    const second = gzipSync(tarWithEntry("database.sql", "two"), {
      level: 9,
    });
    const one = await derivePreview(
      await fixture(first, "application/gzip", "site-backup.tar.gz"),
    );
    const two = await derivePreview(
      await fixture(second, "application/gzip", "site-backup.tar.gz"),
    );
    assert.equal(one.label, "TAR.GZ");
    assert.equal(one.visual.kind, "archive");
    if (one.visual.kind === "archive" && two.visual.kind === "archive") {
      assert.deepEqual(one.visual.entries, ["manifest.json"]);
      assert.deepEqual(two.visual.entries, ["database.sql"]);
    }
  });

  it("uses subtype labels, approved fact ordering, and byte-derived binary hex", async () => {
    const jpeg = await sharp({
      create: { width: 20, height: 12, channels: 3, background: "red" },
    })
      .jpeg()
      .toBuffer();
    const image = await derivePreview(
      await fixture(jpeg, "image/jpeg", "photo.jpg"),
    );
    assert.equal(image.label, "JPG");
    assert.deepEqual(image.facts, [`${jpeg.length} B`, "20×12"]);

    const binary = await derivePreview(
      await fixture(
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]),
        "application/octet-stream",
        "firmware.bin",
      ),
    );
    assert.equal(binary.label, "BIN");
    assert.deepEqual(binary.visual, {
      kind: "binary",
      hex: "7F 45 4C 46 02 01",
    });
  });

  it("derives public labels from trusted MIME and validated parser results", async () => {
    const cases = [
      ["text/x-typescript", "misleading.py", "const x: string = 'a';", "TS"],
      ["text/x-python", "misleading.ts", "value: str = 'a'", "PY"],
      ["video/webm", "misleading.mp4", "not media", "WebM"],
      ["video/x-msvideo", "misleading.mov", "not media", "AVI"],
      ["video/mpeg", "misleading.webm", "not media", "MPEG"],
      ["video/quicktime", "misleading.avi", "not media", "QuickTime"],
      ["application/ld+json", "feed.xml", '{"@context":"x"}', "JSON-LD"],
      ["application/rss+xml", "feed.json", "<rss/>", "RSS"],
      ["application/xml", "feed.json", "<root/>", "XML"],
    ] as const;
    for (const [mime, name, contents, label] of cases) {
      const preview = await derivePreview(
        await fixture(Buffer.from(contents), mime, name),
      );
      assert.equal(preview.label, label, `${mime} must ignore ${name}`);
    }
    const plainGzip = await derivePreview(
      await fixture(
        gzipSync(Buffer.from("plain")),
        "application/gzip",
        "fake.tar.gz",
      ),
    );
    assert.equal(plainGzip.label, "GZIP");
    const validatedTar = await derivePreview(
      await fixture(
        gzipSync(tarWithEntry("entry.txt", "data"), { level: 9 }),
        "application/gzip",
        "misleading.gz",
      ),
    );
    assert.equal(validatedTar.label, "TAR.GZ");
  });

  it("checksum-binds a 26 MiB historical source and rejects a same-size replacement", async () => {
    const original = Buffer.alloc(26 * 1024 * 1024, 0x61);
    const source = await fixture(
      original,
      "application/octet-stream",
      "historical.bin",
    );
    const preview = await derivePreview(source);
    assert.equal(preview.sourceDigest, source.sha256);
    await writeFile(source.sourcePath, Buffer.alloc(original.length, 0x62));
    await assert.rejects(derivePreview(source), /preview source unavailable/u);
  });

  it("validates source checksum and generic facts without exposing raw bytes", async () => {
    const source = await fixture(
      Buffer.from([0, 1, 2, 3]),
      "application/octet-stream",
      "firmware.bin",
    );
    const preview = await derivePreview(source);
    assert.equal(preview.visual.kind, "binary");
    assert.deepEqual(preview.facts, ["4 B"]);
    await assert.rejects(
      derivePreview({ ...source, sha256: "0".repeat(64) }),
      /preview source unavailable/u,
    );
  });
});
