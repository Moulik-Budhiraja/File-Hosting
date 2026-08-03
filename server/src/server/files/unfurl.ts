import {
  derivePreview,
  PreviewSourceUnavailableError,
  type PreviewExtraction,
} from "./preview-renderers";
import type { FileService } from "./service";
import { captureSourceIdentity } from "./source-state";
import { sanitizeLocatorFreeText, sanitizePublicText } from "./text-safety";
import { BASE62_ID_PATTERN, type StoredFile } from "./types";

const TITLE_MAX_BYTES = 300;
const DESCRIPTION_MAX_BYTES = 400;
const MAX_CONTENT_PREVIEW_BYTES = 25 * 1024 * 1024;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size;
  let unit = "B";
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value.toFixed(Number.isInteger(value) ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function metadataOnlyPreview(file: StoredFile): PreviewExtraction {
  const mime = file.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  const exact = new Map<string, [PreviewExtraction["family"], string]>([
    ["text/markdown", ["markdown", "MD"]],
    ["text/x-markdown", ["markdown", "MD"]],
    ["application/pdf", ["pdf", "PDF"]],
    ["application/json", ["code", "JSON"]],
    ["application/ld+json", ["code", "JSON-LD"]],
    ["application/rss+xml", ["code", "RSS"]],
    ["application/xml", ["code", "XML"]],
    ["text/x-typescript", ["code", "TS"]],
    ["text/x-python", ["code", "PY"]],
    ["application/zip", ["archive", "ZIP"]],
    ["application/x-tar", ["archive", "TAR"]],
    ["application/gzip", ["archive", "GZIP"]],
    ["video/mp4", ["video", "MP4"]],
    ["video/webm", ["video", "WebM"]],
    ["video/x-msvideo", ["video", "AVI"]],
    ["video/mpeg", ["video", "MPEG"]],
    ["video/quicktime", ["video", "QuickTime"]],
    ["audio/mpeg", ["audio", "MP3"]],
    ["audio/flac", ["audio", "FLAC"]],
    ["image/jpeg", ["image", "JPG"]],
    ["image/png", ["image", "PNG"]],
    ["image/webp", ["image", "WebP"]],
    ["image/gif", ["image", "GIF"]],
    ["image/avif", ["image", "AVIF"]],
  ]);
  const [family, label] =
    exact.get(mime) ??
    (mime.startsWith("image/")
      ? ["image", "IMAGE"]
      : mime.startsWith("video/")
        ? ["video", "Video"]
        : mime.startsWith("audio/")
          ? ["audio", "Audio"]
          : mime.startsWith("text/")
            ? ["text", "TXT"]
            : ["binary", "BIN"]);
  return {
    family,
    label,
    title:
      sanitizeLocatorFreeText(file.name, TITLE_MAX_BYTES, "File") || "File",
    facts: [formatBytes(file.size)],
    sourceDigest: file.sha256,
    visual: { kind: "binary" },
  };
}

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
  preview?: PreviewExtraction;
}

export const sanitizeUnfurlText = sanitizePublicText;

function publicDescriptionLabel(preview: PreviewExtraction): string {
  const exact = new Map<string, string>([
    ["JPG", "JPEG"],
    ["MD", "Markdown"],
    ["PY", "Python source"],
    ["JS", "JavaScript source"],
    ["TS", "TypeScript source"],
    ["TSX", "TypeScript source"],
    ["JSX", "JavaScript source"],
    ["SH", "Shell script"],
    ["DOCX", "Word document"],
    ["XLSX", "Excel spreadsheet"],
    ["PPTX", "PowerPoint presentation"],
    ["RTF", "RTF document"],
    ["TAR.GZ", "tar.gz"],
    ["BIN", "Binary"],
  ]);
  return exact.get(preview.label) ?? preview.label;
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

export async function buildUnfurlModel(
  service: FileService,
  file: StoredFile,
): Promise<PublicUnfurlModel> {
  if (file.visibility !== "public")
    throw new Error("Unfurls require a public file");
  let preview: PreviewExtraction;
  try {
    preview = await derivePreview({
      trustedMime: file.mimeType,
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      sourcePath: service.storagePath(file),
    });
  } catch (error) {
    if (
      !(error instanceof PreviewSourceUnavailableError) ||
      file.size <= MAX_CONTENT_PREVIEW_BYTES ||
      (await captureSourceIdentity(service, file)) === null
    ) {
      throw error;
    }
    preview = metadataOnlyPreview(file);
  }
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
  const title = filename || "File";
  const publicLabel = publicDescriptionLabel(preview);
  const description = sanitizeUnfurlText(
    [publicLabel, ...preview.facts].filter(Boolean).join(" · "),
    DESCRIPTION_MAX_BYTES,
  );
  const canonicalUrl = publicShareUrl(service.config.publicUrl, file.id);
  const imageUrl = `${service.config.publicUrl.replace(/\/+$/u, "")}/og/${file.id}.png`;
  const imageAlt = `File-Hosting preview card: ${title}, ${description}`;

  return {
    title,
    description,
    ogType: ["markdown", "document", "text", "code", "pdf"].includes(kind)
      ? "article"
      : "website",
    twitterCard: "summary_large_image",
    canonicalUrl,
    imageUrl,
    imageAlt,
    kind,
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
