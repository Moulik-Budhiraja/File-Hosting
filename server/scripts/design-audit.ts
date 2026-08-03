import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import { renderOgImage } from "../src/server/files/og-image";
import type { PreviewExtraction } from "../src/server/files/preview-renderers";
import type { PublicUnfurlModel } from "../src/server/files/unfurl";

const outputRoot = path.resolve(
  process.env.OG_DESIGN_AUDIT_DIR ?? "/tmp/file-hosting-design-audit",
);
const referenceRoot = path.resolve(
  process.env.OG_DESIGN_REFERENCE_DIR ??
    path.join(
      os.homedir(),
      "Library/Caches/Hermes/Scratch/20260803-file-hosting-design-review/og-cards-v2",
    ),
);
await mkdir(outputRoot, { recursive: true });

function model(
  title: string,
  description: string,
  kind: PublicUnfurlModel["kind"],
  preview: PreviewExtraction,
): PublicUnfurlModel {
  return {
    title,
    description,
    ogType: ["markdown", "document", "text", "code", "pdf"].includes(kind)
      ? "article"
      : "website",
    twitterCard: "summary_large_image",
    canonicalUrl: "https://files.example.invalid/fixture",
    imageUrl: "https://files.example.invalid/fixture.png",
    imageAlt: "Synthetic design fixture",
    kind,
    eligibleRaster: false,
    preview,
  };
}

const digest = "0".repeat(64);
async function referenceCrop(
  filename: string,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  return sharp(path.join(referenceRoot, filename))
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
}

