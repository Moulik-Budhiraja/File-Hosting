import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { AppError } from "./errors";
import { withNativeAdmission } from "./native-admission";
import { ProcessExecutionError, runKillableProcess } from "./process-tree";
import { BoundedWorkerPool } from "./raster-worker";
import type { FileService } from "./service";
import { sanitizePublicText } from "./text-safety";
import type { PublicUnfurlModel } from "./unfurl";
import type { StoredFile } from "./types";

export const OG_RENDER_LIMITS = Object.freeze({
  maxConcurrent: 1,
  maxQueued: 16,
  maxOldSpaceMiB: 256,
  maxOutputBytes: 8 * 1024 * 1024,
  queueTimeoutMs: 2_500,
  wallTimeoutMs: 2_500,
});

const ogRenderPool = new BoundedWorkerPool(
  OG_RENDER_LIMITS.maxConcurrent,
  OG_RENDER_LIMITS.maxQueued,
  OG_RENDER_LIMITS.queueTimeoutMs,
);
const OG_RENDER_CACHE_MAX_BYTES = 6 * 1024 * 1024;
const ogRenderCache = new Map<string, Buffer>();
let ogRenderCacheBytes = 0;

function cachedRender(key: string): Buffer | undefined {
  const cached = ogRenderCache.get(key);
  if (!cached) return undefined;
  ogRenderCache.delete(key);
  ogRenderCache.set(key, cached);
  return Buffer.from(cached);
}

function cacheRender(key: string, output: Buffer): void {
  if (output.length > OG_RENDER_CACHE_MAX_BYTES) return;
  const existing = ogRenderCache.get(key);
  if (existing) ogRenderCacheBytes -= existing.length;
  ogRenderCache.delete(key);
  const stored = Buffer.from(output);
  ogRenderCache.set(key, stored);
  ogRenderCacheBytes += stored.length;
  while (ogRenderCacheBytes > OG_RENDER_CACHE_MAX_BYTES) {
    const oldest = ogRenderCache.entries().next().value;
    if (!oldest) break;
    ogRenderCache.delete(oldest[0]);
    ogRenderCacheBytes -= oldest[1].length;
  }
}

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

export function layoutOgTitle(
  title: string,
  maxColumns: number,
  maxLines: number,
): string[] {
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      title.trim(),
    ),
  ]
    .map(({ segment }) => segment)
    .filter(Boolean);
  const units: string[][] = [];
  let unit: string[] = [];
  for (const grapheme of graphemes) {
    unit.push(grapheme);
    if (/\s|[-‐‑‒–—]/u.test(grapheme)) {
      units.push(unit);
      unit = [];
    }
  }
  if (unit.length) units.push(unit);

  const lines: string[] = [];
  let current: string[] = [];
  let columns = 0;
  let consumed = 0;
  let truncated = false;
  outer: for (const candidate of units) {
    const candidateWidth = candidate.reduce(
      (total, grapheme) => total + graphemeColumns(grapheme),
      0,
    );
    if (
      current.length > 0 &&
      candidateWidth <= maxColumns &&
      columns + candidateWidth > maxColumns
    ) {
      lines.push(current.join("").trimEnd());
      if (lines.length === maxLines) {
        truncated = true;
        break;
      }
      current = [];
      columns = 0;
    }
    for (const grapheme of candidate) {
      const width = graphemeColumns(grapheme);
      if (columns + width > maxColumns && current.length > 0) {
        lines.push(current.join("").trimEnd());
        if (lines.length === maxLines) {
          truncated = true;
          break outer;
        }
        current = [];
        columns = 0;
      }
      current.push(grapheme);
      columns += width;
      consumed += 1;
    }
  }
  if (lines.length < maxLines && current.length)
    lines.push(current.join("").trimEnd());
  truncated ||= consumed < graphemes.length;
  if (truncated && lines.length > 0) {
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

const SANS = "'Inter',sans-serif";
const MONO = "'JetBrains Mono',monospace";
const EMOJI_DIRECTORY = path.resolve(
  process.cwd(),
  "node_modules/@twemoji/svg",
);
const EMOJI_DATA = new Map<string, string | null>();

function knownEmojiData(grapheme: string): string | undefined {
  const asset = [...grapheme]
    .map((character) => character.codePointAt(0))
    .filter((codepoint) => codepoint !== undefined && codepoint !== 0xfe0f)
    .map((codepoint) => codepoint!.toString(16))
    .join("-");
  if (!asset) return undefined;
  const cached = EMOJI_DATA.get(asset);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const data = `data:image/svg+xml;base64,${readFileSync(
      path.join(EMOJI_DIRECTORY, `${asset}.svg`),
    ).toString("base64")}`;
    EMOJI_DATA.set(asset, data);
    return data;
  } catch {
    EMOJI_DATA.set(asset, null);
    return undefined;
  }
}

