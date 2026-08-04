import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import ffmpegPath from "ffmpeg-static";

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
  differenceHash,
  hammingDistance,
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
if (process.env.CI === "true") process.env.OG_RENDER_DIAGNOSTIC = "1";
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
  minimumPrimaryLight?: number;
  minimumPrimaryBoundaryInk?: number;
  /** Direct user visual review can supersede only this case's frozen Paper geometry. */
  directReviewRefinement?: boolean;
  directReviewRegions?: readonly DesignRegionName[];
}
const designInputRoot = path.join(
  repositoryFixtureRoot,
  "..",
  "og-design-inputs-v2",
);
// File size is rendered into the facts line. Keep approved facts-bearing image
// inputs immutable so host native encoders cannot change those pixels in CI.
const landscape = await readFile(
  path.join(designInputRoot, "source-01-image-landscape.jpg"),
);
const landscapeMutation = await readFile(
  path.join(designInputRoot, "source-01-image-landscape-mutation.jpg"),
);
const portrait = await readFile(
  path.join(designInputRoot, "source-02-image-portrait.png"),
);
const portraitMutation = await readFile(
  path.join(designInputRoot, "source-02-image-portrait-mutation.png"),
);
const pdf = await readFile(path.join(designInputRoot, "source-05-pdf.pdf"));
const pdfMutation = await readFile(
  path.join(designInputRoot, "source-05-pdf-mutation.pdf"),
);
const topBrand = { left: 48, top: 42, width: 230, height: 38 };
const bottomBrand = { left: 900, top: 548, width: 258, height: 42 };
const cases: AuditCase[] = [
  {
    id: "01-image-landscape",
    reference: "raw-01-image-landscape.png",
    name: "glacier-traverse-dawn.jpg",
    mimeType: "image/jpeg",
    bytes: landscape,
    mutation: landscapeMutation,
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
    directReviewRefinement: true,
    directReviewRegions: ["brand", "title", "facts", "primary"],
    title: { left: 45, top: 395, width: 920, height: 170 },
    facts: { left: 45, top: 560, width: 800, height: 50 },
    primary: { left: 0, top: 0, width: 1200, height: 430 },
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
    bytes: pdf,
    mutation: pdfMutation,
    expectedKind: "pdf",
    expectedVisual: "page",
    directReviewRefinement: true,
    directReviewRegions: ["brand", "title", "facts", "primary"],
    brand: topBrand,
    title: { left: 45, top: 390, width: 345, height: 180 },
    facts: { left: 45, top: 558, width: 345, height: 52 },
    primary: { left: 400, top: 0, width: 800, height: 630 },
    minimumPrimaryVariance: 250,
    minimumPrimaryInk: 0.72,
    minimumPrimaryLight: 0.55,
    minimumPrimaryBoundaryInk: 2_200,
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
    directReviewRegions: ["brand", "primary"],
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
    directReviewRegions: ["brand", "primary"],
    brand: bottomBrand,
    title: { left: 45, top: 475, width: 850, height: 85 },
    facts: { left: 45, top: 555, width: 720, height: 55 },
    primary: { left: 45, top: 55, width: 1080, height: 390 },
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
    directReviewRegions: ["brand", "primary"],
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
    directReviewRefinement: true,
    directReviewRegions: ["brand", "title", "facts", "primary"],
    title: { left: 45, top: 420, width: 1000, height: 150 },
    facts: { left: 45, top: 555, width: 800, height: 55 },
    primary: { left: 45, top: 125, width: 1110, height: 270 },
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
    minimumPrimaryInk: 0.03,
  },
];

// The direct review specifically supersedes title-glyph edge treatment across
// every card. Keep Paper geometry, but admit the corrected production-font
// raster gutter through the same occupancy/safe-edge checks and mutation oracle.
for (const item of cases) {
  item.directReviewRegions = [
    ...new Set([
      ...(item.directReviewRegions ?? []),
      "title" as const,
      "facts" as const,
    ]),
  ];
}

type DesignRegionName = "brand" | "title" | "facts" | "primary";

// Manually frozen from the independently reviewed synthetic-fixture pipeline.
// There is deliberately no command or code path that updates these tracked values.
const PINNED_REGION_HASHES: Readonly<
  Record<string, Readonly<Record<DesignRegionName, string>>>