const landscapeRaster = await referenceCrop(
  "raw-01-image-landscape.png",
  0,
  0,
  1200,
  630,
);
const portraitRaster = await referenceCrop(
  "raw-02-image-portrait.png",
  590,
  0,
  440,
  630,
);
const videoRaster = await referenceCrop(
  "raw-03-video-poster.png",
  0,
  0,
  1200,
  336,
);
const pdfRaster = await referenceCrop(
  "raw-05-pdf-first-page.png",
  660,
  55,
  470,
  575,
);
const artworkRaster = await referenceCrop(
  "raw-09-audio-artwork.png",
  0,
  0,
  630,
  630,
);
const cases = [
  {
    id: "image-landscape",
    reference: "raw-01-image-landscape.png",
    value: model(
      "glacier-traverse-dawn.jpg",
      "JPEG · 8.4 MB · 6000×4000",
      "image",
      {
        family: "image",
        label: "JPEG",
        title: "glacier-traverse-dawn.jpg",
        facts: ["8.4 MB", "6000×4000"],
        sourceDigest: digest,
        visual: { kind: "image", raster: landscapeRaster },
      },
    ),
  },
  {
    id: "image-portrait",
    reference: "raw-02-image-portrait.png",
    value: model(
      "canyon-light-study-07.png",
      "PNG · 21.6 MB · 2832×4240",
      "image",
      {
        family: "image",
        label: "PNG",
        title: "canyon-light-study-07.png",
        facts: ["21.6 MB", "2832×4240"],
        sourceDigest: digest,
        visual: { kind: "image", raster: portraitRaster },
      },
    ),
  },
  {
    id: "video-poster",
    reference: "raw-03-video-poster.png",
    value: model(
      "field-notes-episode-04.mp4",
      "MP4 · 138 MB · 12:04",
      "video",
      {
        family: "video",
        label: "MP4",
        title: "field-notes-episode-04.mp4",
        facts: ["138 MB", "12:04"],
        sourceDigest: digest,
        visual: { kind: "poster", raster: videoRaster },
      },
    ),
  },
  {
    id: "pdf",
    reference: "raw-05-pdf-first-page.png",
    value: model("annual-report-2025.pdf", "PDF · 4.2 MB", "pdf", {
      family: "pdf",
      label: "PDF",
      title: "annual-report-2025.pdf",
      facts: ["4.2 MB"],
      sourceDigest: digest,
      visual: { kind: "page", raster: pdfRaster },
    }),
  },
  {
    id: "markdown",
    reference: "raw-07-markdown.png",
    value: model("deployment-runbook.md", "Markdown · 18 KB", "markdown", {
      family: "markdown",
      label: "Markdown",
      title: "deployment-runbook.md",
      facts: ["18 KB"],
      sourceDigest: digest,
      visual: {
        kind: "markdown",
        lines: [
          "# Deployment Runbook",
          "Order of operations for promoting a build from staging to the production host,",
          "including the rollback path.",
          "## Pre-flight checks",
          "• Verify the target tag exists and the image digest matches",
          "• Confirm storage headroom before the sync window",
          "• Announce the window, then freeze uploads",
        ],
      },
    }),
  },
  {
    id: "code",
    reference: "raw-08-code-text.png",
    value: model("chunked_upload.py", "Python source · 6 KB", "code", {
      family: "code",
      label: "Python source",
      title: "chunked_upload.py",
      facts: ["6 KB"],
      sourceDigest: digest,
      visual: {
        kind: "code",
        lines: [
          "def upload_chunked(path, chunk_size=8_388_608):",
          '    \"\"\"Stream a file to storage in fixed chunks.\"\"\"',
          "    total = os.path.getsize(path)",
          "    with open(path, 'rb') as handle:",
          "        while chunk := handle.read(chunk_size):",
          "            yield chunk, total",
        ],
      },
    }),
  },
  {
    id: "video-no-poster",
    reference: "raw-04-video-no-poster.png",
    value: model(
      "workshop-recording-berlin.mov",
      "QuickTime · 611 MB · 47:26",
      "video",
      {
        family: "video",
        label: "QuickTime",
        title: "workshop-recording-berlin.mov",
        facts: ["611 MB", "47:26"],
        sourceDigest: digest,
        visual: { kind: "binary" },
      },
    ),
  },
  {
    id: "document",
    reference: "raw-06-document-title.png",
    value: model("q3-field-study.docx", "Word document · 1.8 MB", "document", {
      family: "document",
      label: "Internal research",
      title: "q3-field-study.docx",
      facts: ["1.8 MB"],
      sourceDigest: digest,
      visual: {
        kind: "text",
        lines: [
          "Q3 Field Study — Cold-Storage Latency",
          "Methodology, sampling windows, and observed retrieval",
          "percentiles across three regions.",
        ],
      },
    }),
  },
  {
    id: "waveform",
    reference: "raw-10-audio-waveform.png",
    value: model(
      "river-crossing-interview.mp3",
      "MP3 · 96 MB · 1:02:45",
      "audio",
      {
        family: "audio",
        label: "MP3",
        title: "river-crossing-interview.mp3",
        facts: ["96 MB", "1:02:45"],
        sourceDigest: digest,
        visual: {
          kind: "waveform",
          samples: Array.from(
            { length: 48 },
            (_, index) => 0.2 + ((index * 37) % 80) / 100,
          ),
        },
      },
    ),
  },
  {
    id: "audio-artwork",
    reference: "raw-09-audio-artwork.png",
    value: model(
      "field-recordings-vol-2.flac",
      "FLAC · 412 MB · 48:12",
      "audio",
      {
        family: "audio",
        label: "FLAC",
        title: "field-recordings-vol-2.flac",
        facts: ["412 MB", "48:12"],
        sourceDigest: digest,
        visual: { kind: "artwork", raster: artworkRaster },
      },
    ),
  },
  {
    id: "archive",
    reference: "raw-11-archive-targz.png",
    value: model(
      "site-backup-2026-08-01.tar.gz",
      "tar.gz · 1.2 GB",
      "archive",
      {
        family: "archive",
        label: "tar.gz",
        title: "site-backup-2026-08-01.tar.gz",
        facts: ["1.2 GB"],
        sourceDigest: digest,
        visual: {
          kind: "archive",
          entries: ["manifest.json", "database.sql", "assets.tar"],
        },
      },
    ),
  },
  {
    id: "binary",
    reference: "raw-12-generic-binary.png",
    value: model("firmware-update-v3.2.bin", "Binary · 87 MB", "binary", {
      family: "binary",
      label: "Binary",
      title: "firmware-update-v3.2.bin",
      facts: ["87 MB"],
      sourceDigest: digest,
      visual: { kind: "binary" },
    }),
  },
] as const;