interface TextLineStyle {
  fill: string;
  family: string;
  weight?: number;
  letterSpacing?: number;
  preserveWhitespace?: boolean;
  maxWidth?: number;
}

function graphemeAdvance(grapheme: string, size: number): number {
  if (/^\s$/u.test(grapheme)) return size * 0.3;
  if (knownEmojiData(grapheme)) return size * 1.05;
  if (/[^\u0000-\u007F]/u.test(grapheme)) return size;
  if (/[mwMW]/u.test(grapheme)) return size * 0.82;
  if (/[A-Z0-9]/u.test(grapheme)) return size * 0.64;
  if (/[-.,'()\[\]]/u.test(grapheme)) return size * 0.35;
  return size * 0.54;
}

function textLineMarkup(
  line: string,
  x: number,
  y: number,
  size: number,
  style: TextLineStyle,
): string {
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line),
  ].map(({ segment }) => segment);
  const maxWidth = Math.max(1, style.maxWidth ?? 1144 - x);
  const attributes = `${style.preserveWhitespace ? ' xml:space="preserve"' : ""} fill="${style.fill}" font-family="${style.family}" font-size="${size}"${style.weight ? ` font-weight="${style.weight}"` : ""}${style.letterSpacing !== undefined ? ` letter-spacing="${style.letterSpacing}"` : ""} data-max-width="${maxWidth}" data-ellipsis="true" direction="auto" style="unicode-bidi:isolate"`;
  if (!graphemes.some((grapheme) => knownEmojiData(grapheme))) {
    return `<text x="${x}" y="${y}"${attributes}>${escapeXml(line)}</text>`;
  }
  let cursor = x;
  let run = "";
  let runX = x;
  let markup = "";
  const flush = () => {
    if (!run) return;
    markup += `<text x="${runX}" y="${y}"${attributes}>${escapeXml(run)}</text>`;
    run = "";
  };
  for (const grapheme of graphemes) {
    const emojiData = knownEmojiData(grapheme);
    if (emojiData) {
      flush();
      const emojiSize = size * 1.08;
      markup += `<image href="${emojiData}" x="${cursor}" y="${y - size * 0.88}" width="${emojiSize}" height="${emojiSize}" preserveAspectRatio="xMidYMid meet"/>`;
      cursor += graphemeAdvance(grapheme, size);
      runX = cursor;
      continue;
    }
    if (!run) runX = cursor;
    run += grapheme;
    cursor += graphemeAdvance(grapheme, size);
  }
  flush();
  return markup;
}

function titleLineMarkup(
  line: string,
  x: number,
  y: number,
  size: number,
): string {
  return textLineMarkup(line, x, y, size, {
    fill: "#f2f1ec",
    family: SANS,
    weight: 700,
    letterSpacing: -1.3,
  });
}

export function truncateDisplayText(value: string, maxColumns: number): string {
  let columns = 0;
  const graphemes = [
    ...new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(value),
  ].map(({ segment }) => segment);
  const output: string[] = [];
  let truncated = false;
  for (const segment of graphemes) {
    const width = graphemeColumns(segment);
    if (columns + width > maxColumns) {
      truncated = true;
      break;
    }
    output.push(segment);
    columns += width;
  }
  if (!truncated) return output.join("");
  while (
    output.length > 0 &&
    output.reduce((total, segment) => total + graphemeColumns(segment), 2) >
      maxColumns
  ) {
    output.pop();
  }
  return `${output.join("").replace(/[\s.…-]+$/u, "")}…`;
}

