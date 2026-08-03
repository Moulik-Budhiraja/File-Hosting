import { open } from "node:fs/promises";

import { extractFirstMarkdownHeading } from "./preview";
import { derivePreview, type PreviewExtraction } from "./preview-renderers";
import type { FileService } from "./service";
import { sanitizeLocatorFreeText, sanitizePublicText } from "./text-safety";
import { BASE62_ID_PATTERN, type StoredFile } from "./types";

const TITLE_MAX_BYTES = 300;
const DESCRIPTION_MAX_BYTES = 400;
const MARKDOWN_READ_LIMIT = 256 * 1024;
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
    | "markdown"
    | "document"
    | "text"
    | "code"
    | "image"
    | "pdf"
    | "audio"
    | "video"
    | "archive"
    | "binary";
  eligibleRaster: boolean;
  preview?: PreviewExtraction;
}

export const sanitizeUnfurlText = sanitizePublicText;

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
    return heading
      ? sanitizeUnfurlText(heading, TITLE_MAX_BYTES) || null
      : null;
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
  const preview = await derivePreview({
    trustedMime: file.mimeType,
    name: file.name,
    size: file.size,
    sha256: file.sha256,
    sourcePath: service.storagePath(file),
  });
  const supportedKinds = new Set<PublicUnfurlModel["kind"]>([
    "markdown",
    "document",
    "text",
    "code",
    "image",
    "pdf",
    "audio",
    "video",
    "archive",
    "binary",
  ]);
  const kind: PublicUnfurlModel["kind"] = supportedKinds.has(
    preview.family as PublicUnfurlModel["kind"],
  )
    ? (preview.family as PublicUnfurlModel["kind"])
    : "binary";
  const filename = sanitizeLocatorFreeText(file.name, TITLE_MAX_BYTES, "File");
  const heading =
    kind === "markdown" ? await markdownHeading(service, file) : null;
  const title = sanitizeLocatorFreeText(
    heading ?? filename,
    TITLE_MAX_BYTES,
    filename || "File",
  );
  const description = sanitizeUnfurlText(
    [preview.label, ...preview.facts].filter(Boolean).join(" · "),
    DESCRIPTION_MAX_BYTES,
  );
  const eligibleRaster = ["image", "poster", "page", "artwork"].includes(
    preview.visual.kind,
  );
  const canonicalUrl = publicShareUrl(service.config.publicUrl, file.id);
  const imageUrl = `${service.config.publicUrl.replace(/\/+$/u, "")}/og/${file.id}.png`;
  const altLabel =
    kind === "markdown"
      ? "Markdown document"
      : kind === "pdf"
        ? "PDF document"
        : preview.label;
  const imageAlt = `File-Hosting preview card: ${title}, ${altLabel}`;

  return {
    title,
    description,
    ogType: ["markdown", "document", "text", "code", "pdf"].includes(kind)
      ? "article"
      : "website",
    twitterCard: "summary_large_image",
    canonicalUrl,
    imageUrl,
    imageAlt: sanitizeLocatorFreeText(
      imageAlt,
      DESCRIPTION_MAX_BYTES,
      "File-Hosting file preview",
    ),
    kind,
    eligibleRaster,
    preview,
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