> = Object.freeze({
  "01-image-landscape": {
    brand: "00402348294fc6b1",
    title: "4d6569686652dac2",
    facts: "0005181919190000",
    primary: "998ece4948488890",
  },
  "02-image-portrait": {
    brand: "0040174c294fc6b1",
    title: "082c2c8c77343666",
    facts: "0024126d6565650a",
    primary: "64b418ede0884780",
  },
  "03-video-poster": {
    brand: "00000048294bc602",
    title: "0e4d697d62a75820",
    facts: "0008051a0a191a04",
    primary: "0000000000000606",
  },
  "04-video-fallback": {
    brand: "0040174c294fc6b1",
    title: "cf34f2ead2522922",
    facts: "0002000f0f0f0d02",
    primary: "00a5000001010501",
  },
  "05-pdf": {
    brand: "0040174c294fc6b1",
    title: "0d020c2c2c4ab2b6",
    facts: "0004030c0d0d0d02",
    primary: "0000000000040800",
  },
  "06-document": {
    brand: "000000a82798aaaa",
    title: "010d1c1e1c0f0204",
    facts: "0000001a1e1e1909",
    primary: "0149611587631000",
  },
  "07-markdown": {
    brand: "882798aaaa9c2304",
    title: "1704032c2f2d0502",
    facts: "00000002000d0f0f",
    primary: "0000060606161906",
  },
  "08-code": {
    brand: "882798aaaa9c2304",
    title: "0f0d002c2c2d0e00",
    facts: "00000002050a0a0b",
    primary: "0000030c3c1a3c32",
  },
  "09-audio-artwork": {
    brand: "0040174c294fc6b1",
    title: "0d125a5e365a5a1a",
    facts: "0004020d2d2d0d02",
    primary: "18181818587c703b",
  },
  "10-audio-waveform": {
    brand: "0040174c294fc6b1",
    title: "022cb4b239051000",
    facts: "08001a19191a0400",
    primary: "49b6b69090b6b649",
  },
  "11-archive": {
    brand: "0040174c294fc6b1",
    title: "42ad9da6d3738c40",
    facts: "0000030707070601",
    primary: "0003030000060600",
  },
  "12-binary": {
    brand: "0040174c294fc6b1",
    title: "27542c3a7a212518",
    facts: "0000070707060000",
    primary: "00001a1818031c1d",
  },
});

// Pinned after exact read-only Fable review of the second iMessage correction.
// These values are tracked independently of the current runtime output: no gate
// code derives or rewrites them.
const DIRECT_REVIEW_REGION_HASHES: Readonly<
  Record<string, Readonly<Record<DesignRegionName, string>>>
> = Object.freeze({
  "01-image-landscape": {
    brand: "00402348294fc6b1",
    title: "cdc5e9e84652dac2",
    facts: "7565616565090000",
    primary: "998ece4948488890",
  },
  "02-image-portrait": {
    brand: "0040174c294fc6b1",
    title: "892c2c8c77343666",
    facts: "0088669999c5cd8d",
    primary: "64b418ede0884780",
  },
  "03-video-poster": {
    brand: "0000334c294bc605",
    title: "649abbb2d2658000",
    facts: "00005a59591d0210",
    primary: "0000000000000606",
  },
  "04-video-fallback": {
    brand: "0040174c294fc6b1",
    title: "cd35f2ead2522922",
    facts: "000a051b1b1a1b1b",
    primary: "00a5000001010501",
  },
  "05-pdf": {
    brand: "0040174c294fc6b1",
    title: "0000140970626e5e",
    facts: "4a045b63634b1442",
    primary: "02020202020a0602",
  },
  "06-document": {
    brand: "0000008009a6b5b5",
    title: "051d5c5e5c0f0204",
    facts: "0000083634353533",
    primary: "0149611587431000",
  },
  "07-markdown": {
    brand: "a4b5a76211000000",
    title: "1205bababab32916",
    facts: "00010b1a1a190906",
    primary: "010c0c0e2e636c0e",
  },
  "08-code": {
    brand: "8009a6b5b7a25800",
    title: "1e1b082c2c2d0e00",
    facts: "0000001401153435",
    primary: "0000030c3c1a3c32",
  },
  "09-audio-artwork": {
    brand: "0040174c294fc6b1",
    title: "0d521a1e365a5a1a",
    facts: "00080659595b5919",
    primary: "18181818587c703b",
  },
  "10-audio-waveform": {
    brand: "0040174c294fc6b1",
    title: "4c3adcc5f5294600",
    facts: "0008353531351c01",
    primary: "b6b6b63236b6b6b6",
  },
  "11-archive": {
    brand: "0040174c294fc6b1",
    title: "46ad9da6d3738c40",
    facts: "0004020d0d0d0d04",
    primary: "0003030000060600",
  },
  "12-binary": {
    brand: "0040174c294fc6b1",
    title: "25152c6a6a213518",
    facts: "05050f0d05030000",
    primary: "00001a1818031c1d",
  },
});