function pngDimensions(
  raster: Buffer,
): { width: number; height: number } | null {
  if (
    raster.length < 24 ||
    !raster.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    return null;
  }
  const width = raster.readUInt32BE(16);
  const height = raster.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function composeOgCardSvg(model: PublicUnfurlModel): Buffer {
  const safeTitle = sanitizePublicText(model.title, 300) || "File";
  const fullDescription = sanitizePublicText(model.description ?? "", 400);
  const safeDescription =
    model.preview?.visual.kind === "artwork"
      ? fullDescription
          .split(" · ")
          .filter((fact) => !/^\d{2}:\d{2}(?::\d{2})?$/u.test(fact))
          .join(" · ")
      : fullDescription;
  const titleLines = layoutOgTitle(safeTitle, 34, 2);
  const twoLineTitle = titleLines.length > 1;
  const visual = model.preview?.visual;
  const raster =
    visual && "raster" in visual
      ? `data:image/png;base64,${visual.raster.toString("base64")}`
      : null;
  const contentLines =
    visual && "lines" in visual ? visual.lines.slice(0, 9) : [];
  const dimensions = model.preview?.facts
    .map((fact) => /^(\d+)×(\d+)$/u.exec(fact))
    .find((match) => match !== null);
  const portraitRaster = dimensions
    ? Number(dimensions[2]) > Number(dimensions[1])
    : false;
  const brand = (x = 56, y = 64, anchor = "start") =>
    `<rect x="${anchor === "end" ? x - 243 : x}" y="${y - 12}" width="9" height="9" rx="2" fill="#e3a44f"/><text x="${anchor === "end" ? x : x + 20}" y="${y}" fill="#9fa3a9" font-family="${MONO}" font-size="20" font-weight="500" letter-spacing="2"${anchor === "end" ? ' text-anchor="end"' : ""}>files.moulik.dev</text>`;
  const titleText = (
    x: number,
    y: number,
    size = 64,
    width = 34,
    maxLines = 2,
  ) =>
    layoutOgTitle(safeTitle, width, maxLines)
      .map((line, index) =>
        titleLineMarkup(line, x, y + index * (size + 5), size),
      )
      .join("");
  const facts = (x = 56, y = 590) =>
    textLineMarkup(safeDescription, x, y, 28, {
      fill: "#9fa3a9",
      family: MONO,
      letterSpacing: 1.5,
      maxWidth: 1144 - x,
    });
  const play = (x: number, y: number) =>
    `<circle cx="${x}" cy="${y}" r="31" fill="#0d0e10" fill-opacity="0.58" stroke="#9fa3a9" stroke-width="2"/><path d="M${x - 9} ${y - 13}l22 13-22 13z" fill="#f2f1ec"/>`;
  let body = "";

  if (model.kind === "image" && raster) {
    const portraitTitleLines = layoutOgTitle(safeTitle, 20, 2);
    body = portraitRaster
      ? `${brand()}<image href="${raster}" x="590" y="0" width="440" height="630" preserveAspectRatio="xMidYMid slice"/>${titleText(56, portraitTitleLines.length > 1 ? 462 : 522, 58, 20)}${facts(56, 575)}`
      : `<image href="${raster}" x="0" y="0" width="1200" height="630" preserveAspectRatio="xMidYMid slice"/><rect width="1200" height="630" fill="url(#shade)"/>${brand()}${titleText(56, twoLineTitle ? 480 : 526, 58, 30)}${facts()}`;
  } else if (model.kind === "video" && raster) {
    body = `<image href="${raster}" x="0" y="0" width="1200" height="630" preserveAspectRatio="xMidYMid slice"/><rect width="1200" height="630" fill="url(#videoShade)"/>${brand()}${titleText(56, twoLineTitle ? 440 : 520, 72, 28)}${facts(56, 596)}${play(1104, 528)}`;
  } else if (model.kind === "video") {
    const timeline = `<line x1="56" y1="320" x2="1143" y2="320" stroke="#30343a" stroke-width="2"/><path d="M56 310v20M193 314v12M329 310v20M465 314v12M601 310v20M737 314v12M873 310v20M1009 314v12M1143 310v20" stroke="#44484f" stroke-width="2"/>`;
    body = `${brand()}${play(84, 224)}${timeline}${titleText(56, twoLineTitle ? 466 : 526, 60, 40)}${facts(56, 575)}`;
  } else if (model.kind === "pdf" && visual?.kind === "page") {
    const pageDimensions =
      raster && visual.raster ? pngDimensions(visual.raster) : null;
    const landscapePage =
      pageDimensions !== null &&
      pageDimensions.width / pageDimensions.height >= 1.2;
    const page = raster
      ? landscapePage
        ? `<image href="${raster}" x="0" y="-170" width="1200" height="760" preserveAspectRatio="xMidYMin slice"/>`
        : `<image href="${raster}" x="400" y="-12" width="800" height="1035" preserveAspectRatio="xMidYMin meet"/>`
      : `<rect x="540" y="0" width="660" height="630" fill="#f6f5f1"/>${contentLines
          .slice(0, 6)
          .map((line, index) =>
            textLineMarkup(
              truncateDisplayText(line, 42),
              580,
              90 + index * 58,
              index === 0 ? 30 : 21,
              {
                fill: "#2a2e34",
                family: SANS,
                weight: index === 0 ? 700 : 400,
                maxWidth: 560,
              },
            ),
          )
          .join("")}`;
    const pdfTitleLines = layoutOgTitle(
      safeTitle,
      landscapePage ? 27 : 12,
      landscapePage ? 2 : 3,
    );
    body = landscapePage
      ? `${page}<rect x="0" y="330" width="1200" height="300" fill="url(#pdfShade)"/>${brand()}${titleText(56, pdfTitleLines.length > 1 ? 442 : 526, 68, 27)}${facts(56, 596)}`
      : `${brand()}${page}<rect x="350" y="0" width="110" height="630" fill="url(#pageFade)"/>${titleText(56, pdfTitleLines.length > 2 ? 335 : pdfTitleLines.length > 1 ? 415 : 510, 56, 12, 3)}${facts(56, 594)}`;
  } else if (model.kind === "document" && visual?.kind !== "binary") {
    const documentHeading = layoutOgTitle(contentLines[0] ?? safeTitle, 26, 2)
      .map((line, index) =>
        textLineMarkup(line, 312, 224 + index * 54, 45, {
          fill: "#202329",
          family: SANS,
          weight: 700,
          letterSpacing: -1,
        }),
      )
      .join("");
    const documentBody = contentLines
      .slice(1, 3)
      .map((line, index) =>
        textLineMarkup(
          truncateDisplayText(line, 62),
          312,
          341 + index * 30,
          20,
          { fill: "#63615d", family: SANS },
        ),
      )
      .join("");
    const documentLabel = contentLines[0]
      ? `<text x="312" y="145" fill="#8b8983" font-family="${MONO}" font-size="17" letter-spacing="3">${escapeXml((model.preview?.label ?? "Document").toUpperCase())}</text>`
      : "";
    body = `<rect x="240" y="65" width="720" height="416" fill="#f4f2ed"/>${documentLabel}${documentHeading}${documentBody}<rect x="312" y="420" width="576" height="10" fill="#d0cec8"/><rect x="312" y="440" width="576" height="10" fill="#d0cec8"/><rect x="312" y="460" width="498" height="10" fill="#d0cec8"/><rect x="0" y="481" width="1200" height="149" fill="#0d0e10"/>${titleText(56, 553, 38, 42)}${facts(56, 591)}${brand(1144, 560, "end")}`;
  } else if (model.kind === "text" && visual && "lines" in visual) {
    const pageLines = contentLines
      .slice(0, 8)
      .map((line, index) =>
        textLineMarkup(
          truncateDisplayText(line, 38),
          708,
          120 + index * 48,
          index === 0 ? 28 : 19,
          {
            fill: index === 0 ? "#202329" : "#5e5f60",
            family: SANS,
            weight: index === 0 ? 700 : 400,
          },
        ),
      )
      .join("");
    body = `${brand()}<rect x="660" y="55" width="470" height="575" fill="#f6f5f1"/>${pageLines}${titleText(56, titleLines.length > 1 ? 430 : 480, 48, 20)}${facts(56, 576)}`;
  } else if (model.kind === "markdown") {
    let y = 104;
    const excerpt = contentLines
      .slice(0, 5)
      .map((line) => {
        let markup: string;
        if (line.startsWith("# ")) {
          markup = `<text x="56" y="${y}" fill="#777b82" font-family="${MONO}" font-size="36">#</text>${textLineMarkup(truncateDisplayText(line.slice(2), 38), 104, y, 58, { fill: "#f2f1ec", family: SANS, weight: 700, maxWidth: 1038 })}`;
          y += 78;
        } else if (line.startsWith("## ")) {
          y += 26;
          markup = `<text x="56" y="${y}" fill="#777b82" font-family="${MONO}" font-size="26">##</text>${textLineMarkup(truncateDisplayText(line.slice(3), 48), 110, y, 40, { fill: "#f2f1ec", family: SANS, weight: 700, maxWidth: 1032 })}`;
          y += 58;
        } else if (/^(?:•|-|\*)\s/u.test(line)) {
          markup = `<text x="56" y="${y}" fill="#8d929b" font-family="${SANS}" font-size="30">•</text>${textLineMarkup(truncateDisplayText(line.replace(/^(?:•|-|\*)\s+/u, ""), 68), 88, y, 30, { fill: "#b8bbc1", family: SANS, maxWidth: 1054 })}`;
          y += 48;
        } else {
          markup = textLineMarkup(truncateDisplayText(line, 72), 56, y, 30, {
            fill: "#b8bbc1",
            family: SANS,
            maxWidth: 1088,
          });
          y += 46;
        }
        return markup;
      })
      .join("");
    body = `${excerpt}<line x1="56" y1="456" x2="1144" y2="456" stroke="#30343a" stroke-width="2"/>${titleText(56, 530, 52, 34, 1)}${facts(56, 590)}${brand(1144, 588, "end")}`;
  } else if (model.kind === "code") {
    const excerpt = contentLines
      .map((line, index) => {
        const highlighted = /^\s*yield\b/u.test(line);
        return textLineMarkup(
          truncateDisplayText(line, 92),
          56,
          82 + index * 44,
          22,
          {
            fill: highlighted ? "#e7c47f" : index === 0 ? "#c7c9cd" : "#a7aaaf",
            family: MONO,
            preserveWhitespace: true,
          },
        );
      })
      .join("");
    body = `${excerpt}<line x1="56" y1="478" x2="1144" y2="478" stroke="#26292e"/>${titleText(56, twoLineTitle ? 518 : 540, 38, 42)}${facts(56, twoLineTitle ? 606 : 578)}${brand(1144, twoLineTitle ? 604 : 576, "end")}`;
  } else if (visual?.kind === "waveform") {
    const duration =
      model.preview?.facts.find((fact) => fact.includes(":")) ?? "";
    const sourceSamples = visual.samples.slice(0, 48);
    const minimumSample = Math.min(...sourceSamples);
    const maximumSample = Math.max(...sourceSamples);
    const sampleRange = maximumSample - minimumSample;
    const bars = sourceSamples
      .slice(0, 48)
      .map((sample, index) => {
        const normalized =
          sampleRange > 0.0001 ? (sample - minimumSample) / sampleRange : 0;
        const height = 64 + Math.round(normalized * 176);
        const x = 56 + index * (1088 / Math.max(visual.samples.length - 1, 1));
        return `<rect x="${x.toFixed(1)}" y="${260 - height / 2}" width="12" height="${height}" rx="6" fill="#8b919b"/>`;
      })
      .join("");
    body = `${brand()}<text x="1144" y="68" fill="#d8d3c8" font-family="${MONO}" font-size="30" text-anchor="end" letter-spacing="2">${escapeXml(duration)}</text>${bars}${titleText(56, twoLineTitle ? 454 : 526, 64, 30)}${facts()}`;
  } else if (model.kind === "audio" && raster) {
    const duration =
      model.preview?.facts.find((fact) => fact.includes(":")) ?? "";
    const audioTitleLines = layoutOgTitle(safeTitle, 18, 2);
    body = `<image href="${raster}" x="0" y="0" width="630" height="630" preserveAspectRatio="xMidYMid slice"/><rect x="630" y="0" width="570" height="630" fill="#0d0e10"/>${brand(686, 64)}<text x="686" y="388" fill="#d8d3c8" font-family="${SANS}" font-size="58" font-weight="400">${escapeXml(duration)}</text>${titleText(686, audioTitleLines.length > 1 ? 468 : 520, 46, 18)}${facts(686, 576)}`;
  } else if (visual?.kind === "svg-source") {
    const cells = [...visual.digest.slice(0, 32)]
      .map((nibble, index) => {
        const value = Number.parseInt(nibble, 16);
        const x = 56 + (index % 16) * 66;
        const y = 148 + Math.floor(index / 16) * 66;
        const lightness = 28 + value * 2.2;
        return `<rect x="${x}" y="${y}" width="54" height="54" rx="8" fill="hsl(${Math.round(28 + value * 13)},42%,${lightness.toFixed(1)}%)"/>`;
      })
      .join("");
    const digestLines = [
      visual.digest.slice(0, 32).toUpperCase(),
      visual.digest.slice(32).toUpperCase(),
    ]
      .map(
        (line, index) =>
          `<text x="56" y="${326 + index * 34}" fill="#9fa3a9" font-family="${MONO}" font-size="17" letter-spacing="1.5">${line}</text>`,
      )
      .join("");
    body = `${brand()}<text x="56" y="112" fill="#e3a44f" font-family="${MONO}" font-size="22" letter-spacing="4">SAFE SVG SOURCE SIGNATURE</text>${cells}${digestLines}${titleText(56, twoLineTitle ? 476 : 535, 52, 34)}${facts()}`;
  } else if (model.kind === "archive") {
    const stack = `<rect x="986" y="65" width="150" height="16" rx="3" fill="#33373c"/><rect x="1016" y="91" width="120" height="16" rx="3" fill="#3b3f45"/><rect x="1046" y="117" width="90" height="16" rx="3" fill="#44484f"/>`;
    const archiveTitleLines = layoutOgTitle(safeTitle, 42, 2);
    const entry =
      visual?.kind === "archive" && visual.entries[0]
        ? `<text x="56" y="315" fill="#777b82" font-family="${MONO}" font-size="20">${escapeXml(truncateDisplayText(visual.entries[0], 72))}</text>`
        : "";
    body = `${brand()}${stack}<text x="56" y="259" fill="#e3a44f" font-family="${MONO}" font-size="24" letter-spacing="4">${escapeXml(`${model.preview?.label ?? "Archive"} archive`.toUpperCase())}</text>${entry}${titleText(56, archiveTitleLines.length > 1 ? 458 : 522, 64, 42)}${facts(56, 576)}`;
  } else if (visual?.kind === "binary" && visual.hex) {
    const groups = visual.hex.split(" ");
    const midpoint = Math.ceil(groups.length / 2);
    const hexLines = [
      groups.slice(0, midpoint).join(" "),
      groups.slice(midpoint).join(" "),
    ].filter(Boolean);
    const hexMarkup = hexLines
      .map(
        (line, index) =>
          `<text x="56" y="${242 + index * 48}" fill="#c7c9cd" font-family="${MONO}" font-size="23" letter-spacing="1.2">${escapeXml(line)}</text>`,
      )
      .join("");
    body = `${brand()}<text x="56" y="168" fill="#e3a44f" font-family="${MONO}" font-size="22" letter-spacing="4">VERIFIED LEADING BYTES</text>${hexMarkup}${titleText(56, twoLineTitle ? 476 : 535, 52, 34)}${facts()}`;
  } else {
    const stack = `<rect x="1000" y="91" width="126" height="24" rx="3" fill="#33373c"/><rect x="1030" y="141" width="96" height="24" rx="3" fill="#2b2f34"/><rect x="1060" y="191" width="66" height="24" rx="3" fill="#3b3f45"/>`;
    body = `${brand()}${stack}${titleText(56, twoLineTitle ? 476 : 535, 52, 34)}${facts()}`;
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#090c0f" stop-opacity="0.04"/><stop offset="0.54" stop-color="#090c0f" stop-opacity="0.02"/><stop offset="1" stop-color="#090c0f" stop-opacity="0.96"/></linearGradient><linearGradient id="videoShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#080a0d" stop-opacity="0.08"/><stop offset="0.46" stop-color="#080a0d" stop-opacity="0.04"/><stop offset="0.72" stop-color="#080a0d" stop-opacity="0.72"/><stop offset="1" stop-color="#080a0d" stop-opacity="0.96"/></linearGradient><linearGradient id="pdfShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0e10" stop-opacity="0"/><stop offset="0.28" stop-color="#0d0e10" stop-opacity="0.82"/><stop offset="1" stop-color="#0d0e10" stop-opacity="1"/></linearGradient><linearGradient id="pageFade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0d0e10" stop-opacity="1"/><stop offset="1" stop-color="#0d0e10" stop-opacity="0"/></linearGradient></defs><rect width="1200" height="630" fill="#0d0e10"/>${body}</svg>`,
  );
}

interface RenderWorkerOptions {
  workerPath?: string;
  workerArguments?: readonly string[];
  timeoutMs?: number;
  allowSubprocesses?: boolean;
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const fontDirectory = path.resolve(process.cwd(), "runtime/fonts");
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    FONTCONFIG_FILE: path.join(fontDirectory, "fonts.conf"),
    FONTCONFIG_PATH: fontDirectory,
  };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "DYLD_LIBRARY_PATH",
    "LD_LIBRARY_PATH",
  ] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

