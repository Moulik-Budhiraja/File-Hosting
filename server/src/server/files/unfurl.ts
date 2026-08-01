import { open, readFile } from "node:fs/promises";

import sharp from "sharp";

import { extractFirstMarkdownHeading } from "./preview";
import type { FileService } from "./service";
import { BASE62_ID_PATTERN, type StoredFile } from "./types";

const CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/gu;
const WHITESPACE_TO_SPACE = /[\t\r\n]/gu;
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const TITLE_MAX_BYTES = 300;
const DESCRIPTION_MAX_BYTES = 400;
const MARKDOWN_READ_LIMIT = 256 * 1024;
const RASTER_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_RASTER_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_RASTER_PIXELS = 40_000_000;

export interface PublicUnfurlModel {
  title: string;
  description?: string;
  ogType: "article" | "website";
  twitterCard: "summary" | "summary_large_image";
  canonicalUrl: string;
  imageUrl: string;
  imageAlt: string;
  kind:
    "markdown" | "document" | "image" | "pdf" | "audio" | "video" | "binary";
  eligibleRaster: boolean;
}

export function sanitizeUnfurlText(value: string, maxBytes: number): string {
  const cleaned = value
    .normalize("NFC")
    .replace(WHITESPACE_TO_SPACE, " ")
    .replace(CONTROL_PATTERN, "")
    .replace(BIDI_CONTROLS, "")
    .replace(/ {2,}/gu, " ")
    .trim();

  let bytes = 0;
  let end = 0;
  for (const character of cleaned) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maxBytes) break;
    end += character.length;
  }
  return cleaned.slice(0, end).trim();
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function publicShareUrl(publicUrl: string, slug: string): string {
  if (!BASE62_ID_PATTERN.test(slug)) throw new Error("Invalid public slug");
  return `${publicUrl.replace(/\/+$/u, "")}/${slug}`;
}