// Exact frozen Paper bytes are the independently approved unavailable-card
// authority. Runtime art must not self-authorize a replacement.
const PINNED_UNAVAILABLE_SHA256 =
  "8f007a4470db37963d5d9fcd95fdd0b47af8fe3d959861c1dcedbf12b614eb4a";

function phoneRegion(region: Region): Region {
  const scaleX = 332 / 1200;
  const scaleY = 174 / 630;
  const left = Math.max(0, Math.floor(region.left * scaleX));
  const top = Math.max(0, Math.floor(region.top * scaleY));
  const right = Math.min(332, Math.ceil((region.left + region.width) * scaleX));
  const bottom = Math.min(
    174,
    Math.ceil((region.top + region.height) * scaleY),
  );
  return { left, top, width: right - left, height: bottom - top };
}

async function rawRegion(image: Buffer, region: Region): Promise<Buffer> {
  assertBounds(region);
  return sharp(image).extract(region).removeAlpha().raw().toBuffer();
}

async function colorfulPixels(image: Buffer, region: Region): Promise<number> {
  const data = await rawRegion(image, region);
  let total = 0;
  for (let offset = 0; offset < data.length; offset += 3) {
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    if (Math.max(red, green, blue) - Math.min(red, green, blue) > 24) {
      total += 1;
    }
  }
  return total;
}

async function boundaryInk(image: Buffer, region: Region): Promise<number> {
  const data = await rawRegion(image, region);
  const ink = (x: number, y: number) => {
    const offset = (y * region.width + x) * 3;
    return (
      Math.max(
        Math.abs((data[offset] ?? 13) - 13),
        Math.abs((data[offset + 1] ?? 14) - 14),
        Math.abs((data[offset + 2] ?? 16) - 16),
      ) > 18
    );
  };
  let total = 0;
  for (let x = 0; x < region.width; x += 1) {
    if (ink(x, 0)) total += 1;
    if (ink(x, region.height - 1)) total += 1;
  }
  for (let y = 1; y < region.height - 1; y += 1) {
    if (ink(0, y)) total += 1;
    if (ink(region.width - 1, y)) total += 1;
  }
  return total;
}

async function inkCentroidY(image: Buffer, region: Region): Promise<number> {
  const data = await rawRegion(image, region);
  let weightedY = 0;
  let count = 0;
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const offset = (y * region.width + x) * 3;
      const distance = Math.sqrt(
        ((data[offset] ?? 13) - 13) ** 2 +
          ((data[offset + 1] ?? 14) - 14) ** 2 +
          ((data[offset + 2] ?? 16) - 16) ** 2,
      );
      if (distance >= 24) {
        weightedY += y;
        count += 1;
      }
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : weightedY / count;
}

async function inkGeometry(image: Buffer): Promise<{
  bounds: Region;
  centroid: { x: number; y: number };
}> {
  const width = 1200;
  const height = 630;
  const data = await sharp(image).removeAlpha().raw().toBuffer();
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  let weightedX = 0;
  let weightedY = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const distance = Math.sqrt(
        ((data[offset] ?? 13) - 13) ** 2 +
          ((data[offset + 1] ?? 14) - 14) ** 2 +
          ((data[offset + 2] ?? 16) - 16) ** 2,
      );
      if (distance < 24) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      weightedX += x;
      weightedY += y;
      count += 1;
    }
  }
  assert(count > 0, "unavailable composition must contain visible ink");
  return {
    bounds: { left, top, width: right - left + 1, height: bottom - top + 1 },
    centroid: { x: weightedX / count, y: weightedY / count },
  };
}

async function stats(image: Buffer, region: Region): Promise<PixelStats> {
  return pixelStats(
    await rawRegion(image, region),
    region.width,
    region.height,
  );
}

