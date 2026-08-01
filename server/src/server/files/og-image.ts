import { readFile } from "node:fs/promises";

import sharp from "sharp";

import type { FileService } from "./service";
import { rasterEnvelopeEligible, type PublicUnfurlModel } from "./unfurl";
import type { StoredFile } from "./types";

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
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

function titleLines(
  title: string,
  maxColumns: number,
  maxLines: number,
): string[] {
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      title,
    ),
  ].map(({ segment }) => segment);
  const lines: string[] = [];
  let current = "";
  let columns = 0;
  let consumed = 0;
  for (const grapheme of graphemes) {
    const width =
      /[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hangul}]/u.test(
        grapheme,
      )
        ? 2
        : 1;
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
    lines[lines.length - 1] = `${lines.at(-1)?.replace(/[\s.…-]*$/u, "")}…`;
  }
  return lines.length > 0 ? lines : ["Untitled file"];
}

function cardSvg(model: PublicUnfurlModel, hasThumbnail: boolean): Buffer {
  const titleWidth = hasThumbnail ? 23 : 38;
  const lines = titleLines(model.title, titleWidth, 3);
  const title = lines
    .map(
      (line, index) =>
        `<tspan x="92" dy="${index === 0 ? 0 : 72}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  const descriptionParts = (model.description ?? "").split(" · ");
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
    <text x="124" y="98" fill="#A2A8B4" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, Roboto, sans-serif" font-size="24" font-weight="650" letter-spacing="0.4">File-Hosting</text>
    ${thumbnailFrame}
    <text x="92" y="${titleY}" fill="#E7E9EE" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, Roboto, sans-serif" font-size="58" font-weight="650" letter-spacing="-0.8" direction="auto" style="unicode-bidi:isolate">${title}</text>
    <line x1="92" y1="520" x2="1108" y2="520" stroke="#22262E" stroke-width="2"/>
    <text x="92" y="561" fill="#6EA8DC" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, Roboto, sans-serif" font-size="22" font-weight="650" letter-spacing="1.2">${escapeXml(kind)}</text>
    <text x="1108" y="561" fill="#A2A8B4" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, Roboto, sans-serif" font-size="22" text-anchor="end" style="font-variant-numeric:tabular-nums">${escapeXml(facts)}</text>
  </svg>`);
}

async function safeRasterThumbnail(
  service: FileService,
  file: StoredFile,
  model: PublicUnfurlModel,
): Promise<Buffer | null> {
  if (!model.eligibleRaster || file.size > MAX_SOURCE_BYTES) return null;
  try {
    const source = await readFile(service.storagePath(file));
    if (source.length > MAX_SOURCE_BYTES) return null;
    const input = sharp(source, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
    }).timeout({ seconds: DECODE_TIMEOUT_SECONDS });
    const metadata = await input.metadata();
    const expectedFormat: Record<string, string> = {
      "image/jpeg": "jpeg",
      "image/png": "png",
      "image/webp": "webp",
    };
    if (
      metadata.format !== expectedFormat[file.mimeType] ||
      !rasterEnvelopeEligible(
        source.length,
        metadata.width ?? 0,
        metadata.height ?? 0,
      ) ||
      (metadata.pages ?? 1) !== 1
    ) {
      return null;
    }
    return await sharp(source, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
    })
      .timeout({ seconds: DECODE_TIMEOUT_SECONDS })
      .rotate()
      .resize(386, 386, { fit: "cover", position: "centre" })
      .toColorspace("srgb")
      .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
      .toBuffer();
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
    base.composite([{ input: thumbnail, left: 720, top: 114 }]);
  }
  return base
    .flatten({ background: "#15171C" })
    .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
    .toBuffer();
}
