import sharp from "sharp";

import { deriveRasterThumbnailInWorker } from "./raster-worker";
import type { FileService } from "./service";
import { sanitizePublicText } from "./text-safety";
import type { PublicUnfurlModel } from "./unfurl";
import type { StoredFile } from "./types";

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_INPUT_PIXELS = 40_000_000;
const DECODE_TIMEOUT_SECONDS = 2;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function graphemeColumns(grapheme: string): number {
  return /[◆…A-Z0-9mw]|[^\u0000-\u007F]/u.test(grapheme) ? 2 : 1;
}

function displayGrapheme(grapheme: string): string {
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return "◆";
  return grapheme.replace(/[\uFE0E\uFE0F]/gu, "");
}

export function layoutOgTitle(
  title: string,
  maxColumns: number,
  maxLines: number,
): string[] {
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      title,
    ),
  ]
    .map(({ segment }) => displayGrapheme(segment))
    .filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let columns = 0;
  let consumed = 0;
  for (const grapheme of graphemes) {
    const width = graphemeColumns(grapheme);
    if (columns + width > maxColumns && current) {
      lines.push(current.trimEnd());
      if (lines.length === maxLines) break;
      current = "";
      columns = 0;
    }
    current += grapheme;
    columns += width;
    consumed += 1;
  }
  if (lines.length < maxLines && current) lines.push(current.trimEnd());
  if (consumed < graphemes.length && lines.length > 0) {
    const finalLine = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        lines.at(-1)?.replace(/[\s.…-]*$/u, "") ?? "",
      ),
    ].map(({ segment }) => segment);
    while (
      finalLine.reduce(
        (total, segment) => total + graphemeColumns(segment),
        2,
      ) > maxColumns
    ) {
      finalLine.pop();
    }
    lines[lines.length - 1] = `${finalLine.join("")}…`;
  }
  return lines.length > 0 ? lines : ["Untitled file"];
}

function cardSvg(model: PublicUnfurlModel, hasThumbnail: boolean): Buffer {
  const safeTitle = sanitizePublicText(model.title, 300) || "Untitled file";
  const safeDescription = sanitizePublicText(model.description ?? "", 400);
  const titleWidth = hasThumbnail ? 20 : 32;
  const lines = layoutOgTitle(safeTitle, titleWidth, 3);
  const title = lines
    .map(
      (line, index) =>
        `<tspan x="92" dy="${index === 0 ? 0 : 72}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  const descriptionParts = safeDescription.split(" · ");
  const descriptionKind = descriptionParts.shift();
  const kind = (
    descriptionKind?.trim() ? descriptionKind : model.kind
  ).toUpperCase();
  const facts = descriptionParts.join(" · ");
  const thumbnailFrame = hasThumbnail
    ? '<rect x="718" y="112" width="390" height="390" rx="18" fill="#1B1E24" stroke="#2C313B" stroke-width="2"/>'
    : `<g transform="translate(92 140)">
        <rect width="92" height="92" rx="16" fill="#1B1E24" stroke="#2C313B" stroke-width="2"/>
        <path d="M28 20h25l15 15v38H28z M53 20v15h15 M38 50h20 M38 61h20" fill="none" stroke="#A2A8B4" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`;
  const titleY = hasThumbnail ? 202 : 320;

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="1200" height="630" fill="#15171C"/>
    <rect x="92" y="82" width="18" height="18" rx="4" fill="#6EA8DC"/>
    <text x="124" y="98" fill="#A2A8B4" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans', 'Apple SD Gothic Neo', 'Noto Sans CJK SC', 'Noto Sans', Arial, sans-serif" font-size="24" font-weight="650" letter-spacing="0.4">File-Hosting</text>
    ${thumbnailFrame}
    <text x="92" y="${titleY}" fill="#E7E9EE" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans', 'Apple SD Gothic Neo', 'Noto Sans CJK SC', 'Noto Sans', Arial, sans-serif" font-size="58" font-weight="650" letter-spacing="-0.8" direction="auto" style="unicode-bidi:isolate">${title}</text>
    <line x1="92" y1="520" x2="1108" y2="520" stroke="#22262E" stroke-width="2"/>
    <text x="92" y="561" fill="#6EA8DC" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans', 'Apple SD Gothic Neo', 'Noto Sans CJK SC', 'Noto Sans', Arial, sans-serif" font-size="22" font-weight="650" letter-spacing="1.2">${escapeXml(kind)}</text>
    <text x="1108" y="561" fill="#A2A8B4" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans', 'Apple SD Gothic Neo', 'Noto Sans CJK SC', 'Noto Sans', Arial, sans-serif" font-size="22" text-anchor="end" style="font-variant-numeric:tabular-nums">${escapeXml(facts)}</text>
  </svg>`);
}

async function safeRasterThumbnail(
  service: FileService,
  file: StoredFile,
  model: PublicUnfurlModel,
): Promise<Buffer | null> {
  if (!model.eligibleRaster) return null;
  try {
    return await deriveRasterThumbnailInWorker(
      service.storagePath(file),
      file.mimeType,
    );
  } catch {
    return null;
  }
}

export async function renderOgImage(
  service: FileService,
  file: StoredFile,
  model: PublicUnfurlModel,
): Promise<Buffer> {
  const thumbnail = await safeRasterThumbnail(service, file, model);
  const base = sharp(cardSvg(model, thumbnail !== null), {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
  }).timeout({ seconds: DECODE_TIMEOUT_SECONDS });
  if (thumbnail) {
    const mask = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="386" height="386"><rect width="386" height="386" rx="16" fill="white"/></svg>',
    );
    const roundedThumbnail = await sharp(thumbnail)
      .composite([{ input: mask, blend: "dest-in" }])
      .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
      .toBuffer();
    base.composite([{ input: roundedThumbnail, left: 720, top: 114 }]);
  }
  return base
    .flatten({ background: "#15171C" })
    .removeAlpha()
    .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
    .toBuffer();
}