async function regionHash(image: Buffer, region: Region): Promise<string> {
  const pixels = await sharp(image)
    .extract(region)
    .resize(9, 8, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
  return differenceHash(pixels, 9, 8);
}

async function evaluateCase(
  item: AuditCase,
  image: Buffer,
  enforcePinnedStructure = true,
) {
  const reasons: string[] = [];
  const metadata = await sharp(image).metadata();
  if (metadata.width !== 1200 || metadata.height !== 630 || metadata.hasAlpha)
    reasons.push("card must be opaque 1200x630");
  const [brandStats, titleStats, factStats, primaryStats] = await Promise.all([
    stats(image, item.brand),
    stats(image, item.title),
    stats(image, item.facts),
    stats(image, item.primary),
  ]);
  const regionHashes = Object.fromEntries(
    await Promise.all(
      (["brand", "title", "facts", "primary"] as const).map(
        async (name) => [name, await regionHash(image, item[name])] as const,
      ),
    ),
  ) as Record<DesignRegionName, string>;
  const expectedHashes = PINNED_REGION_HASHES[item.id];
  assert(expectedHashes, `${item.id}: pinned regional references missing`);
  const directBaseline = DIRECT_REVIEW_REGION_HASHES[item.id];
  assert(directBaseline, `${item.id}: pinned direct-review regions missing`);
  const structureDistances = Object.fromEntries(
    (["brand", "title", "facts", "primary"] as const).map((name) => [
      name,
      hammingDistance(regionHashes[name], expectedHashes[name]),
    ]),
  ) as Record<DesignRegionName, number>;
  if (enforcePinnedStructure) {
    for (const name of ["brand", "title", "facts", "primary"] as const) {
      const directlyRefined = item.directReviewRegions?.includes(name) ?? false;
      const expected = directlyRefined
        ? directBaseline?.[name]
        : expectedHashes[name];
      if (expected !== undefined && regionHashes[name] !== expected)
        reasons.push(`${name} fixed perceptual structure mismatch`);
    }
  }
  if (brandStats.accentFraction < 0.001) reasons.push("brand accent missing");
  if (brandStats.inkFraction < 0.015) reasons.push("brand/header ink missing");
  if (brandStats.edgeFraction > 0.15) reasons.push("brand structure corrupted");
  if (titleStats.lightFraction < 0.012 || titleStats.edgeFraction < 0.006)
    reasons.push("title/glyph occupancy missing");
  if (titleStats.lightFraction > 0.25 || titleStats.edgeFraction > 0.1)
    reasons.push("title color/structure corrupted");
  if (factStats.inkFraction < 0.008 || factStats.edgeFraction < 0.003)
    reasons.push("facts/domain ink missing");
  if (factStats.inkFraction > 0.9 || factStats.edgeFraction > 0.1)
    reasons.push("facts/domain color/structure corrupted");
  if (primaryStats.variance < item.minimumPrimaryVariance)
    reasons.push("primary hero/page/artwork/waveform variance missing");
  if (primaryStats.variance > 20_000 || primaryStats.edgeFraction > 0.06)
    reasons.push("primary color/structure corrupted");
  if (primaryStats.inkFraction < item.minimumPrimaryInk)
    reasons.push("primary content occupancy missing");
  if (
    item.minimumPrimaryLight !== undefined &&
    primaryStats.lightFraction < item.minimumPrimaryLight
  )
    reasons.push("primary readable page area missing");
  const primaryBoundaryInk = await boundaryInk(image, item.primary);
  if (
    item.minimumPrimaryBoundaryInk !== undefined &&
    primaryBoundaryInk < item.minimumPrimaryBoundaryInk
  )
    reasons.push("primary page placement shifted or clipped");
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
  const [titleInkCentroidY, factsInkCentroidY, titleLeftStats, factsLeftStats] =
    await Promise.all([
      inkCentroidY(image, item.title),
      inkCentroidY(image, item.facts),
      stats(image, {
        left: item.title.left,
        top: item.title.top,
        width: 30,
        height: item.title.height,
      }),
      stats(image, {
        left: item.facts.left,
        top: item.facts.top,
        width: 30,
        height: item.facts.height,
      }),
    ]);
  if (
    item.directReviewRefinement &&
    (titleInkCentroidY > Math.max(90, item.title.height - 28) ||
      factsInkCentroidY > Math.max(24, item.facts.height - 12) ||
      titleLeftStats.inkFraction < 0.003 ||
      factsLeftStats.inkFraction < 0.003)
  )
    reasons.push("direct-review text placement shifted");
  return {
    reasons,
    brandStats,
    titleStats,
    factStats,
    primaryStats,
    primaryBoundaryInk,
    titleInkCentroidY,
    factsInkCentroidY,
    regionHashes,
    structureDistances,
  };
}
async function compositeRegion(
  image: Buffer,
  region: Region,
  replacement: Buffer,
): Promise<Buffer> {
  return sharp(image)
    .composite([{ input: replacement, left: region.left, top: region.top }])
    .removeAlpha()
    .png()
    .toBuffer();
}

async function restoreRegions(
  mutated: Buffer,
  original: Buffer,
  regions: readonly Region[],
): Promise<Buffer> {
  const patches = await Promise.all(
    regions.map(async (region) => ({
      input: await sharp(original).extract(region).png().toBuffer(),
      left: region.left,
      top: region.top,
    })),
  );
  return sharp(mutated).composite(patches).removeAlpha().png().toBuffer();
}

async function checkerboard(region: Region): Promise<Buffer> {
  const cells: string[] = [];
  for (let y = 0; y < region.height; y += 8) {
    for (let x = 0; x < region.width; x += 8) {
      cells.push(
        `<rect x="${x}" y="${y}" width="8" height="8" fill="${(x / 8 + y / 8) % 2 ? "#ff00ff" : "#00ffff"}"/>`,
      );
    }
  }
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${region.width}" height="${region.height}">${cells.join("")}</svg>`,
    ),
  )
    .removeAlpha()
    .png()
    .toBuffer();
}

