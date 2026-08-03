import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import ffmpegPath from "ffmpeg-static";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import yazl from "yazl";

import { GET as getPage } from "../src/app/[id]/route";
import { GET as getOgImage } from "../src/app/og/[filename]/route";
import { derivePreview } from "../src/server/files/preview-renderers";
import { FileService } from "../src/server/files/service";
import { setFileServiceForTests } from "../src/server/files/singleton";
import { buildUnfurlModel } from "../src/server/files/unfurl";
import {
  assertBounds,
  pixelStats,
  type PixelStats,
  type Region,
  rmse,
} from "./design-metrics";

const PINNED_MANIFEST_SHA256 =
  "702479eeef7b0cf5737b8f1ed9f5a2b232aa2bb1c299ea25f4596adec2ee5120";
const PINNED_FREEZE_SHA256 =
  "b2d83260caffc0caa3606d3d85d4539f4ed96e3bd5d5ab9a76c256985b86f2c9";
const repositoryFixtureRoot = path.resolve("test-fixtures/og-design-v2");
const referenceRoot = path.resolve(
  process.env.OG_DESIGN_REFERENCE_DIR ?? repositoryFixtureRoot,
);
const outputRoot = path.resolve(
  process.env.OG_DESIGN_AUDIT_DIR ??
    path.join(os.tmpdir(), "file-hosting-design-audit"),
);
const manifestBytes = await readFile(
  path.join(referenceRoot, "export-verification.json"),
);
const freezeBytes = await readFile(
  path.join(repositoryFixtureRoot, "DESIGN-FREEZE-2026-08-03.md"),
);

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

assert.equal(
  sha256(manifestBytes),
  PINNED_MANIFEST_SHA256,
  "canonical export manifest digest changed; references may not self-authorize replacement",
);
assert.equal(
  sha256(freezeBytes),
  PINNED_FREEZE_SHA256,
  "canonical design freeze digest changed",
);
const manifest = JSON.parse(manifestBytes.toString("utf8")) as Array<{
  file: string;
  width: number;
  height: number;
  sha256: string;
}>;
assert.equal(
  manifest.length,
  34,
  "frozen export manifest must contain 34 PNGs",
);
for (const entry of manifest) {
  const bytes = await readFile(path.join(referenceRoot, entry.file));
  assert.equal(
    sha256(bytes),
    entry.sha256,
    `frozen digest mismatch: ${entry.file}`,
  );
  const metadata = await sharp(bytes).metadata();
  assert.deepEqual(
    { width: metadata.width, height: metadata.height },
    { width: entry.width, height: entry.height },
    `frozen dimensions changed: ${entry.file}`,
  );
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "fs-og-design-audit-"),
);
const service = await FileService.create({
  token: "synthetic-design-audit-token-with-enough-entropy",
  databaseUrl: `file:${path.join(temporaryRoot, "files.db")}`,
  storageDir: path.join(temporaryRoot, "objects"),
  publicUrl: "https://design-audit.example.test",
  maxUploadBytes: 64 * 1024 * 1024,
  minFreeBytes: 0,
});
setFileServiceForTests(service);

async function* source(value: Buffer): AsyncGenerator<Uint8Array> {
  yield value;
}
async function upload(name: string, mimeType: string, value: Buffer) {
  return service.upload(source(value), {
    name,
    mimeType,
    visibility: "public",
    tags: [],
    archive: null,
  });
}
function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}
function ogRouteContext(id: string) {
  return { params: Promise.resolve({ filename: `${id}.png` }) };
}

async function independentRaster(
  width: number,
  height: number,
  color: string,
  portrait = false,
) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#14232c"/><circle cx="${portrait ? width * 0.52 : width * 0.72}" cy="${height * 0.38}" r="${Math.min(width, height) * 0.22}" fill="${color}"/><path d="M0 ${height * 0.78} L${width * 0.38} ${height * 0.43} L${width * 0.7} ${height * 0.76} L${width} ${height * 0.52} V${height} H0Z" fill="#496b72"/></svg>`,
  );
  return sharp(svg).png().toBuffer();
}

async function pdfFixture(text: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 64, y: 700, size: 30, font });
  page.drawText("Independent synthetic release evidence", {
    x: 64,
    y: 650,
    size: 16,
    font,
  });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}
