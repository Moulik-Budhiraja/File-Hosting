import path from "node:path";

import { AppError } from "./errors";
import { runKillableProcess } from "./process-tree";
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
  return grapheme;
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

const SANS = "'Inter',sans-serif";
const MONO = "'JetBrains Mono',monospace";

function cardSvg(model: PublicUnfurlModel): Buffer {
  const safeTitle = sanitizePublicText(model.title, 300) || "File";
  const safeDescription = sanitizePublicText(model.description ?? "", 400);
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
    `<rect x="${anchor === "end" ? x - 196 : x}" y="${y - 12}" width="9" height="9" rx="2" fill="#e3a44f"/><text x="${anchor === "end" ? x - 176 : x + 20}" y="${y}" fill="#9fa3a9" font-family="${MONO}" font-size="20" font-weight="500" letter-spacing="2">files.moulik.dev</text>`;
  const titleText = (x: number, y: number, size = 52, width = 34) =>
    layoutOgTitle(safeTitle, width, 2)
      .map(
        (line, index) =>
          `<text x="${x}" y="${y + index * (size + 5)}" fill="#f2f1ec" font-family="${SANS}" font-size="${size}" font-weight="700" letter-spacing="-1.3" direction="auto" style="unicode-bidi:isolate">${escapeXml(line)}</text>`,
      )
      .join("");
  const facts = (x = 56, y = 580) =>
    `<text x="${x}" y="${y}" fill="#9fa3a9" font-family="${MONO}" font-size="21" letter-spacing="1.5">${escapeXml(safeDescription)}</text>`;
  const play = (x: number, y: number) =>
    `<circle cx="${x}" cy="${y}" r="31" fill="#0d0e10" fill-opacity="0.58" stroke="#9fa3a9" stroke-width="2"/><path d="M${x - 9} ${y - 13}l22 13-22 13z" fill="#f2f1ec"/>`;
  let body = "";

  if (model.kind === "image" && raster) {
    const portraitTitleLines = layoutOgTitle(safeTitle, 20, 2);
    body = portraitRaster
      ? `${brand()}<image href="${raster}" x="590" y="0" width="440" height="630" preserveAspectRatio="xMidYMid slice"/>${titleText(56, portraitTitleLines.length > 1 ? 462 : 522, 58, 20)}${facts(56, 575)}`
      : `<image href="${raster}" x="0" y="0" width="1200" height="630" preserveAspectRatio="xMidYMid slice"/><rect width="1200" height="630" fill="url(#shade)"/>${brand()}${titleText(56, twoLineTitle ? 480 : 526, 58, 30)}${facts()}`;
  } else if (model.kind === "video" && raster) {
    body = `<image href="${raster}" x="0" y="0" width="1200" height="336" preserveAspectRatio="xMidYMid slice"/><rect x="0" y="336" width="1200" height="294" fill="#0d0e10"/>${brand()}${titleText(56, twoLineTitle ? 468 : 528, 58, 34)}${facts(56, 575)}${play(1112, 542)}`;
  } else if (model.kind === "video") {
    const timeline = `<line x1="56" y1="320" x2="1143" y2="320" stroke="#30343a" stroke-width="2"/><path d="M56 310v20M193 314v12M329 310v20M465 314v12M601 310v20M737 314v12M873 310v20M1009 314v12M1143 310v20" stroke="#44484f" stroke-width="2"/>`;
    body = `${brand()}${play(84, 224)}${timeline}${titleText(56, twoLineTitle ? 466 : 526, 60, 40)}${facts(56, 575)}`;
  } else if (model.kind === "pdf") {
    const page = raster
      ? `<image href="${raster}" x="660" y="55" width="470" height="575" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="660" y="55" width="470" height="575" fill="#f6f5f1"/>${contentLines
          .slice(0, 6)
          .map(
            (line, index) =>
              `<text x="708" y="${130 + index * 54}" fill="#2a2e34" font-family="${SANS}" font-size="${index === 0 ? 28 : 20}" font-weight="${index === 0 ? 700 : 400}">${escapeXml(line.slice(0, 36))}</text>`,
          )
          .join("")}`;
    const pdfTitleLines = layoutOgTitle(safeTitle, 20, 2);
    body = `${brand()}${page}${titleText(56, pdfTitleLines.length > 1 ? 463 : 520, 52, 20)}${facts(56, 576)}`;
  } else if (model.kind === "document") {
    const documentHeading = layoutOgTitle(contentLines[0] ?? safeTitle, 26, 2)
      .map(
        (line, index) =>
          `<text x="312" y="${224 + index * 54}" fill="#202329" font-family="${SANS}" font-size="45" font-weight="700" letter-spacing="-1">${escapeXml(line)}</text>`,
      )
      .join("");
    const documentBody = contentLines
      .slice(1, 3)
      .map(
        (line, index) =>
          `<text x="312" y="${341 + index * 30}" fill="#63615d" font-family="${SANS}" font-size="20">${escapeXml(line.slice(0, 62))}</text>`,
      )
      .join("");
    const documentLabel = contentLines[0]
      ? `<text x="312" y="145" fill="#8b8983" font-family="${MONO}" font-size="17" letter-spacing="3">${escapeXml((model.preview?.label ?? "Document").toUpperCase())}</text>`
      : "";
    body = `<rect x="240" y="65" width="720" height="416" fill="#f4f2ed"/>${documentLabel}${documentHeading}${documentBody}<rect x="312" y="420" width="576" height="10" fill="#d0cec8"/><rect x="312" y="440" width="576" height="10" fill="#d0cec8"/><rect x="312" y="460" width="498" height="10" fill="#d0cec8"/><rect x="0" y="481" width="1200" height="149" fill="#0d0e10"/>${titleText(56, 553, 38, 42)}${facts(56, 591)}${brand(1144, 560, "end")}`;
  } else if (model.kind === "text") {
    const pageLines = contentLines
      .slice(0, 8)
      .map(
        (line, index) =>
          `<text x="708" y="${120 + index * 48}" fill="${index === 0 ? "#202329" : "#5e5f60"}" font-family="${SANS}" font-size="${index === 0 ? 28 : 19}" font-weight="${index === 0 ? 700 : 400}">${escapeXml(line.slice(0, 38))}</text>`,
      )
      .join("");
    body = `${brand()}<rect x="660" y="55" width="470" height="575" fill="#f6f5f1"/>${pageLines}${titleText(56, titleLines.length > 1 ? 430 : 480, 48, 20)}${facts(56, 576)}`;
  } else if (model.kind === "markdown") {
    let y = 102;
    const excerpt = contentLines
      .map((line) => {
        let markup: string;
        if (line.startsWith("# ")) {
          markup = `<text x="56" y="${y}" fill="#5e6269" font-family="${MONO}" font-size="30">#</text><text x="92" y="${y}" fill="#f2f1ec" font-family="${SANS}" font-size="45" font-weight="700">${escapeXml(line.slice(2, 58))}</text>`;
          y += 61;
        } else if (line.startsWith("## ")) {
          y += 33;
          markup = `<text x="56" y="${y}" fill="#5e6269" font-family="${MONO}" font-size="20">##</text><text x="96" y="${y}" fill="#f2f1ec" font-family="${SANS}" font-size="30" font-weight="700">${escapeXml(line.slice(3, 64))}</text>`;
          y += 52;
        } else if (/^(?:•|-|\*)\s/u.test(line)) {
          markup = `<text x="56" y="${y}" fill="#777b82" font-family="${SANS}" font-size="22">•</text><text x="79" y="${y}" fill="#a7aaaf" font-family="${SANS}" font-size="22">${escapeXml(line.replace(/^(?:•|-|\*)\s+/u, "").slice(0, 92))}</text>`;
          y += 38;
        } else {
          markup = `<text x="56" y="${y}" fill="#a7aaaf" font-family="${SANS}" font-size="22">${escapeXml(line.slice(0, 100))}</text>`;
          y += 34;
        }
        return markup;
      })
      .join("");
    body = `${excerpt}<line x1="56" y1="482" x2="1144" y2="482" stroke="#26292e"/>${titleText(56, twoLineTitle ? 518 : 540, 38, 42)}${facts(56, twoLineTitle ? 606 : 578)}${brand(1144, twoLineTitle ? 604 : 576, "end")}`;
  } else if (model.kind === "code") {
    const excerpt = contentLines
      .map((line, index) => {
        const highlighted = /^\s*yield\b/u.test(line);
        return `<text x="56" y="${82 + index * 44}" fill="${highlighted ? "#e7c47f" : index === 0 ? "#c7c9cd" : "#a7aaaf"}" font-family="${MONO}" font-size="22">${escapeXml(line.slice(0, 92))}</text>`;
      })
      .join("");
    body = `${excerpt}<line x1="56" y1="478" x2="1144" y2="478" stroke="#26292e"/>${titleText(56, twoLineTitle ? 518 : 540, 38, 42)}${facts(56, twoLineTitle ? 606 : 578)}${brand(1144, twoLineTitle ? 604 : 576, "end")}`;
  } else if (visual?.kind === "waveform") {
    const duration =
      model.preview?.facts.find((fact) => fact.includes(":")) ?? "";
    const bars = visual.samples
      .slice(0, 48)
      .map((sample, index) => {
        const height = Math.max(28, Math.round(sample * 190));
        const x = 56 + index * (1088 / Math.max(visual.samples.length - 1, 1));
        return `<rect x="${x.toFixed(1)}" y="${260 - height / 2}" width="10" height="${height}" rx="5" fill="#4a4e55"/>`;
      })
      .join("");
    body = `${brand()}<text x="1144" y="64" fill="#c9c4b8" font-family="${MONO}" font-size="25" text-anchor="end" letter-spacing="2">${escapeXml(duration)}</text>${bars}${titleText(56, twoLineTitle ? 478 : 529, 48, 38)}${facts()}`;
  } else if (model.kind === "audio" && raster) {
    const duration =
      model.preview?.facts.find((fact) => fact.includes(":")) ?? "";
    const audioTitleLines = layoutOgTitle(safeTitle, 18, 2);
    body = `<image href="${raster}" x="0" y="0" width="630" height="630" preserveAspectRatio="xMidYMid slice"/><rect x="630" y="0" width="570" height="630" fill="#0d0e10"/>${brand(686, 64)}<text x="686" y="388" fill="#d8d3c8" font-family="${SANS}" font-size="58" font-weight="400">${escapeXml(duration)}</text>${titleText(686, audioTitleLines.length > 1 ? 468 : 520, 46, 18)}${facts(686, 576)}`;
  } else if (model.kind === "archive") {
    const stack = `<rect x="986" y="65" width="150" height="16" rx="3" fill="#33373c"/><rect x="1016" y="91" width="120" height="16" rx="3" fill="#3b3f45"/><rect x="1046" y="117" width="90" height="16" rx="3" fill="#44484f"/>`;
    const archiveTitleLines = layoutOgTitle(safeTitle, 42, 2);
    body = `${brand()}${stack}<text x="56" y="259" fill="#e3a44f" font-family="${MONO}" font-size="24" letter-spacing="4">${escapeXml(`${model.preview?.label ?? "Archive"} archive`.toUpperCase())}</text>${titleText(56, archiveTitleLines.length > 1 ? 458 : 522, 64, 42)}${facts(56, 576)}`;
  } else {
    const stack = `<rect x="1000" y="91" width="126" height="24" rx="3" fill="#33373c"/><rect x="1030" y="141" width="96" height="24" rx="3" fill="#2b2f34"/><rect x="1060" y="191" width="66" height="24" rx="3" fill="#3b3f45"/>`;
    body = `${brand()}${stack}${titleText(56, twoLineTitle ? 476 : 535, 52, 34)}${facts()}`;
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#090c0f" stop-opacity="0.04"/><stop offset="0.54" stop-color="#090c0f" stop-opacity="0.02"/><stop offset="1" stop-color="#090c0f" stop-opacity="0.96"/></linearGradient></defs><rect width="1200" height="630" fill="#0d0e10"/>${body}</svg>`,
  );
}

interface RenderWorkerOptions {
  workerPath?: string;
  workerArguments?: readonly string[];
  timeoutMs?: number;
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
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
    const workerPath =
      options.workerPath ??
      path.resolve(process.cwd(), "runtime/og-render-worker.mjs");
    const result = await runKillableProcess(
      process.execPath,
      [
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
      },
    );
    return result.stdout;
  } finally {
    // runKillableProcess resolves/rejects only after close, so the process group has
    // been killed and the launcher reaped before admission is handed onward.
    ogRenderPool.release();
  }
}

export async function renderOgImage(
  _service: FileService,
  _file: StoredFile,
  model: PublicUnfurlModel,
): Promise<Buffer> {
  return renderSvgInWorker(cardSvg(model));
}