async function wrongContent(region: Region): Promise<Buffer> {
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${region.width}" height="${region.height}"><rect width="100%" height="100%" fill="#063b52"/><path d="M-${region.height} ${region.height} L${region.width} 0 M0 ${region.height} L${region.width + region.height} 0" stroke="#ff7a00" stroke-width="42"/><circle cx="${region.width / 2}" cy="${region.height / 2}" r="${Math.min(region.width, region.height) / 4}" fill="#7dff00"/></svg>`,
    ),
  )
    .removeAlpha()
    .png()
    .toBuffer();
}

async function displacedRegion(image: Buffer, region: Region): Promise<Buffer> {
  const source = await sharp(image).extract(region).png().toBuffer();
  return sharp({
    create: {
      width: region.width,
      height: region.height,
      channels: 3,
      background: "#0d0e10",
    },
  })
    .composite([{ input: source, left: 29, top: 17 }])
    .png()
    .toBuffer();
}

async function clippedRegion(image: Buffer, region: Region): Promise<Buffer> {
  const source = await sharp(image).extract(region).png().toBuffer();
  return sharp(source)
    .composite([
      {
        input: {
          create: {
            width: Math.ceil(region.width * 0.42),
            height: region.height,
            channels: 3,
            background: "#0d0e10",
          },
        },
        left: 0,
        top: 0,
      },
    ])
    .removeAlpha()
    .png()
    .toBuffer();
}

async function colorMutant(image: Buffer, region: Region): Promise<Buffer> {
  return sharp(image).extract(region).negate({ alpha: false }).png().toBuffer();
}

async function scaledRegion(
  image: Buffer,
  region: Region,
  scale: number,
): Promise<Buffer> {
  const width = Math.max(1, Math.round(region.width * scale));
  const height = Math.max(1, Math.round(region.height * scale));
  const source = await sharp(image)
    .extract(region)
    .resize(width, height)
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: region.width,
      height: region.height,
      channels: 3,
      background: "#0d0e10",
    },
  })
    .composite([
      {
        input: source,
        left: Math.floor((region.width - width) / 2),
        top: Math.floor((region.height - height) / 2),
      },
    ])
    .png()
    .toBuffer();
}