export function publicUnfurlRevisionMatches(
  before: StoredFile,
  after: StoredFile | null,
): after is StoredFile {
  return (
    after?.visibility === "public" &&
    after.updatedAt === before.updatedAt &&
    after.name === before.name &&
    after.mimeType === before.mimeType &&
    after.size === before.size &&
    after.sha256 === before.sha256
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size;
  let unit = "B";
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function classify(file: StoredFile): PublicUnfurlModel["kind"] {
  if (
    file.mimeType === "text/markdown" ||
    file.mimeType === "text/x-markdown" ||
    /\.(?:md|markdown|mdown|mkd)$/iu.test(file.name)
  ) {
    return "markdown";
  }
  if (file.mimeType === "application/pdf") return "pdf";
  if (file.mimeType.startsWith("audio/")) return "audio";
  if (file.mimeType.startsWith("video/")) return "video";
  if (file.mimeType.startsWith("image/")) return "image";
  if (file.mimeType.startsWith("text/")) return "document";
  return "binary";
}

export function rasterEnvelopeEligible(
  sourceBytes: number,
  width: number,
  height: number,
): boolean {
  return (
    Number.isSafeInteger(sourceBytes) &&
    sourceBytes >= 0 &&
    sourceBytes <= MAX_RASTER_SOURCE_BYTES &&
    Number.isSafeInteger(width) &&
    width > 0 &&
    Number.isSafeInteger(height) &&
    height > 0 &&
    width <= Math.floor(MAX_RASTER_PIXELS / height)
  );
}

interface RasterDimensions {
  width: number;
  height: number;
}

async function inspectEligibleRaster(
  service: FileService,
  file: StoredFile,
): Promise<RasterDimensions | null> {
  if (
    !RASTER_MIME_TYPES.has(file.mimeType) ||
    file.size > MAX_RASTER_SOURCE_BYTES
  ) {
    return null;
  }
  try {
    const source = await readFile(service.storagePath(file));
    if (source.length > MAX_RASTER_SOURCE_BYTES) return null;
    const metadata = await sharp(source, {
      failOn: "error",
      limitInputPixels: MAX_RASTER_PIXELS,
      sequentialRead: true,
    })
      .timeout({ seconds: 2 })
      .metadata();
    const expected: Record<string, string> = {
      "image/jpeg": "jpeg",
      "image/png": "png",
      "image/webp": "webp",
    };
    const eligible =
      metadata.format === expected[file.mimeType] &&
      (metadata.pages ?? 1) === 1 &&
      rasterEnvelopeEligible(
        source.length,
        metadata.width ?? 0,
        metadata.height ?? 0,
      );
    return eligible
      ? { width: metadata.width ?? 0, height: metadata.height ?? 0 }
      : null;
  } catch {
    return null;
  }
}

async function markdownHeading(
  service: FileService,
  file: StoredFile,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(service.storagePath(file), "r");
    const bytes = Buffer.alloc(Math.min(file.size, MARKDOWN_READ_LIMIT));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, bytesRead),
    );
    const heading = extractFirstMarkdownHeading(decoded);
    return heading ? sanitizeUnfurlText(heading, TITLE_MAX_BYTES) : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export async function buildUnfurlModel(
  service: FileService,
  file: StoredFile,
): Promise<PublicUnfurlModel> {
  if (file.visibility !== "public")
    throw new Error("Unfurls require a public file");
  const kind = classify(file);
  const filename =
    sanitizeUnfurlText(file.name, TITLE_MAX_BYTES) || "Untitled file";
  const title =
    kind === "markdown"
      ? ((await markdownHeading(service, file)) ?? filename)
      : filename;
  const labels: Record<PublicUnfurlModel["kind"], string> = {
    markdown: "Markdown",
    document: "Text document",
    image:
      file.mimeType === "image/jpeg"
        ? "JPEG image"
        : file.mimeType === "image/png"
          ? "PNG image"
          : file.mimeType === "image/webp"
            ? "WebP image"
            : "Image",
    pdf: "PDF",
    audio: "Audio",
    video: "Video",
    binary: "Binary file",
  };
  const raster =
    kind === "image" ? await inspectEligibleRaster(service, file) : null;
  const dimensions = raster ? `${raster.width} × ${raster.height} · ` : "";
  const description = sanitizeUnfurlText(
    `${labels[kind]} · ${dimensions}${formatBytes(file.size)}`,
    DESCRIPTION_MAX_BYTES,
  );
  const eligibleRaster = raster !== null;
  const canonicalUrl = publicShareUrl(service.config.publicUrl, file.id);
  const imageUrl = `${service.config.publicUrl.replace(/\/+$/u, "")}/og/${file.id}.png`;
  const altLabel =
    kind === "markdown"
      ? "Markdown document"
      : kind === "pdf"
        ? "PDF document"
        : labels[kind];
  const imageAlt =
    kind === "image"
      ? `Image hosted on File-Hosting: ${filename}`
      : `File-Hosting preview card: ${title}, ${altLabel}`;

  return {
    title,
    description,
    ogType:
      kind === "markdown" || kind === "document" || kind === "pdf"
        ? "article"
        : "website",
    twitterCard: eligibleRaster ? "summary_large_image" : "summary",
    canonicalUrl,
    imageUrl,
    imageAlt: sanitizeUnfurlText(imageAlt, DESCRIPTION_MAX_BYTES),
    kind,
    eligibleRaster,
  };
}

export function renderUnfurlHead(model: PublicUnfurlModel): string {
  const tags: Array<["property" | "name", string, string]> = [
    ["property", "og:site_name", "File-Hosting"],
    ["property", "og:title", model.title],
    ...(model.description
      ? ([["property", "og:description", model.description]] as Array<
          ["property", string, string]
        >)
      : []),
    ["property", "og:type", model.ogType],
    ["property", "og:url", model.canonicalUrl],
    ["property", "og:image", model.imageUrl],
    ["property", "og:image:width", "1200"],
    ["property", "og:image:height", "630"],
    ["property", "og:image:type", "image/png"],
    ["property", "og:image:alt", model.imageAlt],
    ["name", "twitter:card", model.twitterCard],
    ["name", "twitter:title", model.title],
    ...(model.description
      ? ([["name", "twitter:description", model.description]] as Array<
          ["name", string, string]
        >)
      : []),
    ["name", "twitter:image", model.imageUrl],
    ["name", "twitter:image:alt", model.imageAlt],
  ];
  return `${tags
    .map(
      ([attribute, key, value]) =>
        `<meta ${attribute}="${key}" content="${escapeHtmlAttribute(value)}">`,
    )
    .join(
      "\n    ",
    )}\n    <link rel="canonical" href="${escapeHtmlAttribute(model.canonicalUrl)}">`;
}
