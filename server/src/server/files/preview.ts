import { open } from "node:fs/promises";

import MarkdownIt from "markdown-it";

import type { FileService } from "./service";
import type { StoredFile } from "./types";

const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const ALLOWED_URL_SCHEMES = new Set(["http", "https", "mailto"]);

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isMarkdown(file: StoredFile): boolean {
  return (
    file.mimeType === "text/markdown" ||
    file.mimeType === "text/x-markdown" ||
    /\.(?:md|markdown|mdown|mkd)$/iu.test(file.name)
  );
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

function decodedUrlForValidation(value: string): string | null {
  let decoded = value.trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  return decoded.replace(/[\u0000-\u0020\u007f]+/gu, "").toLowerCase();
}

function isSafeMarkdownUrl(value: string): boolean {
  const decoded = decodedUrlForValidation(value);
  if (!decoded || decoded.startsWith("//") || decoded.startsWith("\\\\")) {
    return false;
  }
  if (decoded.includes("\\")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/u.exec(decoded)?.[1];
  return scheme === undefined || ALLOWED_URL_SCHEMES.has(scheme);
}

function createMarkdownRenderer() {
  const markdown = new MarkdownIt({
    breaks: false,
    html: false,
    linkify: true,
    typographer: false,
  });

  markdown.validateLink = isSafeMarkdownUrl;

  const defaultLinkOpen =
    markdown.renderer.rules.link_open ??
    ((tokens, index, options, _environment, renderer) =>
      renderer.renderToken(tokens, index, options));
  markdown.renderer.rules.link_open = (
    tokens,
    index,
    options,
    environment,
    renderer,
  ) => {
    tokens[index]?.attrSet("rel", "nofollow noopener noreferrer");
    return defaultLinkOpen(tokens, index, options, environment, renderer);
  };

  markdown.renderer.rules.image = (tokens, index) => {
    const content = tokens[index]?.content.trim() ?? "";
    const label = content.length > 0 ? content : "Unlabeled image";
    return `<span class="image-alt" role="img" aria-label="Image omitted: ${escapeHtml(label)}">[Image omitted: ${escapeHtml(label)}]</span>`;
  };

  const defaultFence = markdown.renderer.rules.fence;
  markdown.renderer.rules.fence = (
    tokens,
    index,
    options,
    environment,
    renderer,
  ) => {
    const rendered = defaultFence
      ? defaultFence(tokens, index, options, environment, renderer)
      : renderer.renderToken(tokens, index, options);
    return `<div class="code-scroll" role="region" aria-label="Code block" tabindex="0">${rendered}</div>`;
  };

  const defaultCodeBlock = markdown.renderer.rules.code_block;
  markdown.renderer.rules.code_block = (
    tokens,
    index,
    options,
    environment,
    renderer,
  ) => {
    const rendered = defaultCodeBlock
      ? defaultCodeBlock(tokens, index, options, environment, renderer)
      : `<pre><code>${escapeHtml(tokens[index]?.content ?? "")}</code></pre>`;
    return `<div class="code-scroll" role="region" aria-label="Code block" tabindex="0">${rendered}</div>`;
  };

  const defaultTableOpen = markdown.renderer.rules.table_open;
  markdown.renderer.rules.table_open = (
    tokens,
    index,
    options,
    environment,
    renderer,
  ) =>
    `<div class="table-scroll" role="region" aria-label="Table" tabindex="0">${
      defaultTableOpen
        ? defaultTableOpen(tokens, index, options, environment, renderer)
        : renderer.renderToken(tokens, index, options)
    }`;
  markdown.renderer.rules.table_close = () => "</table></div>\n";

  markdown.core.ruler.after("inline", "task-lists", (state) => {
    for (let index = 0; index < state.tokens.length; index += 1) {
      const inline = state.tokens[index];
      if (inline?.type !== "inline" || !inline.children) continue;
      const firstText = inline.children.find((token) => token.type === "text");
      const match = /^\[([ xX])\]\s+/u.exec(firstText?.content ?? "");
      if (!match || !firstText) continue;
      firstText.content = firstText.content.slice(match[0].length);
      const checked = match[1]?.toLowerCase() === "x";
      const checkbox = new state.Token("html_inline", "", 0);
      checkbox.content = `<input type="checkbox"${checked ? " checked" : ""} disabled aria-label="${checked ? "Completed" : "Incomplete"} task"> `;
      inline.children.unshift(checkbox);
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = state.tokens[cursor];
        if (candidate?.type === "list_item_open") {
          candidate.attrJoin("class", "task-list-item");
          break;
        }
        if (candidate?.type === "list_item_close") break;
      }
    }
  });

  return markdown;
}

const markdownRenderer = createMarkdownRenderer();

function renderTruncationNotice(truncated: boolean): string {
  return truncated
    ? '<p class="notice truncation-notice" role="status">Preview truncated at 256 KiB.</p>'
    : "";
}

function metadataRow(label: string, value: string, breakable = false): string {
  return `<div class="metadata-row"><dt>${label}</dt><dd class="metadata-value${breakable ? " metadata-break" : ""}">${value}</dd></div>`;
}

export async function renderPreview(
  service: FileService,
  file: StoredFile,
): Promise<string> {
  const rawUrl = `/raw/${encodeURIComponent(file.id)}`;
  let preview: string;
  if (isTextPreview(file)) {
    const text = await readTextPreview(service, file);
    if (isMarkdown(file)) {
      preview = `<div class="markdown-shell"><article class="markdown-body">${markdownRenderer.render(text.content)}</article></div>${renderTruncationNotice(text.truncated)}`;
    } else {
      preview = `<pre class="text-preview">${escapeHtml(text.content)}</pre>${renderTruncationNotice(text.truncated)}`;
    }
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
  const metadata = [
    metadataRow("ID", escapeHtml(file.id), true),
    metadataRow("Size", escapeHtml(formatBytes(file.size))),
    metadataRow("Type", escapeHtml(file.mimeType), true),
    metadataRow("Visibility", escapeHtml(file.visibility)),
    metadataRow("Tags", tags, true),
    metadataRow("SHA-256", escapeHtml(file.sha256), true),
  ].join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(file.name)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --background: #f7f7f5;
        --surface: #ffffff;
        --text: #1b1c1d;
        --muted: #5d6268;
        --border: #d1d5d8;
        --accent: #075db8;
        --code: #f0f1f2;
        --quote: #e4e7e9;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: #0e1012;
          --surface: #15181b;
          --text: #e8eaed;
          --muted: #a8afb7;
          --border: #343a40;
          --accent: #6eb5ff;
          --code: #1c2024;
          --quote: #2a3036;
        }
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; max-width: 100%; overflow-x: clip; }
      body {
        background: var(--background);
        color: var(--text);
        line-height: 1.55;
        padding: clamp(1rem, 4vw, 2.25rem);
      }
      .page { margin: 0 auto; max-width: 72rem; min-width: 0; }
      .file-header {
        border-bottom: 1px solid var(--border);
        margin-bottom: clamp(1.25rem, 3vw, 2rem);
        padding-bottom: 1rem;
      }
      .file-title {
        font-size: clamp(1.35rem, 4vw, 1.75rem);
        letter-spacing: -.02em;
        line-height: 1.2;
        margin: 0 0 .85rem;
        overflow-wrap: anywhere;
      }
      .metadata {
        display: grid;
        font-size: .875rem;
        gap: .3rem 1.25rem;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin: 0;
      }
      .metadata-row { display: grid; gap: .5rem; grid-template-columns: 6rem minmax(0, 1fr); min-width: 0; }
      .metadata dt { color: var(--muted); font-weight: 650; }
      .metadata dd { margin: 0; min-width: 0; }
      .metadata-break { overflow-wrap: anywhere; word-break: break-word; }
      .raw-action {
        align-items: center;
        color: var(--accent);
        display: inline-flex;
        font-weight: 650;
        margin-top: .75rem;
        min-height: 44px;
        padding: .35rem 0;
        text-decoration-thickness: .09em;
        text-underline-offset: .2em;
      }
      a { color: var(--accent); overflow-wrap: anywhere; text-decoration-thickness: .08em; text-underline-offset: .18em; }
      a:hover { text-decoration-thickness: .14em; }
      :focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
      main { min-width: 0; }
      .markdown-shell { margin: 0 auto; max-width: 70ch; min-width: 0; }
      .markdown-body { font-size: clamp(1rem, 1.4vw, 1.075rem); overflow-wrap: anywhere; word-break: break-word; }
      .markdown-body > :first-child { margin-top: 0; }
      .markdown-body > :last-child { margin-bottom: 0; }
      .markdown-body h1, .markdown-body h2, .markdown-body h3,
      .markdown-body h4, .markdown-body h5, .markdown-body h6 {
        letter-spacing: -.018em;
        line-height: 1.25;
        margin: 1.65em 0 .55em;
      }
      .markdown-body h1 { border-bottom: 1px solid var(--border); font-size: 1.8em; padding-bottom: .3em; }
      .markdown-body h2 { border-bottom: 1px solid var(--border); font-size: 1.45em; padding-bottom: .25em; }
      .markdown-body h3 { font-size: 1.2em; }
      .markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body blockquote { margin: .8em 0; }
      .markdown-body ul, .markdown-body ol { padding-left: 1.6em; }
      .markdown-body li + li { margin-top: .25em; }
      .markdown-body li > ul, .markdown-body li > ol { margin: .25em 0; }
      .task-list-item { list-style: none; }
      .task-list-item input { height: 1rem; margin: 0 .4rem 0 -1.4rem; vertical-align: -.12em; width: 1rem; }
      .markdown-body blockquote { border-left: .25rem solid var(--quote); color: var(--muted); margin-left: 0; padding: .05rem 0 .05rem 1rem; }
      .markdown-body hr { border: 0; border-top: 1px solid var(--border); margin: 1.75rem 0; }
      .markdown-body code {
        background: var(--code);
        border: 1px solid var(--border);
        border-radius: .2rem;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: .88em;
        padding: .1em .3em;
      }
      .code-scroll, .table-scroll {
        max-width: 100%;
        overflow-x: auto;
        overscroll-behavior-inline: contain;
        scrollbar-gutter: stable;
      }
      .code-scroll { background: var(--code); border: 1px solid var(--border); margin: 1rem 0; }
      .code-scroll pre { margin: 0; min-width: max-content; padding: .85rem 1rem; white-space: pre; }
      .code-scroll code { background: transparent; border: 0; padding: 0; }
      .table-scroll { margin: 1rem 0; }
      .markdown-body table { border-collapse: collapse; min-width: 32rem; width: 100%; }
      .markdown-body th, .markdown-body td {
        border: 1px solid var(--border);
        min-width: 8rem;
        overflow-wrap: normal;
        padding: .45rem .65rem;
        text-align: left;
        word-break: normal;
      }
      .markdown-body th { background: var(--code); font-weight: 700; }
      .image-alt { border-left: .2rem solid var(--border); color: var(--muted); display: inline-block; padding-left: .5rem; }
      .text-preview {
        border: 1px solid var(--border);
        margin: 0;
        max-width: 100%;
        overflow: auto;
        padding: 1rem;
        white-space: pre-wrap;
        word-break: break-word;
      }
      img, video, iframe { border: 1px solid var(--border); display: block; max-width: 100%; width: 100%; }
      img { height: auto; object-fit: contain; }
      video, iframe { min-height: 60vh; }
      audio { width: 100%; }
      .notice { background: var(--code); border-left: .25rem solid var(--border); padding: .75rem 1rem; }
      .truncation-notice { margin: 1rem auto 0; max-width: 70ch; }
      @media (max-width: 720px) {
        .metadata { grid-template-columns: 1fr; }
      }
      @media (max-width: 480px) {
        body { padding: .9rem 1rem 1.5rem; }
        .file-header { margin-bottom: 1.1rem; padding-bottom: .75rem; }
        .file-title { margin-bottom: .65rem; }
        .metadata { gap: .2rem; }
        .metadata-row { gap: .4rem; grid-template-columns: 5.25rem minmax(0, 1fr); }
        .raw-action { margin-top: .55rem; }
        .markdown-body h1 { font-size: 1.55em; }
        .markdown-body h2 { font-size: 1.3em; }
        .markdown-body ul, .markdown-body ol { padding-left: 1.35em; }
      }
      @media (forced-colors: active) {
        :focus-visible { outline-color: Highlight; }
        .code-scroll, .table-scroll, .text-preview, .markdown-body th, .markdown-body td { border-color: CanvasText; }
        .markdown-body blockquote, .notice, .image-alt { border-left-color: CanvasText; }
        a { color: LinkText; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header class="file-header">
        <h1 class="file-title">${escapeHtml(file.name)}</h1>
        <dl class="metadata">
          ${metadata}
        </dl>
        <a class="raw-action" href="${rawUrl}" download="${escapeHtml(file.name)}">Open raw file</a>
      </header>
      <main>${preview}</main>
    </div>
  </body>
</html>`;
}