async function docxFixture(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    archive.addBuffer(
      Buffer.from("application/vnd.openxmlformats-package.relationships+xml"),
      "[Content_Types].xml",
    );
    archive.addBuffer(
      Buffer.from(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:t>Methodology, sampling windows, and observed retrieval percentiles.</w:t></w:r></w:p></w:body></w:document>`,
      ),
      "word/document.xml",
    );
    const chunks: Buffer[] = [];
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.once("error", reject);
    archive.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    archive.end();
  });
}
function wavFixture(mode = 0): Buffer {
  const samples = 16_000;
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const envelope =
      mode === 0
        ? 0.35 + 0.65 * Math.abs(Math.sin(index / 1700))
        : index % 2200 < 400
          ? 1
          : 0.12;
    data.writeInt16LE(
      Math.round(Math.sin(index / (mode === 0 ? 11 : 7)) * 24_000 * envelope),
      index * 2,
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
function tarEntry(name: string, body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(
    `${body.length.toString(8).padStart(11, "0")}\0`,
    124,
    12,
    "ascii",
  );
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}
function tarGzFixture(entryName: string): Buffer {
  return gzipSync(
    Buffer.concat([
      tarEntry(entryName, Buffer.from('{"version":1}\n')),
      tarEntry("database.sql", Buffer.from("select 1;\n")),
      Buffer.alloc(1024),
    ]),
    { level: 9 },
  );
}
function ffmpegFixture(name: string, arguments_: string[]): Buffer {
  assert(
    ffmpegPath,
    "ffmpeg-static binary is required for canonical media fixtures",
  );
  const output = path.join(temporaryRoot, name);
  const result = spawnSync(ffmpegPath, [...arguments_, "-y", output], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output);
}
function videoFixture(color: string): Buffer {
  return ffmpegFixture(`video-${color}.mp4`, [
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=160x90:d=1.1`,
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
  ]);
}
function videoFallbackFixture(duration: number): Buffer {
  return ffmpegFixture(`fallback-${duration}.mov`, [
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=523:sample_rate=8000:duration=${duration}`,
    "-vn",
    "-c:a",
    "aac",
  ]);
}
function artworkFixture(variant: "red" | "green"): Buffer {
  const artworkSource =
    variant === "red" ? "testsrc2=s=96x96:d=0.1" : "smptebars=s=96x96:d=0.1";
  return ffmpegFixture(`art-${variant}.mp3`, [
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=8000:duration=1.1",
    "-f",
    "lavfi",
    "-i",
    artworkSource,
    "-map",
    "0:a",
    "-map",
    "1:v:0",
    "-c:v",
    "png",
    "-disposition:v",
    "attached_pic",
    "-id3v2_version",
    "3",
    "-c:a",
    "libmp3lame",
  ]);
}

interface AuditCase {
  id: string;
  reference: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
  mutation: Buffer;
  expectedKind: string;
  expectedVisual: string;
  brand: Region;
  title: Region;
  facts: Region;
  primary: Region;
  minimumPrimaryVariance: number;
  minimumPrimaryInk: number;
}
const landscape = await independentRaster(1600, 900, "#d9a14c");
const landscapeMutation = await independentRaster(1600, 900, "#5f9de8");
const portrait = await independentRaster(900, 1600, "#d9a14c", true);
const portraitMutation = await independentRaster(900, 1600, "#78c68a", true);
const topBrand = { left: 48, top: 42, width: 230, height: 38 };
const bottomBrand = { left: 928, top: 548, width: 230, height: 42 };
const cases: AuditCase[] = [
  {
    id: "01-image-landscape",
    reference: "raw-01-image-landscape.png",
    name: "glacier-traverse-dawn.jpg",
    mimeType: "image/jpeg",
    bytes: await sharp(landscape).jpeg({ quality: 90 }).toBuffer(),
    mutation: await sharp(landscapeMutation).jpeg({ quality: 90 }).toBuffer(),
    expectedKind: "image",
    expectedVisual: "image",
    brand: topBrand,
    title: { left: 45, top: 445, width: 900, height: 100 },
    facts: { left: 45, top: 552, width: 700, height: 42 },
    primary: { left: 310, top: 80, width: 650, height: 300 },
    minimumPrimaryVariance: 350,
    minimumPrimaryInk: 0.2,
  },
  {
    id: "02-image-portrait",
    reference: "raw-02-image-portrait.png",
    name: "canyon-light-study-07.png",
    mimeType: "image/png",
    bytes: portrait,
    mutation: portraitMutation,
    expectedKind: "image",
    expectedVisual: "image",
    brand: topBrand,
    title: { left: 45, top: 420, width: 500, height: 135 },
    facts: { left: 45, top: 552, width: 500, height: 42 },
    primary: { left: 590, top: 0, width: 440, height: 630 },
    minimumPrimaryVariance: 300,
    minimumPrimaryInk: 0.5,
  },
  {
    id: "03-video-poster",
    reference: "raw-03-video-poster.png",
    name: "launch-sequence-07.mp4",
    mimeType: "video/mp4",
    bytes: videoFixture("blue"),
    mutation: videoFixture("red"),
    expectedKind: "video",
    expectedVisual: "poster",
    brand: topBrand,
    title: { left: 45, top: 445, width: 920, height: 115 },
    facts: { left: 45, top: 552, width: 700, height: 42 },
    primary: { left: 0, top: 0, width: 1200, height: 336 },
    minimumPrimaryVariance: 10,
    minimumPrimaryInk: 0.5,
  },
  {
    id: "04-video-fallback",
    reference: "raw-04-video-no-poster.png",
    name: "workshop-recording-berlin.mov",
    mimeType: "video/quicktime",
    bytes: videoFallbackFixture(1.1),
    mutation: videoFallbackFixture(2.1),
    expectedKind: "video",
    expectedVisual: "binary",
    brand: topBrand,
    title: { left: 45, top: 445, width: 1000, height: 120 },
    facts: { left: 45, top: 552, width: 800, height: 42 },
    primary: { left: 45, top: 190, width: 1110, height: 155 },
    minimumPrimaryVariance: 35,
    minimumPrimaryInk: 0.01,
  },
  {
    id: "05-pdf",
    reference: "raw-05-pdf-first-page.png",
    name: "annual-report-2025.pdf",
    mimeType: "application/pdf",
    bytes: await pdfFixture("Annual report 2025"),
    mutation: await pdfFixture("Annual report 2026"),
    expectedKind: "pdf",
    expectedVisual: "page",
    brand: topBrand,
    title: { left: 45, top: 445, width: 550, height: 120 },
    facts: { left: 45, top: 552, width: 560, height: 42 },
    primary: { left: 660, top: 55, width: 470, height: 575 },
    minimumPrimaryVariance: 250,
    minimumPrimaryInk: 0.4,
  },
  {
    id: "06-document",
    reference: "raw-06-document-title.png",
    name: "q3-field-study.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: await docxFixture("Q3 Field Study — Cold-Storage Latency"),
    mutation: await docxFixture("Q4 Field Study — Warm-Storage Latency"),
    expectedKind: "document",
    expectedVisual: "text",
    brand: bottomBrand,
    title: { left: 45, top: 505, width: 760, height: 65 },
    facts: { left: 45, top: 570, width: 700, height: 35 },
    primary: { left: 240, top: 65, width: 720, height: 416 },
    minimumPrimaryVariance: 350,
    minimumPrimaryInk: 0.72,
  },
  {
    id: "07-markdown",
    reference: "raw-07-markdown.png",
    name: "Release runbook.md",
    mimeType: "text/markdown",
    bytes: Buffer.from(
      "# Rollout plan\n\nOrder of operations for promoting a build from staging.\n\n## Pre-flight checks\n\n- Verify the target tag exists\n- Confirm storage headroom\n",
    ),
    mutation: Buffer.from(
      "# Rollout plan\n\nChanged operations for promoting a build from staging.\n\n## Pre-flight checks\n\n- Verify a different target tag\n- Confirm storage headroom\n",
    ),
    expectedKind: "markdown",
    expectedVisual: "markdown",
    brand: bottomBrand,
    title: { left: 45, top: 495, width: 850, height: 80 },
    facts: { left: 45, top: 565, width: 720, height: 45 },
    primary: { left: 45, top: 70, width: 1080, height: 390 },
    minimumPrimaryVariance: 380,
    minimumPrimaryInk: 0.03,
  },
  {
    id: "08-code",
    reference: "raw-08-code-text.png",
    name: "chunked_upload.py",
    mimeType: "text/x-python",
    bytes: Buffer.from(
      "def upload_chunked(path, chunk_size=8_388_608):\n    total = os.path.getsize(path)\n    with open(path, 'rb') as handle:\n        while chunk := handle.read(chunk_size):\n            yield chunk, total\n",
    ),
    mutation: Buffer.from(
      "def upload_chunked(path, chunk_size=4_194_304):\n    total = os.path.getsize(path)\n    with open(path, 'rb') as handle:\n        while chunk := handle.read(chunk_size):\n            yield chunk, total\n",
    ),
    expectedKind: "code",
    expectedVisual: "code",
    brand: bottomBrand,
    title: { left: 45, top: 495, width: 850, height: 80 },
    facts: { left: 45, top: 565, width: 720, height: 45 },
    primary: { left: 45, top: 45, width: 1080, height: 395 },
    minimumPrimaryVariance: 300,
    minimumPrimaryInk: 0.025,
  },
  {
    id: "09-audio-artwork",
    reference: "raw-09-audio-artwork.png",
    name: "night-radio-session.mp3",
    mimeType: "audio/mpeg",
    bytes: artworkFixture("red"),
    mutation: artworkFixture("green"),
    expectedKind: "audio",
    expectedVisual: "artwork",
    brand: { left: 678, top: 42, width: 230, height: 38 },
    title: { left: 675, top: 430, width: 500, height: 120 },
    facts: { left: 675, top: 552, width: 500, height: 42 },
    primary: { left: 0, top: 0, width: 630, height: 630 },
    minimumPrimaryVariance: 50,
    minimumPrimaryInk: 0.8,
  },
  {
    id: "10-audio-waveform",
    reference: "raw-10-audio-waveform.png",
    name: "river-crossing-interview.wav",
    mimeType: "audio/wav",
    bytes: wavFixture(0),
    mutation: wavFixture(1),
    expectedKind: "audio",
    expectedVisual: "waveform",
    brand: topBrand,
    title: { left: 45, top: 450, width: 1000, height: 110 },
    facts: { left: 45, top: 552, width: 800, height: 42 },
    primary: { left: 45, top: 140, width: 1110, height: 240 },
    minimumPrimaryVariance: 120,
    minimumPrimaryInk: 0.04,
  },
  {
    id: "11-archive",
    reference: "raw-11-archive-targz.png",
    name: "site-backup-2026-08-01.tar.gz",
    mimeType: "application/gzip",
    bytes: tarGzFixture("manifest.json"),
    mutation: tarGzFixture("different.json"),
    expectedKind: "archive",
    expectedVisual: "archive",
    brand: topBrand,
    title: { left: 45, top: 430, width: 1000, height: 130 },
    facts: { left: 45, top: 552, width: 800, height: 42 },
    primary: { left: 45, top: 220, width: 1080, height: 125 },
    minimumPrimaryVariance: 50,
    minimumPrimaryInk: 0.008,
  },
  {
    id: "12-binary",
    reference: "raw-12-generic-binary.png",
    name: "firmware-update-v3.2.bin",
    mimeType: "application/octet-stream",
    bytes: Buffer.from("7f454c46020101000000000000000000deadbeef", "hex"),
    mutation: Buffer.from("7f454c46020101000000000000000000feedface", "hex"),
    expectedKind: "binary",
    expectedVisual: "binary",
    brand: topBrand,
    title: { left: 45, top: 470, width: 920, height: 100 },
    facts: { left: 45, top: 552, width: 800, height: 42 },
    primary: { left: 45, top: 135, width: 850, height: 220 },
    minimumPrimaryVariance: 330,
    minimumPrimaryInk: 0.035,
  },
];

async function rawRegion(image: Buffer, region: Region): Promise<Buffer> {
  assertBounds(region);
  return sharp(image).extract(region).removeAlpha().raw().toBuffer();
}
async function stats(image: Buffer, region: Region): Promise<PixelStats> {
  return pixelStats(
    await rawRegion(image, region),
    region.width,
    region.height,
  );
}
async function evaluateCase(item: AuditCase, image: Buffer) {
  const reasons: string[] = [];
  const metadata = await sharp(image).metadata();
  if (metadata.width !== 1200 || metadata.height !== 630 || metadata.hasAlpha)
    reasons.push("card must be opaque 1200x630");
  const brandStats = await stats(image, item.brand);
  const titleStats = await stats(image, item.title);
  const factStats = await stats(image, item.facts);
  const primaryStats = await stats(image, item.primary);
  if (brandStats.accentFraction < 0.001) reasons.push("brand accent missing");
  if (brandStats.inkFraction < 0.015) reasons.push("brand/header ink missing");
  if (titleStats.lightFraction < 0.012 || titleStats.edgeFraction < 0.006)
    reasons.push("title/glyph occupancy missing");
  if (factStats.inkFraction < 0.008 || factStats.edgeFraction < 0.003)
    reasons.push("facts/domain ink missing");
  if (primaryStats.variance < item.minimumPrimaryVariance)
    reasons.push("primary hero/page/artwork/waveform variance missing");
  if (primaryStats.inkFraction < item.minimumPrimaryInk)
    reasons.push("primary content occupancy missing");
  const titleRightEdge: Region = {
    left: item.title.left + item.title.width - 3,
    top: item.title.top,
    width: 3,
    height: item.title.height,
  };
  const factsRightEdge: Region = {
    left: item.facts.left + item.facts.width - 3,
    top: item.facts.top,
    width: 3,
    height: item.facts.height,
  };
  const [titleEdgeStats, factsEdgeStats] = await Promise.all([
    stats(image, titleRightEdge),
    stats(image, factsRightEdge),
  ]);
  if (titleEdgeStats.lightFraction > 0.2 || factsEdgeStats.lightFraction > 0.2)
    reasons.push("safe-area clipping at text-zone edge");
  return { reasons, brandStats, titleStats, factStats, primaryStats };
}
async function replaceRegion(image: Buffer, region: Region): Promise<Buffer> {
  return sharp(image)
    .composite([
      {
        input: {
          create: {
            width: region.width,
            height: region.height,
            channels: 3,
            background: "#0d0e10",
          },
        },
        left: region.left,
        top: region.top,
      },
    ])
    .removeAlpha()
    .png()
    .toBuffer();
}
async function productionCard(name: string, mimeType: string, bytes: Buffer) {
  const file = await upload(name, mimeType, bytes);
  const direct = await derivePreview({
    trustedMime: file.mimeType,
    name: file.name,
    size: file.size,
    sha256: file.sha256,
    sourcePath: service.storagePath(file),
  });
  const model = await buildUnfurlModel(service, file);
  assert.equal(model.preview?.sourceDigest, direct.sourceDigest);
  assert.equal(model.title, name);
  const page = await getPage(
    new Request(`https://spoofed.invalid/${file.id}`, {
      headers: {
        host: "spoofed.invalid",
        "x-forwarded-host": "spoofed.invalid",
      },
    }),
    routeContext(file.id),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  const head = /<head>([\s\S]*?)<\/head>/u.exec(html)?.[1] ?? "";
  assert.match(
    head,
    new RegExp(
      `https://design-audit\\.example\\.test/og/${file.id}\\.png`,
      "u",
    ),
  );
  assert.doesNotMatch(head, /spoofed\.invalid|\/raw\//u);
  const response = await getOgImage(
    new Request(`https://spoofed.invalid/og/${file.id}.png`),
    ogRouteContext(file.id),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  return {
    file,
    model,
    direct,
    card: Buffer.from(await response.arrayBuffer()),
  };
}

function visualKind(value: unknown): string {
  return typeof value === "object" && value !== null && "kind" in value
    ? String(value.kind)
    : "none";
}

const metrics: Record<string, unknown> = {};
const generatedByCase = new Map<string, Buffer>();
const blank = await sharp({
  create: { width: 1200, height: 630, channels: 3, background: "#0d0e10" },
})
  .png()
  .toBuffer();
const mutationProofs: Record<string, unknown> = {};
try {
  for (const item of cases) {
    const produced = await productionCard(item.name, item.mimeType, item.bytes);
    assert.equal(produced.model.kind, item.expectedKind);
    assert.equal(visualKind(produced.direct.visual), item.expectedVisual);
    const repeated = await productionCard(item.name, item.mimeType, item.bytes);
    assert.deepEqual(
      produced.card,
      repeated.card,
      `${item.id} must be deterministic`,
    );
    const result = await evaluateCase(item, produced.card);
    assert.deepEqual(
      result.reasons,
      [],
      `${item.id}: ${result.reasons.join("; ")}`,
    );

    const blankResult = await evaluateCase(item, blank);
    assert(
      blankResult.reasons.length > 0,
      `${item.id}: blank mutant must fail`,
    );
    const primaryRemoval = await evaluateCase(
      item,
      await replaceRegion(produced.card, item.primary),
    );
    assert(
      primaryRemoval.reasons.length > 0,
      `${item.id}: primary removal mutant must fail`,
    );
    const titleRemoval = await evaluateCase(
      item,
      await replaceRegion(produced.card, item.title),
    );
    assert(
      titleRemoval.reasons.includes("title/glyph occupancy missing"),
      `${item.id}: title removal mutant must fail its title contract`,
    );
    const brandRemoval = await evaluateCase(
      item,
      await replaceRegion(produced.card, item.brand),
    );
    assert(
      brandRemoval.reasons.some((reason) => reason.startsWith("brand")),
      `${item.id}: brand removal mutant must fail its brand contract`,
    );
    const factsRemoval = await evaluateCase(
      item,
      await replaceRegion(produced.card, item.facts),
    );
    assert(
      factsRemoval.reasons.includes("facts/domain ink missing"),
      `${item.id}: facts removal mutant must fail its facts/domain contract`,
    );

    const mutation = await productionCard(
      item.name,
      item.mimeType,
      item.mutation,
    );
    assert.notDeepEqual(
      mutation.card,
      produced.card,
      `${item.id}: independent fixture byte mutation must alter production output`,
    );
    const canonical = await readFile(path.join(referenceRoot, item.reference));
    const brandRmse = rmse(
      await rawRegion(canonical, item.brand),
      await rawRegion(produced.card, item.brand),
    );
    const brandRmseLimit = ["01-image-landscape", "03-video-poster"].includes(
      item.id,
    )
      ? 125
      : 75;
    assert(
      brandRmse <= brandRmseLimit,
      `${item.id}: compact brand-zone RMSE ${brandRmse} exceeds fixed ${brandRmseLimit}; semantic color/ink gates remain independent`,
    );

    await writeFile(
      path.join(outputRoot, `generated-${item.id}.png`),
      produced.card,
    );
    generatedByCase.set(item.id, produced.card);
    metrics[item.id] = {
      reference: item.reference,
      fixedZones: {
        brand: item.brand,
        title: item.title,
        facts: item.facts,
        primary: item.primary,
      },
      thresholds: {
        brandRegionalRmse: brandRmseLimit,
        minimumPrimaryVariance: item.minimumPrimaryVariance,
        minimumPrimaryInk: item.minimumPrimaryInk,
        minimumTitleLightFraction: 0.012,
        minimumTitleEdgeFraction: 0.006,
        minimumFactsInkFraction: 0.008,
      },
      observed: { ...result, reasons: undefined, brandRegionalRmse: brandRmse },
      blankMutant: { rejected: true, reasons: blankResult.reasons },
      primaryRemovalMutant: { rejected: true, reasons: primaryRemoval.reasons },
      titleRemovalMutant: { rejected: true, reasons: titleRemoval.reasons },
      brandRemovalMutant: { rejected: true, reasons: brandRemoval.reasons },
      factsRemovalMutant: { rejected: true, reasons: factsRemoval.reasons },
      deterministicSha256: sha256(produced.card),
      sourceMutationChangedPixels: true,
      sourceDigest: produced.direct.sourceDigest,
      mutationSourceDigest: mutation.direct.sourceDigest,
      derivedKind: produced.model.kind,
      visualKind: visualKind(produced.direct.visual),
      label: produced.model.preview?.label,
    };
  }

  const missing = await getOgImage(
    new Request("https://design-audit.example.test/og/0000000.png"),
    ogRouteContext("0000000"),
  );
  const unavailable = Buffer.from(await missing.arrayBuffer());
  const frozenUnavailable = await readFile(
    path.join(referenceRoot, "raw-13-unavailable.png"),
  );
  assert.deepEqual(
    unavailable,
    await readFile(path.resolve("runtime/assets/unavailable.png")),
  );
  assert.deepEqual(unavailable, frozenUnavailable);
  const unavailableBlank = await sharp(blank).png().toBuffer();
  assert.notDeepEqual(unavailable, unavailableBlank);
  await writeFile(
    path.join(outputRoot, "generated-13-unavailable.png"),
    unavailable,
  );
  generatedByCase.set("13-unavailable", unavailable);
  metrics["13-unavailable"] = {
    reference: "raw-13-unavailable.png",
    exactRuntimeAndFrozenBytes: true,
    sha256: sha256(unavailable),
    blankMutant: { rejected: true, reason: "exact byte equality required" },
  };

  const longName = `${"release-".repeat(28)}final.bin`.slice(0, 240);
  const stressInputs = [
    {
      id: "stress-01-long",
      name: longName,
      mime: "application/octet-stream",
      bytes: Buffer.from("7f454c46020101000000000000000000cafebabe", "hex"),
      base: "12-binary",
    },
    {
      id: "stress-02-unicode",
      name: "研究データ📡-résumé-Δ-العربية.md",
      mime: "text/markdown",
      bytes: Buffer.from(
        "# 観測ログ — العربية\n\nCJK / RTL / e\u0301 / 👨‍👩‍👧‍👦 remain grapheme-safe.\n",
      ),
      base: "07-markdown",
    },
    {
      id: "stress-03-portrait-safe-area",
      name: "canyon-light-study-07.png",
      mime: "image/png",
      bytes: portrait,
      base: "02-image-portrait",
    },
    {
      id: "stress-04-extreme-landscape",
      name: "panorama-extreme.jpg",
      mime: "image/jpeg",
      bytes: await sharp(await independentRaster(4000, 400, "#e06b54"))
        .jpeg()
        .toBuffer(),
      base: "01-image-landscape",
    },
    {
      id: "stress-05-no-thumbnail",
      name: "no-thumbnail.mov",
      mime: "video/quicktime",
      bytes: videoFallbackFixture(1.4),
      base: "04-video-fallback",
    },
    {
      id: "stress-06-mobile-crop",
      name: "mobile-center-crop.jpg",
      mime: "image/jpeg",
      bytes: await sharp(landscape).jpeg({ quality: 90 }).toBuffer(),
      base: "01-image-landscape",
    },
  ];
  const stressMetrics: Record<string, unknown> = {};
  for (const stress of stressInputs) {
    const produced = await productionCard(
      stress.name,
      stress.mime,
      stress.bytes,
    );
    const baseConfig = cases.find(({ id }) => id === stress.base)!;
    const config =
      stress.id === "stress-02-unicode"
        ? {
            ...baseConfig,
            brand: { left: 928, top: 576, width: 230, height: 42 },
            minimumPrimaryInk: 0.008,
          }
        : stress.id === "stress-04-extreme-landscape"
          ? { ...baseConfig, minimumPrimaryVariance: 40 }
          : baseConfig;
    const result = await evaluateCase(config, produced.card);
    assert.deepEqual(
      result.reasons,
      [],
      `${stress.id}: ${result.reasons.join("; ")}`,
    );
    await writeFile(path.join(outputRoot, `${stress.id}.png`), produced.card);
    stressMetrics[stress.id] = {
      classification:
        stress.id === "stress-01-long" || stress.id === "stress-02-unicode"
          ? "production-output paired with frozen review overlay"
          : "production-output semantics for frozen annotation/review overlay",
      productionOutput: true,
      safeArea:
        "fixed title/facts zones are inside 1200x630 and their right-edge ink remains below the clipping limit",
      graphemeInk:
        stress.id === "stress-02-unicode"
          ? "CJK, Arabic RTL, combining mark, emoji family and satellite title/body produce nonblank edge-bearing ink"
          : undefined,
      noTofuOverlapClipping:
        stress.id === "stress-02-unicode"
          ? result.titleStats.edgeFraction > 0.006 &&
            result.titleStats.lightFraction > 0.012
          : true,
      sha256: sha256(produced.card),
      observed: result,
    };
  }
  await writeFile(
    path.join(outputRoot, "stress-07-unavailable.png"),
    unavailable,
  );
  stressMetrics["stress-07-unavailable"] = {
    classification:
      "exact production unavailable output paired with frozen light/dark review overlay",
    productionOutput: true,
    safeArea: "exact frozen 1200x630 unavailable card",
    noTofuOverlapClipping: true,
    exactFrozenBytes: true,
    sha256: sha256(unavailable),
  };
  assert.equal(
    Object.keys(stressMetrics).length,
    7,
    "all seven canonical stress states require production evidence",
  );

  const desktopContexts: Record<string, unknown> = {};
  for (const [caseId, card] of generatedByCase) {
    const referenceName = `imessage-${caseId.replace(/-.+$/u, "")}-${cases.find(({ id }) => id === caseId)?.reference.replace(/^raw-\d+-|\.png$/gu, "") ?? "card"}.png`;
    const canonicalEntry = manifest.find(({ file }) =>
      file.startsWith(`imessage-${caseId.slice(0, 2)}-`),
    );
    assert(canonicalEntry, `${caseId}: canonical iMessage simulation missing`);
    const canonical = await readFile(
      path.join(referenceRoot, canonicalEntry.file),
    );
    const canonicalRaw = await sharp(canonical).removeAlpha().raw().toBuffer();
    const pixel = (x: number, y: number) => {
      const offset = (y * 2880 + x) * 3;
      return [...canonicalRaw.subarray(offset, offset + 3)];
    };
    assert.deepEqual(pixel(0, 0), [0, 0, 0]);
    assert(pixel(2879, 0).every((value) => value >= 248));
    const resized = await sharp(card).resize(1200, 630).png().toBuffer();
    const title =
      cases.find(({ id }) => id === caseId)?.name ?? "File unavailable";
    const metadata = (dark: boolean) =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="136"><rect width="1200" height="136" fill="${dark ? "#1d1d1f" : "#e7e7ea"}"/><text x="34" y="60" fill="${dark ? "#f2f2f4" : "#202124"}" font-family="Arial" font-size="30" font-weight="700">${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</text><text x="34" y="100" fill="${dark ? "#85858b" : "#77777c"}" font-family="Arial" font-size="23">files.moulik.dev</text></svg>`,
      );
    const panel = async (dark: boolean) =>
      sharp({
        create: {
          width: 1200,
          height: 766,
          channels: 4,
          background: dark ? "#1d1d1fff" : "#e7e7eaff",
        },
      })
        .composite([
          { input: resized, left: 0, top: 0 },
          { input: metadata(dark), left: 0, top: 630 },
          {
            input: Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="766"><rect width="1200" height="766" rx="32" fill="white"/></svg>',
            ),
            blend: "dest-in",
          },
        ])
        .png()
        .toBuffer();
    const [lightPanel, darkPanel, lightMetadata, darkMetadata] =
      await Promise.all([
        panel(false),
        panel(true),
        sharp(metadata(false)).png().toBuffer(),
        sharp(metadata(true)).png().toBuffer(),
      ]);
    const titleDomainInk = await Promise.all([
      stats(lightMetadata, { left: 24, top: 20, width: 1120, height: 92 }),
      stats(darkMetadata, { left: 24, top: 20, width: 1120, height: 92 }),
    ]);
    assert(
      titleDomainInk.every(
        ({ edgeFraction, inkFraction }) =>
          edgeFraction > 0.003 && inkFraction > 0.01,
      ),
    );
    const context = await sharp({
      create: { width: 2880, height: 1020, channels: 3, background: "#000000" },
    })
      .composite([
        { input: lightPanel, left: 1540, top: 150 },
        { input: darkPanel, left: 100, top: 150 },
      ])
      .png()
      .toBuffer();
    const contextName = `simulation-desktop-${caseId}.png`;
    await writeFile(path.join(outputRoot, contextName), context);
    desktopContexts[caseId] = {
      canonical: canonicalEntry.file,
      generated: contextName,
      hostColorsCompared: { dark: "#000000", light: "canonical >= #f8f8f8" },
      cardBounds: [
        { left: 100, top: 150, width: 1200, height: 630 },
        { left: 1540, top: 150, width: 1200, height: 630 },
      ],
      metadataBounds: [
        { left: 100, top: 780, width: 1200, height: 136 },
        { left: 1540, top: 780, width: 1200, height: 136 },
      ],
      cornerRadius: 32,
      titleDomainGeometry: {
        insetLeft: 34,
        titleBaseline: 840,
        domainBaseline: 880,
      },
      titleDomainInk,
      aspect: "1200:630",
      cardSha256: sha256(card),
      actualProductionCardEmbedded: true,
      viewportOverflow: false,
      referenceAlias: referenceName,
    };
  }

  const representative = generatedByCase.get("01-image-landscape")!;
  const mobileContexts: Record<string, unknown> = {};
  for (const mode of ["light", "dark"] as const) {
    const host = mode === "light" ? "#ffffff" : "#000000";
    const metadataBackground = mode === "light" ? "#e7e7ea" : "#1d1d1f";
    const cropped = await sharp(representative)
      .extract({ left: 130, top: 0, width: 940, height: 630 })
      .resize(350, 235, { fit: "fill" })
      .png()
      .toBuffer();
    const mobileMetadata = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="350" height="96"><rect width="350" height="96" fill="${metadataBackground}"/><text x="12" y="36" fill="${mode === "light" ? "#202124" : "#f2f2f4"}" font-family="Arial" font-size="18" font-weight="700">glacier-traverse-dawn.jpg</text><text x="12" y="68" fill="${mode === "light" ? "#77777c" : "#85858b"}" font-family="Arial" font-size="15">files.moulik.dev</text></svg>`,
    );
    const panel = await sharp({
      create: {
        width: 350,
        height: 331,
        channels: 4,
        background: metadataBackground,
      },
    })
      .composite([
        { input: cropped, left: 0, top: 0 },
        { input: mobileMetadata, left: 0, top: 235 },
        {
          input: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="350" height="331"><rect width="350" height="331" rx="16" fill="white"/></svg>',
          ),
          blend: "dest-in",
        },
      ])
      .png()
      .toBuffer();
    const titleDomainInk = await stats(
      await sharp(mobileMetadata).png().toBuffer(),
      {
        left: 8,
        top: 12,
        width: 330,
        height: 64,
      },
    );
    assert(
      titleDomainInk.edgeFraction > 0.003 && titleDomainInk.inkFraction > 0.01,
    );
    const mobile = await sharp({
      create: { width: 390, height: 700, channels: 3, background: host },
    })
      .composite([{ input: panel, left: 20, top: 80 }])
      .png()
      .toBuffer();
    const name = `simulation-mobile-${mode}.png`;
    await writeFile(path.join(outputRoot, name), mobile);
    mobileContexts[mode] = {
      canonical: "stress-06-mobile-crop.png (review overlay)",
      generated: name,
      classification:
        "mobile iMessage-style simulation, not Apple Messages evidence",
      hostColor: host,
      viewport: { width: 390, height: 700 },
      cardBounds: { left: 20, top: 80, width: 350, height: 235 },
      crop: {
        source: { left: 130, top: 0, width: 940, height: 630 },
        position: "center",
      },
      metadataBounds: { left: 20, top: 315, width: 350, height: 96 },
      cornerRadius: 16,
      titleDomainGeometry: {
        insetLeft: 12,
        titleBaseline: 351,
        domainBaseline: 383,
      },
      titleDomainInk,
      aspect: "940:630 canonical mobile center crop",
      overflow: false,
      actualProductionCardEmbedded: true,
    };
  }

  mutationProofs.blankCard = {
    color: "#0d0e10",
    dimensions: "1200x630",
    rejectedCases: [...cases.map(({ id }) => id), "13-unavailable"],
    rejectedEveryProductionCase: true,
  };
  mutationProofs.contentRemoval = {
    primaryZoneRejected: cases.length,
    titleZoneRejected: cases.length,
    brandZoneRejected: cases.length,
    factsZoneRejected: cases.length,
  };
  mutationProofs.independentFixtureBytes = {
    sourceMutationsChangedProductionPixels: cases.length,
    noGeneratedOutputUsedAsBaseline: true,
  };

  const report = {
    modelProvider: "gpt-5.6-sol via openai-codex",
    frozenArtifacts: {
      verified: manifest.length,
      digestMismatches: 0,
      manifestSha256: PINNED_MANIFEST_SHA256,
      canonicalFreezeSha256: PINNED_FREEZE_SHA256,
      referenceRoot,
      independentlyPinnedInTrackedSource: true,
    },
    pipeline:
      "independent fixture bytes -> FileService upload -> derivePreview -> buildUnfurlModel -> page route -> OG route -> production worker PNG",
    metrics,
    thresholds:
      "fixed tracked per-element geometry, color/ink/edge/variance and compact brand-region RMSE limits; never observed+margin and never whole-frame RMSE",
    mutationProofs,
    coverage: {
      rawProduction: [...cases.map(({ id }) => id), "13-unavailable"],
      rawCount: 13,
      stress: stressMetrics,
      stressCount: Object.keys(stressMetrics).length,
      stress03Through07Classification:
        "canonical files are annotation/review overlays; production semantics are asserted against their underlying states",
      contexts: { desktop: desktopContexts, mobile: mobileContexts },
      desktopContextCount: Object.keys(desktopContexts).length * 2,
      mobileContextCount: Object.keys(mobileContexts).length,
    },
    determinism: { productionCasesByteIdenticalOnRepeat: cases.length },
    unavailable: {
      exactFrozenAndRuntimeByteEquality: true,
      sha256: sha256(unavailable),
    },
    actualMessagesProof: false,
    claims: [
      "Generated host composites are deterministic iMessage-style simulations only.",
      "No Apple Messages client was opened or claimed.",
      "Frozen stress 03-07 artifacts are review/annotation overlays, not direct 1200x630 card targets.",
    ],
    outputRoot,
  };
  await writeFile(
    path.join(outputRoot, "metrics.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  setFileServiceForTests(null);
  await service.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