export function getOgRenderPoolState(): { active: number; queued: number } {
  return ogRenderPool.state();
}

export async function renderSvgInWorker(
  svg: Buffer,
  options: RenderWorkerOptions = {},
): Promise<Buffer> {
  const totalTimeoutMs = options.timeoutMs ?? OG_RENDER_LIMITS.wallTimeoutMs;
  const deadline = Date.now() + totalTimeoutMs;
  try {
    await ogRenderPool.acquire(totalTimeoutMs);
  } catch (error) {
    throw new AppError(503, "preview_busy", "Preview rendering is busy", {
      cause: error,
    });
  }
  try {
    const cacheKey =
      options.workerPath === undefined &&
      options.workerArguments === undefined &&
      options.timeoutMs === undefined &&
      options.allowSubprocesses === undefined
        ? createHash("sha256").update(svg).digest("hex")
        : undefined;
    if (cacheKey) {
      const cached = cachedRender(cacheKey);
      if (cached) return cached;
    }
    const workerPath =
      options.workerPath ??
      path.resolve(process.cwd(), "runtime/og-render-worker.mjs");
    const output = await withNativeAdmission(
      Math.max(1, deadline - Date.now()),
      async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const result = await runKillableProcess(
              process.execPath,
              [
                ...(options.allowSubprocesses
                  ? []
                  : [
                      "--experimental-permission",
                      "--allow-addons",
                      `--allow-fs-read=${path.resolve(process.cwd(), "runtime")}`,
                      `--allow-fs-read=${path.resolve(process.cwd(), "node_modules")}`,
                      `--allow-fs-read=${realpathSync(path.dirname(workerPath))}`,
                      `--allow-fs-write=${realpathSync("/tmp")}/file-hosting-font-cache`,
                    ]),
                `--max-old-space-size=${OG_RENDER_LIMITS.maxOldSpaceMiB}`,
                workerPath,
                ...(options.workerArguments ?? []),
              ],
              {
                cwd: process.cwd(),
                env: workerEnvironment(),
                input: svg,
                maxOutputBytes: OG_RENDER_LIMITS.maxOutputBytes,
                timeoutMs: Math.max(1, deadline - Date.now()),
                allowSubprocesses: options.allowSubprocesses,
              },
            );
            return result.stdout;
          } catch (error) {
            if (
              !(error instanceof ProcessExecutionError) ||
              attempt > 0 ||
              deadline - Date.now() < 100
            )
              throw error;
          }
        }
        throw new ProcessExecutionError();
      },
    );
    if (cacheKey) cacheRender(cacheKey, output);
    return output;
  } finally {
    // Settlement retains the identity-safe supervisor until its owned group has
    // been signalled and inherited pipes have closed before releasing this slot.
    ogRenderPool.release();
  }
}

export async function renderOgImage(
  _service: FileService,
  _file: StoredFile,
  model: PublicUnfurlModel,
): Promise<Buffer> {
  return renderSvgInWorker(composeOgCardSvg(model));
}