async function metric(referencePath: string, generated: Buffer) {
  const reference = await sharp(referencePath).removeAlpha().raw().toBuffer();
  const actual = await sharp(generated).removeAlpha().raw().toBuffer();
  assert.equal(reference.length, actual.length);
  let squared = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const difference = (reference[index] ?? 0) - (actual[index] ?? 0);
    squared += difference * difference;
  }
  const rmse = Math.sqrt(squared / reference.length);
  const referenceSmall = await sharp(referencePath)
    .resize(120, 63)
    .grayscale()
    .raw()
    .toBuffer();
  const actualSmall = await sharp(generated)
    .resize(120, 63)
    .grayscale()
    .raw()
    .toBuffer();
  let lowSquared = 0;
  for (let index = 0; index < referenceSmall.length; index += 1) {
    const difference = (referenceSmall[index] ?? 0) - (actualSmall[index] ?? 0);
    lowSquared += difference * difference;
  }
  return {
    rmse: Number(rmse.toFixed(3)),
    lowResolutionRmse: Number(
      Math.sqrt(lowSquared / referenceSmall.length).toFixed(3),
    ),
  };
}

const metrics: Record<string, { rmse: number; lowResolutionRmse: number }> = {};
let markdown: Buffer | undefined;
for (const item of cases) {
  const generated = await renderOgImage({} as never, {} as never, item.value);
  await writeFile(path.join(outputRoot, `generated-${item.id}.png`), generated);
  metrics[item.id] = await metric(
    path.join(referenceRoot, item.reference),
    generated,
  );
  if (item.id === "markdown") markdown = generated;
}
assert.ok(markdown);

const imessageReference = path.join(referenceRoot, "imessage-07-markdown.png");
const contextMetadata = await sharp(imessageReference).metadata();
assert.deepEqual(
  { width: contextMetadata.width, height: contextMetadata.height },
  { width: 2880, height: 1020 },
);
await sharp(imessageReference)
  .composite([
    { input: markdown, left: 100, top: 150 },
    { input: markdown, left: 1540, top: 150 },
  ])
  .png()
  .toFile(path.join(outputRoot, "imessage-markdown-light-dark.png"));
await sharp(markdown)
  .resize(360, 189)
  .png()
  .toFile(path.join(outputRoot, "mobile-markdown-360.png"));
await sharp(markdown)
  .resize(320, 168)
  .png()
  .toFile(path.join(outputRoot, "mobile-markdown-320.png"));

const limits = {
  maximumFullResolutionRmse: 52,
  maximumLowResolutionRmse: 35,
};
for (const [id, value] of Object.entries(metrics)) {
  assert.ok(
    value.rmse <= limits.maximumFullResolutionRmse,
    `${id} full-resolution RMSE ${value.rmse}`,
  );
  assert.ok(
    value.lowResolutionRmse <= limits.maximumLowResolutionRmse,
    `${id} low-resolution RMSE ${value.lowResolutionRmse}`,
  );
}
const report = {
  references: cases.length,
  dimensions: "1200x630",
  metrics,
  limits,
  imessageContexts: ["dark", "light"],
  mobileWidths: [360, 320],
};
await writeFile(
  path.join(outputRoot, "metrics.json"),
  JSON.stringify(report, null, 2),
);
process.stdout.write(`${JSON.stringify(report)}\n`);
