import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import yazl from "yazl";

import { GET as getPage } from "../src/app/[id]/route";
import { GET as getOgImage } from "../src/app/og/[filename]/route";
import { derivePreview } from "../src/server/files/preview-renderers";
import { FileService } from "../src/server/files/service";
import { setFileServiceForTests } from "../src/server/files/singleton";
import { buildUnfurlModel } from "../src/server/files/unfurl";

const referenceEnvironment = process.env.OG_DESIGN_REFERENCE_DIR;
assert(
  referenceEnvironment,
  "OG_DESIGN_REFERENCE_DIR is required; release design audit never silently skips frozen artifacts",
);
const referenceRoot = path.resolve(referenceEnvironment);
const outputRoot = path.resolve(
  process.env.OG_DESIGN_AUDIT_DIR ??
    path.join(os.tmpdir(), "file-hosting-design-audit"),
);
const manifestPath = path.join(referenceRoot, "export-verification.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Array<{
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

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

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
  portrait = false,
) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#14232c"/><circle cx="${portrait ? width * 0.52 : width * 0.72}" cy="${height * 0.38}" r="${Math.min(width, height) * 0.22}" fill="#d9a14c"/><path d="M0 ${height * 0.78} L${width * 0.38} ${height * 0.43} L${width * 0.7} ${height * 0.76} L${width} ${height * 0.52} V${height} H0Z" fill="#496b72"/></svg>`,
  );
  return sharp(svg).png().toBuffer();
}

