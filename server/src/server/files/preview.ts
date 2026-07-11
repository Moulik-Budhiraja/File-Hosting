import { open } from "node:fs/promises";

import type { FileService } from "./service";
import type { StoredFile } from "./types";

const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isTextPreview(file: StoredFile): boolean {
  return (
    file.mimeType.startsWith("text/") ||
    file.mimeType === "application/json" ||
    file.mimeType === "application/xml" ||
    file.mimeType.endsWith("+json") ||
    file.mimeType.endsWith("+xml") ||
    file.mimeType === "image/svg+xml"
  );
}

async function readTextPreview(
  service: FileService,
  file: StoredFile,
): Promise<{
  content: string;
  truncated: boolean;
}> {
  const handle = await open(service.storagePath(file), "r");
  try {
    const buffer = Buffer.alloc(
      Math.min(file.size, MAX_TEXT_PREVIEW_BYTES + 1),
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated =
      file.size > MAX_TEXT_PREVIEW_BYTES || bytesRead > MAX_TEXT_PREVIEW_BYTES;
    return {
      content: buffer
        .subarray(0, Math.min(bytesRead, MAX_TEXT_PREVIEW_BYTES))
        .toString("utf8"),
      truncated,
    };
  } finally {
    await handle.close();
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = size;
  let unit = "B";
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export async function renderPreview(
  service: FileService,
  file: StoredFile,
): Promise<string> {
  const rawUrl = `/raw/${encodeURIComponent(file.id)}`;
  let preview: string;
  if (isTextPreview(file)) {
    const text = await readTextPreview(service, file);
    preview = `<pre>${escapeHtml(text.content)}</pre>${
      text.truncated
        ? '<p class="notice">Preview truncated at 256 KiB.</p>'
        : ""
    }`;
  } else if (file.mimeType.startsWith("image/")) {
    preview = `<img src="${rawUrl}" alt="${escapeHtml(file.name)}">`;
  } else if (file.mimeType.startsWith("audio/")) {
    preview = `<audio src="${rawUrl}" controls></audio>`;
  } else if (file.mimeType.startsWith("video/")) {
    preview = `<video src="${rawUrl}" controls></video>`;
  } else if (file.mimeType === "application/pdf") {
    preview = `<iframe src="${rawUrl}" title="${escapeHtml(file.name)}"></iframe>`;
  } else {
    preview =
      '<p class="notice">No browser preview is available for this file type.</p>';
  }

  const tags =
    file.tags.length > 0 ? file.tags.map(escapeHtml).join(", ") : "none";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(file.name)}</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { max-width: 72rem; margin: 0 auto; padding: 2rem; line-height: 1.5; }
      header { border-bottom: 1px solid #8886; margin-bottom: 1.5rem; padding-bottom: 1rem; }
      h1 { font-size: 1.35rem; overflow-wrap: anywhere; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: .3rem 1rem; font-size: .9rem; }
      dt { font-weight: 600; } dd { margin: 0; overflow-wrap: anywhere; }
      pre { border: 1px solid #8886; border-radius: .5rem; overflow: auto; padding: 1rem; white-space: pre-wrap; word-break: break-word; }
      img, video, iframe { border: 1px solid #8886; display: block; max-width: 100%; width: 100%; }
      img { height: auto; object-fit: contain; } video, iframe { min-height: 60vh; }
      audio { width: 100%; } .notice { padding: 1rem; background: #8882; border-radius: .5rem; }
      a { color: #3b82f6; }
    </style>
  </head>
  <body>
    <header>
      <h1>${escapeHtml(file.name)}</h1>
      <dl>
        <dt>ID</dt><dd>${escapeHtml(file.id)}</dd>
        <dt>Size</dt><dd>${escapeHtml(formatBytes(file.size))}</dd>
        <dt>Type</dt><dd>${escapeHtml(file.mimeType)}</dd>
        <dt>Visibility</dt><dd>${escapeHtml(file.visibility)}</dd>
        <dt>Tags</dt><dd>${tags}</dd>
        <dt>SHA-256</dt><dd>${escapeHtml(file.sha256)}</dd>
      </dl>
      <p><a href="${rawUrl}" download="${escapeHtml(file.name)}">Open raw file</a></p>
    </header>
    <main>${preview}</main>
  </body>
</html>`;
}