async function darkenedRegion(image: Buffer, region: Region): Promise<Buffer> {
  return sharp(image)
    .extract(region)
    .linear(0.18, 4)
    .removeAlpha()
    .png()
    .toBuffer();
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
    if (result.reasons.length > 0) {
      await Promise.all([
        writeFile(
          path.join(outputRoot, `diagnostic-${item.id}.png`),
          produced.card,
        ),
        writeFile(
          path.join(outputRoot, `diagnostic-${item.id}.json`),
          JSON.stringify(
            {
              caseId: item.id,
              reference: item.reference,
              reasons: result.reasons,
              regionHashes: result.regionHashes,
              structureDistances: result.structureDistances,
              description: produced.model.description,
              previewFacts: produced.model.preview?.facts,
              sourceDigest: produced.direct.sourceDigest,
              cardSha256: sha256(produced.card),
            },
            null,
            2,
          ),
        ),
      ]);
    }
    assert.deepEqual(
      result.reasons,
      [],
      `${item.id}: ${result.reasons.join("; ")}`,
    );
    const phoneCard = await sharp(produced.card)
      .resize(332, 174)
      .png()
      .toBuffer();
    const phoneTitle = await stats(phoneCard, phoneRegion(item.title));
    const phoneFacts = await stats(phoneCard, phoneRegion(item.facts));
    const phonePrimary = await stats(phoneCard, phoneRegion(item.primary));
    assert(
      phoneTitle.edgeFraction >= 0.01 && phoneTitle.lightFraction >= 0.01,
      `${item.id}: title must retain effective light-pixel height/occupancy at 332x174`,
    );
    assert(
      phoneFacts.edgeFraction >= 0.01 && phoneFacts.inkFraction >= 0.012,
      `${item.id}: key type/metadata must retain effective occupancy at 332x174`,
    );
    assert(
      phonePrimary.edgeFraction >= 0.004 && phonePrimary.inkFraction >= 0.015,
      `${item.id}: family content must retain meaningful occupancy at 332x174`,
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

    const primaryMutants: Record<string, Buffer> = {
      checkerboard: await checkerboard(item.primary),
      wrongContent: await wrongContent(item.primary),
      displacement: await displacedRegion(produced.card, item.primary),
      clipping: await clippedRegion(produced.card, item.primary),
      colorStructure: await colorMutant(produced.card, item.primary),
    };
    const adversarialResults: Record<string, string[]> = {};
    for (const [name, replacement] of Object.entries(primaryMutants)) {
      const mutant = await restoreRegions(
        await compositeRegion(produced.card, item.primary, replacement),
        produced.card,
        [item.brand, item.title, item.facts],
      );
      const evaluated = await evaluateCase(item, mutant);
      assert(
        evaluated.reasons.length > 0,
        `${item.id}: ${name} primary corruption must fail while brand/title/facts remain canonical`,
      );
      adversarialResults[name] = evaluated.reasons;
    }
    for (const [name, region, replacement] of [
      [
        "titleDisplacement",
        item.title,
        await displacedRegion(produced.card, item.title),
      ],
      [
        "factsClipping",
        item.facts,
        await clippedRegion(produced.card, item.facts),
      ],
      ["brandColor", item.brand, await colorMutant(produced.card, item.brand)],
    ] as const) {
      const evaluated = await evaluateCase(
        item,
        await compositeRegion(produced.card, region, replacement),
      );
      assert(
        evaluated.reasons.length > 0,
        `${item.id}: ${name} mutant must fail its fixed regional contract`,
      );
      adversarialResults[name] = evaluated.reasons;
    }

    const reviewMutants: Record<string, string[]> = {};
    let tinyType: Buffer<ArrayBufferLike> = produced.card;
    for (const region of [item.title, item.facts]) {
      tinyType = await compositeRegion(
        tinyType,
        region,
        await scaledRegion(produced.card, region, 0.55),
      );
    }
    const tinyTypeResult = await evaluateCase(item, tinyType);
    assert(
      tinyTypeResult.reasons.length > 0,
      `${item.id}: tiny global type mutant must fail`,
    );
    reviewMutants.tinyGlobalType = tinyTypeResult.reasons;

    const familyMutantName =
      item.id === "03-video-poster"
        ? "insetVideo"
        : item.id === "05-pdf"
          ? "fullTinyPdfPage"
          : item.id === "07-markdown"
            ? "denseTinyMarkdown"
            : item.id === "10-audio-waveform"
              ? "missingWaveform"
              : undefined;
    if (familyMutantName) {
      const replacement =
        familyMutantName === "missingWaveform"
          ? await sharp({
              create: {
                width: item.primary.width,
                height: item.primary.height,
                channels: 3,
                background: "#0d0e10",
              },
            })
              .png()
              .toBuffer()
          : await scaledRegion(produced.card, item.primary, 0.55);
      const familyResult = await evaluateCase(
        item,
        await compositeRegion(produced.card, item.primary, replacement),
      );
      assert(
        familyResult.reasons.length > 0,
        `${item.id}: ${familyMutantName} mutant must fail`,
      );
      reviewMutants[familyMutantName] = familyResult.reasons;
    }
    if (item.id === "10-audio-waveform") {
      const lowContrastResult = await evaluateCase(
        item,
        await compositeRegion(
          produced.card,
          item.primary,
          await darkenedRegion(produced.card, item.primary),
        ),
      );
      assert(
        lowContrastResult.reasons.length > 0,
        "10-audio-waveform: low-contrast waveform mutant must fail",
      );
      reviewMutants.lowContrastWaveform = lowContrastResult.reasons;
    }

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
        phoneSize: "332x174",
        minimumPhoneTitleEdgeFraction: 0.01,
        minimumPhoneTitleLightFraction: 0.01,
        minimumPhoneFactsEdgeFraction: 0.01,
        minimumPhonePrimaryEdgeFraction: 0.004,
      },
      observed: {
        ...result,
        reasons: undefined,
        brandRegionalRmse: brandRmse,
        phone332x174: {
          title: phoneTitle,
          facts: phoneFacts,
          primary: phonePrimary,
        },
      },
      blankMutant: { rejected: true, reasons: blankResult.reasons },
      primaryRemovalMutant: { rejected: true, reasons: primaryRemoval.reasons },
      titleRemovalMutant: { rejected: true, reasons: titleRemoval.reasons },
      brandRemovalMutant: { rejected: true, reasons: brandRemoval.reasons },
      factsRemovalMutant: { rejected: true, reasons: factsRemoval.reasons },
      adversarialMutants: Object.fromEntries(
        Object.entries(adversarialResults).map(([name, reasons]) => [
          name,
          { rejected: true, reasons },
        ]),
      ),
      directReviewMutants: Object.fromEntries(
        Object.entries(reviewMutants).map(([name, reasons]) => [
          name,
          { rejected: true, reasons },
        ]),
      ),
      pinnedRegionHashes: PINNED_REGION_HASHES[item.id],
      pinnedStructureDistances: result.structureDistances,
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
  assert.equal(
    sha256(unavailable),
    PINNED_UNAVAILABLE_SHA256,
    "unavailable output must match the independently pinned Paper bytes",
  );
  assert.deepEqual(
    unavailable,
    frozenUnavailable,
    "unavailable runtime output must remain pixel-identical to the frozen Paper frame",
  );
  const unavailableBlank = await sharp(blank).png().toBuffer();
  assert.notDeepEqual(unavailable, unavailableBlank);
  const unavailableRegions = {
    forbiddenArtwork: { left: 470, top: 70, width: 260, height: 170 },
    brand: { left: 450, top: 245, width: 300, height: 50 },
    title: { left: 410, top: 300, width: 380, height: 85 },
  } as const;
  const evaluateUnavailable = async (image: Buffer) => {
    const [forbiddenArtwork, brand, title, geometry] = await Promise.all([
      stats(image, unavailableRegions.forbiddenArtwork),
      stats(image, unavailableRegions.brand),
      stats(image, unavailableRegions.title),
      inkGeometry(image),
    ]);
    const reasons: string[] = [];
    if (forbiddenArtwork.inkFraction > 0.002)
      reasons.push(
        "generic centered artwork stack is not part of the Paper composition",
      );
    if (brand.accentFraction < 0.0008 || brand.inkFraction < 0.01)
      reasons.push("unavailable brand hierarchy missing");
    if (title.lightFraction < 0.02 || title.edgeFraction < 0.008)
      reasons.push("unavailable title occupancy too small");
    if (
      geometry.bounds.left < 420 ||
      geometry.bounds.left > 435 ||
      geometry.bounds.top < 250 ||
      geometry.bounds.top > 265 ||
      geometry.bounds.width < 340 ||
      geometry.bounds.width > 365 ||
      geometry.bounds.height < 100 ||
      geometry.bounds.height > 120
    )
      reasons.push("unavailable Paper geometry shifted");
    if (
      geometry.centroid.x < 590 ||
      geometry.centroid.x > 610 ||
      geometry.centroid.y < 315 ||
      geometry.centroid.y > 345
    )
      reasons.push("unavailable center of mass shifted");
    return { reasons, forbiddenArtwork, brand, title, geometry };
  };
  const unavailableResult = await evaluateUnavailable(unavailable);
  assert.deepEqual(unavailableResult.reasons, []);
  const phoneUnavailable = await sharp(unavailable)
    .resize(332, 174)
    .png()
    .toBuffer();
  const [phoneBrand, phoneTitle] = await Promise.all([
    stats(phoneUnavailable, phoneRegion(unavailableRegions.brand)),
    stats(phoneUnavailable, phoneRegion(unavailableRegions.title)),
  ]);
  assert(
    phoneBrand.edgeFraction >= 0.008 && phoneBrand.inkFraction >= 0.01,
    "unavailable brand must remain legible at 332x174",
  );
  assert(
    phoneTitle.edgeFraction >= 0.008 && phoneTitle.lightFraction >= 0.015,
    "unavailable title must remain legible at 332x174",
  );
  const tinyUnavailable = await sharp({
    create: { width: 1200, height: 630, channels: 3, background: "#0d0e10" },
  })
    .composite([
      {
        input: await sharp(unavailable).resize(600, 315).png().toBuffer(),
        left: 300,
        top: 158,
      },
    ])
    .removeAlpha()
    .png()
    .toBuffer();
  const tinyUnavailableResult = await evaluateUnavailable(tinyUnavailable);
  assert(
    tinyUnavailableResult.reasons.length > 0,
    "tiny unavailable title/brand mutant must fail regional geometry",
  );
  const centeredArtworkMutant = await sharp(unavailable)
    .composite([
      {
        input: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="170"><path d="M82 12h64l42 42v92a12 12 0 0 1-12 12H82a12 12 0 0 1-12-12V24a12 12 0 0 1 12-12z" fill="#1b1e23" stroke="#9fa3a9" stroke-width="8"/><path d="M146 12v42h42" fill="none" stroke="#9fa3a9" stroke-width="8"/></svg>',
        ),
        left: unavailableRegions.forbiddenArtwork.left,
        top: unavailableRegions.forbiddenArtwork.top,
      },
    ])
    .removeAlpha()
    .png()
    .toBuffer();
  const centeredArtworkResult = await evaluateUnavailable(
    centeredArtworkMutant,
  );
  assert(
    centeredArtworkResult.reasons.includes(
      "generic centered artwork stack is not part of the Paper composition",
    ),
    "generic centered artwork/title stack mutant must fail independently pinned composition constraints",
  );
  await writeFile(
    path.join(outputRoot, "generated-13-unavailable.png"),
    unavailable,
  );
  generatedByCase.set("13-unavailable", unavailable);
  metrics["13-unavailable"] = {
    reference: "raw-13-unavailable.png",
    exactRuntimeBytes: true,
    independentlyPinnedPaperDigest: PINNED_UNAVAILABLE_SHA256,
    sha256: sha256(unavailable),
    regions: unavailableRegions,
    observed: unavailableResult,
    phone332x174: { brand: phoneBrand, title: phoneTitle },
    tinyMutant: {
      rejected: true,
      reasons: tinyUnavailableResult.reasons,
    },
    centeredArtworkMutant: {
      rejected: true,
      reasons: centeredArtworkResult.reasons,
    },
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
        "# 観測ログ — العربية\n日本語\nالعربية\ne\u0301\n👨‍👩‍👧‍👦📡\n",
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
      bytes: landscape,
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
            brand: { left: 900, top: 576, width: 258, height: 42 },
            minimumPrimaryInk: 0.008,
          }
        : stress.id === "stress-04-extreme-landscape"
          ? { ...baseConfig, minimumPrimaryVariance: 40 }
          : baseConfig;
    const result = await evaluateCase(config, produced.card, false);
    assert.deepEqual(
      result.reasons,
      [],
      `${stress.id}: ${result.reasons.join("; ")}`,
    );
    let unicodeRegionalProof: unknown;
    if (stress.id === "stress-02-unicode") {
      const emojiRegions: Region[] = [
        { left: 52, top: 291, width: 125, height: 40 },
      ];
      const emojiColorPixels = await Promise.all(
        emojiRegions.map((region) => colorfulPixels(produced.card, region)),
      );
      assert(
        emojiColorPixels.every((count) => count > 12),
        "Unicode stress family ZWJ and satellite region requires bundled color artwork",
      );
      const scriptRegions: Region[] = [
        { left: 52, top: 153, width: 170, height: 40 },
        { left: 52, top: 199, width: 210, height: 40 },
        { left: 52, top: 245, width: 95, height: 40 },
      ];
      const replacement = await productionCard(
        stress.name,
        stress.mime,
        Buffer.from(
          "# replacement heading\nreplacement\nreplacement\nreplacement\nreplacement\n",
        ),
      );
      const scriptDiffersFromReplacement = await Promise.all(
        scriptRegions.map(
          async (region) =>
            !(await rawRegion(produced.card, region)).equals(
              await rawRegion(replacement.card, region),
            ),
        ),
      );
      const scriptBoundaryInk = await Promise.all(
        scriptRegions.map((region) => boundaryInk(produced.card, region)),
      );
      assert(
        scriptDiffersFromReplacement.every(Boolean),
        "Unicode stress CJK, Arabic RTL, and combining-mark regions must differ from replacement glyphs",
      );
      assert(
        scriptBoundaryInk.every((count) => count <= 4),
        "Unicode stress script regions must not overlap or clip their regional boundaries",
      );
      unicodeRegionalProof = {
        emojiRegions,
        emojiColorPixels,
        scriptRegions,
        scriptDiffersFromReplacement,
        scriptBoundaryInk,
      };
    }
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
          ? unicodeRegionalProof !== undefined
          : true,
      unicodeRegionalProof,
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
    safeArea:
      "frozen Paper brand/title hierarchy inside independently pinned 1200x630 regions",
    noTofuOverlapClipping: true,
    exactRuntimeBytes: true,
    frozenPaperPixelIdentity: true,
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
    automatedDesignGate: "node/tsx",
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
      exactRuntimeByteEquality: true,
      frozenPaperPixelIdentity: true,
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