async function pdfFixture(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Annual report 2025", { x: 64, y: 700, size: 30, font });
  page.drawText("Independent synthetic release evidence", {
    x: 64,
    y: 650,
    size: 16,
    font,
  });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function docxFixture(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    archive.addBuffer(
      Buffer.from("application/vnd.openxmlformats-package.relationships+xml"),
      "[Content_Types].xml",
    );
    archive.addBuffer(
      Buffer.from(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Q3 Field Study — Cold-Storage Latency</w:t></w:r></w:p><w:p><w:r><w:t>Methodology, sampling windows, and observed retrieval percentiles.</w:t></w:r></w:p></w:body></w:document>',
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

function wavFixture(): Buffer {
  const samples = 16_000;
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin(index / 11) * 24_000), index * 2);
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
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function tarGzFixture(): Buffer {
  const tar = Buffer.concat([
    tarEntry("manifest.json", Buffer.from('{"version":1}\n')),
    tarEntry("database.sql", Buffer.from("select 1;\n")),
    Buffer.alloc(1024),
  ]);
  return gzipSync(tar, { level: 9 });
}

interface AuditCase {
  id: string;
  reference: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
  expectedKind: string;
  region: { left: number; top: number; width: number; height: number };
  maximumRmse: number;
}

const landscape = await independentRaster(1600, 900);
const portrait = await independentRaster(900, 1600, true);
const cases: AuditCase[] = [
  {
    id: "01-image-landscape",
    reference: "raw-01-image-landscape.png",
    name: "glacier-traverse-dawn.jpg",
    mimeType: "image/jpeg",
    bytes: await sharp(landscape).jpeg({ quality: 90 }).toBuffer(),
    expectedKind: "image",
    region: { left: 0, top: 420, width: 1200, height: 210 },
    maximumRmse: 60,
  },
  {
    id: "02-image-portrait",
    reference: "raw-02-image-portrait.png",
    name: "canyon-light-study-07.png",
    mimeType: "image/png",
    bytes: portrait,
    expectedKind: "image",
    region: { left: 0, top: 0, width: 580, height: 630 },
    maximumRmse: 51,
  },
  {
    id: "04-video-fallback",
    reference: "raw-04-video-no-poster.png",
    name: "workshop-recording-berlin.mov",
    mimeType: "video/quicktime",
    bytes: Buffer.from("independent malformed video fixture"),
    expectedKind: "video",
    region: { left: 0, top: 0, width: 1200, height: 630 },
    maximumRmse: 37,
  },
  {
    id: "05-pdf",
    reference: "raw-05-pdf-first-page.png",
    name: "annual-report-2025.pdf",
    mimeType: "application/pdf",
    bytes: await pdfFixture(),
    expectedKind: "pdf",
    region: { left: 0, top: 0, width: 650, height: 630 },
    maximumRmse: 43,
  },
  {
    id: "06-document",
    reference: "raw-06-document-title.png",
    name: "q3-field-study.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: await docxFixture(),
    expectedKind: "document",
    region: { left: 0, top: 481, width: 1200, height: 149 },
    maximumRmse: 42,
  },
  {
    id: "07-markdown",
    reference: "raw-07-markdown.png",
    name: "Release runbook.md",
    mimeType: "text/markdown",
    bytes: Buffer.from(
      "# Rollout plan\n\nOrder of operations for promoting a build from staging.\n\n## Pre-flight checks\n\n- Verify the target tag exists\n- Confirm storage headroom\n",
    ),
    expectedKind: "markdown",
    region: { left: 0, top: 0, width: 1200, height: 630 },
    maximumRmse: 42,
  },
  {
    id: "08-code",
    reference: "raw-08-code-text.png",
    name: "chunked_upload.py",
    mimeType: "text/x-python",
    bytes: Buffer.from(
      "def upload_chunked(path, chunk_size=8_388_608):\n    total = os.path.getsize(path)\n    with open(path, 'rb') as handle:\n        while chunk := handle.read(chunk_size):\n            yield chunk, total\n",
    ),
    expectedKind: "code",
    region: { left: 0, top: 0, width: 1200, height: 630 },
    maximumRmse: 32,
  },
  {
    id: "10-audio-waveform",
    reference: "raw-10-audio-waveform.png",
    name: "river-crossing-interview.wav",
    mimeType: "audio/wav",
    bytes: wavFixture(),
    expectedKind: "audio",
    region: { left: 0, top: 0, width: 1200, height: 630 },
    maximumRmse: 40,
  },
  {
    id: "11-archive",
    reference: "raw-11-archive-targz.png",
    name: "site-backup-2026-08-01.tar.gz",
    mimeType: "application/gzip",
    bytes: tarGzFixture(),
    expectedKind: "archive",
    region: { left: 0, top: 0, width: 1200, height: 630 },
    maximumRmse: 40,
  },
  {
    id: "12-binary",
    reference: "raw-12-generic-binary.png",
    name: "firmware-update-v3.2.bin",
    mimeType: "application/octet-stream",
    bytes: Buffer.from("7f454c46020101000000000000000000deadbeef", "hex"),
    expectedKind: "binary",
    region: { left: 0, top: 0, width: 1200, height: 630 },
    maximumRmse: 42,
  },
];

async function regionRmse(
  reference: Buffer,
  actual: Buffer,
  region: AuditCase["region"],
) {
  const referencePixels = await sharp(reference)
    .extract(region)
    .removeAlpha()
    .raw()
    .toBuffer();
  const actualPixels = await sharp(actual)
    .extract(region)
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.equal(referencePixels.length, actualPixels.length);
  let squared = 0;
  for (let index = 0; index < referencePixels.length; index += 1) {
    const delta = (referencePixels[index] ?? 0) - (actualPixels[index] ?? 0);
    squared += delta * delta;
  }
  return Number(Math.sqrt(squared / referencePixels.length).toFixed(3));
}

const metrics: Record<string, unknown> = {};
const generatedByCase = new Map<string, Buffer>();
try {
  for (const item of cases) {
    const file = await upload(item.name, item.mimeType, item.bytes);
    const direct = await derivePreview({
      trustedMime: file.mimeType,
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      sourcePath: service.storagePath(file),
    });
    const model = await buildUnfurlModel(service, file);
    assert.equal(model.kind, item.expectedKind);
    assert.equal(model.preview?.sourceDigest, direct.sourceDigest);
    assert.equal(model.title, item.name);

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
    const generated = Buffer.from(await response.arrayBuffer());
    const repeated = Buffer.from(
      await (
        await getOgImage(
          new Request(`https://spoofed.invalid/og/${file.id}.png`),
          ogRouteContext(file.id),
        )
      ).arrayBuffer(),
    );
    assert.deepEqual(generated, repeated, `${item.id} must be deterministic`);
    const metadata = await sharp(generated).metadata();
    assert.deepEqual(
      {
        width: metadata.width,
        height: metadata.height,
        hasAlpha: metadata.hasAlpha,
      },
      { width: 1200, height: 630, hasAlpha: false },
    );
    const reference = await readFile(path.join(referenceRoot, item.reference));
    const rmse = await regionRmse(reference, generated, item.region);
    assert.ok(
      rmse <= item.maximumRmse,
      `${item.id} region RMSE ${rmse} exceeds ${item.maximumRmse}`,
    );
    await writeFile(
      path.join(outputRoot, `generated-${item.id}.png`),
      generated,
    );
    generatedByCase.set(item.id, generated);
    metrics[item.id] = {
      reference: item.reference,
      region: item.region,
      rmse,
      maximumRmse: item.maximumRmse,
      deterministicSha256: sha256(generated),
      derivedKind: model.kind,
      label: model.preview?.label,
    };
  }

  const missing = await getOgImage(
    new Request("https://design-audit.example.test/og/0000000.png"),
    ogRouteContext("0000000"),
  );
  const unavailable = Buffer.from(await missing.arrayBuffer());
  assert.equal(missing.status, 200);
  assert.deepEqual(
    unavailable,
    await readFile(path.resolve("runtime/assets/unavailable.png")),
  );
  await writeFile(
    path.join(outputRoot, "generated-13-unavailable.png"),
    unavailable,
  );
  metrics["13-unavailable"] = {
    reference: "raw-13-unavailable.png",
    exactRuntimeAsset: true,
    deterministicSha256: sha256(unavailable),
  };

  const markdownOriginal = generatedByCase.get("07-markdown")!;
  const markdownMutation = await upload(
    "Release runbook.md",
    "text/markdown",
    Buffer.from(
      "# Rollout plan\n\nA fixture-byte mutation changes this excerpt.\n",
    ),
  );
  const markdownMutationBytes = Buffer.from(
    await (
      await getOgImage(
        new Request(
          `https://design-audit.example.test/og/${markdownMutation.id}.png`,
        ),
        ogRouteContext(markdownMutation.id),
      )
    ).arrayBuffer(),
  );
  assert.notDeepEqual(
    markdownMutationBytes,
    markdownOriginal,
    "fixture-byte mutation must alter production-route pixels",
  );

  const longName = `${"release-".repeat(28)}final.bin`.slice(0, 240);
  const stressLong = await upload(
    longName,
    "application/octet-stream",
    Buffer.from("long-title-stress"),
  );
  const stressUnicode = await upload(
    "研究データ📡-résumé-Δ.md",
    "text/markdown",
    Buffer.from("# 研究データ\n\nUnicode and emoji remain grapheme-safe.\n"),
  );
  for (const [name, file] of [
    ["stress-long", stressLong],
    ["stress-unicode", stressUnicode],
  ] as const) {
    const bytes = Buffer.from(
      await (
        await getOgImage(
          new Request(`https://design-audit.example.test/og/${file.id}.png`),
          ogRouteContext(file.id),
        )
      ).arrayBuffer(),
    );
    await writeFile(path.join(outputRoot, `${name}.png`), bytes);
  }

  const referenceInventory = {
    raw: manifest
      .filter(({ file }) => file.startsWith("raw-"))
      .map(({ file }) => file),
    imessageSimulationOnly: manifest
      .filter(({ file }) => file.startsWith("imessage-"))
      .map(({ file }) => file),
    stressReviewOnly: manifest
      .filter(({ file }) => file.startsWith("stress-"))
      .map(({ file }) => file),
  };
  assert.deepEqual(referenceInventory.raw.length, 13);
  assert.deepEqual(referenceInventory.imessageSimulationOnly.length, 13);
  assert.deepEqual(referenceInventory.stressReviewOnly.length, 7);
  const nonRenderStates = [
    "raw-03-video-poster.png: actual poster extraction is covered by source tests; independent deterministic video encoding is not a release-design fixture",
    "raw-09-audio-artwork.png: embedded-artwork preference is covered by source tests; waveform is the independent release-design fixture",
    "all imessage-*.png: frozen host-client review simulations, never claimed as actual Messages proof",
    "stress-03 through stress-07: frozen review boards/overlays rather than production 1200x630 outputs",
  ];
  const report = {
    modelProvider: "gpt-5.6-sol via openai-codex",
    frozenArtifacts: {
      verified: manifest.length,
      digestMismatches: 0,
      referenceRoot,
    },
    pipeline:
      "fixture bytes -> FileService upload -> derivePreview -> buildUnfurlModel -> page route -> OG route -> production worker PNG",
    metrics,
    thresholds:
      "case-specific fixed shell/content region RMSE on 0..255 RGB; exact dimensions, deterministic bytes, semantic model and route assertions are separate hard gates",
    mutationProof: { markdownPixelsChanged: true },
    referenceInventory,
    nonRenderStates,
    actualMessagesProof: false,
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
