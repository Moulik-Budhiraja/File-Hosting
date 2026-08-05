import { derivePreview, type PreviewExtraction } from "./preview-renderers";
import type { FileService } from "./service";
import { sanitizeLocatorFreeText, sanitizePublicText } from "./text-safety";
import { BASE62_ID_PATTERN, type StoredFile } from "./types";

const TITLE_MAX_BYTES = 300;
const DESCRIPTION_MAX_BYTES = 400;
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
  preparedPreview?: PreviewExtraction,
): Promise<PublicUnfurlModel> {
  if (file.visibility !== "public")
    throw new Error("Unfurls require a public file");
  const preview =
    preparedPreview ??
    (await derivePreview({
      trustedMime: file.mimeType,
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      sourcePath: service.storagePath(file),
    }));
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
