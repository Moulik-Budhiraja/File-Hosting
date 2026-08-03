import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { runKillableProcess } from "./process-tree";
import {
  BoundedWorkerPool,
  deriveRasterPreviewInWorker,
  inspectRasterInWorker,
} from "./raster-worker";
import {
  sanitizeExcerptLine,
  sanitizeLocatorFreeText,
  sanitizePublicText,
} from "./text-safety";

export type PreviewFamily =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "document"
  | "markdown"
  | "text"
  | "code"
  | "archive"
  | "binary"
  | (string & {});

export interface RendererInput {
  trustedMime: string;
  name: string;
  size: number;
  sha256: string;
  sourcePath: string;
  /** Internal enqueue-to-completion deadline propagated to trusted strategies. */
  deadlineAt?: number;
}

export interface RendererProbe {
  rendererId: string;
  input: RendererInput;
  validated: Readonly<Record<string, unknown>>;
}

export type PreviewVisual =
  | { kind: "image" | "poster" | "page" | "artwork"; raster: Buffer }
  | { kind: "markdown" | "text" | "code"; lines: readonly string[] }
  | { kind: "waveform"; samples: readonly number[] }
  | { kind: "archive"; entries: readonly string[] }
  | { kind: "binary"; hex?: string };

export interface PreviewExtraction {
  family: PreviewFamily;
  label: string;
  title: string;
  facts: readonly string[];
  sourceDigest: string;
  visual: PreviewVisual;
}

export interface PreviewRenderer {
  readonly id: string;
  readonly priority: number;
  matches(input: RendererInput): boolean;
  probe(input: RendererInput): Promise<RendererProbe>;
  extract(probe: RendererProbe): Promise<PreviewExtraction>;
  renderMetadata(extraction: PreviewExtraction): PreviewExtraction;
}

interface RegisteredRenderer {
  renderer: PreviewRenderer;
  order: number;
}

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_ARCHIVE_ENTRIES = 12;
const MAX_ARCHIVE_SCAN_BYTES = 1024 * 1024;
const MAX_ARCHIVE_RATIO = 100;
export const PREVIEW_EXTRACTION_LIMITS = Object.freeze({
  maxConcurrent: 2,
  maxQueued: 16,
  queueTimeoutMs: 2_500,
  wallTimeoutMs: 2_500,
});
const previewExtractionPool = new BoundedWorkerPool(
  PREVIEW_EXTRACTION_LIMITS.maxConcurrent,
  PREVIEW_EXTRACTION_LIMITS.maxQueued,
  PREVIEW_EXTRACTION_LIMITS.queueTimeoutMs,
);

export class PreviewRendererRegistry {
  private readonly renderers: RegisteredRenderer[] = [];
  private nextOrder = 0;

  register(renderer: PreviewRenderer): this {
    if (
      this.renderers.some(({ renderer: current }) => current.id === renderer.id)
    ) {
      throw new Error(`duplicate renderer id: ${renderer.id}`);
    }
    if (!Number.isSafeInteger(renderer.priority)) {
      throw new Error(`renderer priority must be an integer: ${renderer.id}`);
    }
    this.renderers.push({ renderer, order: this.nextOrder++ });
    this.renderers.sort(
      (left, right) =>
        right.renderer.priority - left.renderer.priority ||
        left.order - right.order,
    );
    return this;
  }

  resolve(input: RendererInput): PreviewRenderer {
    const match = this.renderers.find(({ renderer }) =>
      renderer.matches(input),
    );
    if (!match) throw new Error(`no preview renderer for ${input.trustedMime}`);
    return match.renderer;
  }

  list(): readonly PreviewRenderer[] {
    return this.renderers.map(({ renderer }) => renderer);
  }
}

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
  const digits = Number.isInteger(value) ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

function safeTitle(input: RendererInput): string {
  return sanitizeLocatorFreeText(input.name, 300, "File") || "File";
}

async function readVerifiedSource(input: RendererInput): Promise<Buffer> {
  if (!Number.isSafeInteger(input.size) || input.size < 0) {
    throw new Error("invalid source size");
  }
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(input.sourcePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(input.size)) {
      throw new Error("source identity mismatch");
    }
    const previewLength = Math.min(input.size, MAX_READ_BYTES);
    const bytes = Buffer.alloc(previewLength);
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(
      Math.min(MAX_READ_BYTES, Math.max(1, input.size)),
    );
    const readLength = input.size;
    const deadline = Math.min(
      Date.now() + 1_500,
      input.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    let offset = 0;
    while (offset < readLength) {
      if (Date.now() > deadline)
        throw new Error("source read deadline exceeded");
      const wanted = Math.min(chunk.length, readLength - offset);
      const read = await handle.read(chunk, 0, wanted, offset);
      if (read.bytesRead === 0) throw new Error("source truncated during read");
      if (offset < previewLength) {
        chunk.copy(
          bytes,
          offset,
          0,
          Math.min(read.bytesRead, previewLength - offset),
        );
      }
      hash.update(chunk.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("source changed during read");
    }
    if (hash.digest("hex") !== input.sha256.toLowerCase()) {
      throw new Error("source checksum mismatch");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readFullVerifiedSource(
  input: RendererInput,
): Promise<Buffer | null> {
  if (input.size > MAX_SOURCE_BYTES) return null;
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(input.sourcePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(input.size))
      throw new Error("source identity mismatch");
    const output = Buffer.allocUnsafe(input.size);
    let offset = 0;
    const deadline = Math.min(
      Date.now() + 1_500,
      input.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    while (offset < output.length) {
      if (Date.now() > deadline)
        throw new Error("source read deadline exceeded");
      const { bytesRead } = await handle.read(
        output,
        offset,
        Math.min(64 * 1024, output.length - offset),
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== output.length) throw new Error("source changed during read");
    if (createHash("sha256").update(output).digest("hex") !== input.sha256)
      throw new Error("source checksum mismatch");
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("source changed during read");
    return output;
  } finally {
    await handle.close();
  }
}

async function withVerifiedSnapshot<T>(
  input: RendererInput,
  operation: (snapshotPath: string) => Promise<T>,
): Promise<T | null> {
  const source = await readFullVerifiedSource(input);
  if (!source) return null;
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "file-hosting-preview-"),
  );
  const snapshotPath = path.join(directory, "source");
  try {
    await writeFile(snapshotPath, source, { flag: "wx", mode: 0o600 });
    const result = await operation(snapshotPath);
    await readVerifiedSource(input);
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifiedProbe(
  id: string,
  input: RendererInput,
): Promise<RendererProbe> {
  const source = await readVerifiedSource(input);
  return { rendererId: id, input, validated: { source } };
}

function sourceFrom(probe: RendererProbe): Buffer {
  const source = probe.validated.source;
  if (!Buffer.isBuffer(source))
    throw new Error("renderer probe omitted verified source");
  return source;
}

function codeLabel(input: RendererInput): string {
  const extension = path.extname(input.name).slice(1).toUpperCase();
  const allowed = new Set([
    "TS",
    "TSX",
    "JS",
    "JSX",
    "JSON",
    "PY",
    "RB",
    "GO",
    "RS",
    "JAVA",
    "C",
    "CPP",
    "CSS",
    "HTML",
    "XML",
    "YAML",
    "YML",
    "TOML",
    "SH",
  ]);
  if (allowed.has(extension)) return extension;
  if (input.trustedMime === "application/json") return "JSON";
  return "SOURCE";
}

function archiveLabel(input: RendererInput): string {
  if (input.trustedMime === "application/zip") return "ZIP";
  if (input.trustedMime === "application/x-tar") return "TAR";
  if (
    input.trustedMime === "application/gzip" &&
    /(?:\.tar\.gz|\.tgz)$/iu.test(input.name)
  )
    return "TAR.GZ";
  if (input.trustedMime === "application/gzip") return "GZIP";
  return "ARCHIVE";
}

function documentLabel(input: RendererInput): string {
  if (
    input.trustedMime ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "DOCX";
  if (input.trustedMime === "application/msword") return "DOC";
  if (input.trustedMime === "application/rtf") return "RTF";
  return "DOCUMENT";
}

function baseExtraction(
  probe: RendererProbe,
  family: PreviewFamily,
  label: string,
  visual: PreviewVisual,
  facts: readonly string[] = [formatBytes(probe.input.size)],
): PreviewExtraction {
  return {
    family,
    label,
    title: safeTitle(probe.input),
    facts,
    sourceDigest: probe.input.sha256,
    visual,
  };
}

function boundedUtf8Lines(source: Buffer): string[] {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
    source.subarray(0, MAX_TEXT_BYTES),
  );
  return decoded
    .replaceAll("\0", "")
    .split(/\r?\n/u)
    .slice(0, 12)
    .map((line) => sanitizeExcerptLine(line, 320))
    .filter(Boolean);
}

function pdfLiteralText(source: Buffer): string[] {
  const prefix = source.subarray(0, MAX_TEXT_BYTES).toString("latin1");
  if (!prefix.startsWith("%PDF-") || !prefix.includes("%%EOF")) return [];
  const lines: string[] = [];
  for (const match of prefix.matchAll(
    /\(((?:\\.|[^()\\]){1,320})\)\s*Tj\b/gu,
  )) {
    const decoded = (match[1] ?? "")
      .replace(/\\([()\\])/gu, "$1")
      .replace(/\\[nrtbf]/gu, " ");
    const safe = sanitizeLocatorFreeText(decoded, 320);
    if (safe) lines.push(safe);
    if (lines.length >= 8) break;
  }
  return lines;
}

function wavWaveform(
  source: Buffer,
): { samples: number[]; duration: string } | null {
  if (
    source.length < 44 ||
    source.toString("ascii", 0, 4) !== "RIFF" ||
    source.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }
  let cursor = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (cursor + 8 <= source.length) {
    const id = source.toString("ascii", cursor, cursor + 4);
    const length = source.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    const end = start + length;
    if (end > source.length) return null;
    if (id === "fmt " && length >= 16) {
      if (source.readUInt16LE(start) !== 1) return null;
      channels = source.readUInt16LE(start + 2);
      sampleRate = source.readUInt32LE(start + 4);
      bits = source.readUInt16LE(start + 14);
    } else if (id === "data") {
      data = source.subarray(start, end);
    }
    cursor = end + (length % 2);
  }
  if (!data || channels < 1 || channels > 8 || sampleRate < 1 || bits !== 16)
    return null;
  const frameBytes = channels * 2;
  const frameCount = Math.floor(data.length / frameBytes);
  if (frameCount === 0) return null;
  const bins = Math.min(48, frameCount);
  const samples: number[] = [];
  for (let bin = 0; bin < bins; bin += 1) {
    const first = Math.floor((bin * frameCount) / bins);
    const last = Math.max(
      first + 1,
      Math.floor(((bin + 1) * frameCount) / bins),
    );
    let peak = 0;
    for (let frame = first; frame < last; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        peak = Math.max(
          peak,
          Math.abs(data.readInt16LE(frame * frameBytes + channel * 2)),
        );
      }
    }
    samples.push(Number((peak / 32768).toFixed(4)));
  }
  const seconds = Math.floor(frameCount / sampleRate);
  return {
    samples,
    duration: `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`,
  };
}

function zipEntries(source: Buffer): string[] {
  const entries: string[] = [];
  let offset = 0;
  let declaredBytes = 0;
  const scanLimit = Math.min(source.length, MAX_ARCHIVE_SCAN_BYTES);
  while (offset + 30 <= scanLimit && entries.length < MAX_ARCHIVE_ENTRIES) {
    if (source.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = source.readUInt16LE(offset + 6);
    const method = source.readUInt16LE(offset + 8);
    const compressedSize = source.readUInt32LE(offset + 18);
    const uncompressedSize = source.readUInt32LE(offset + 22);
    const nameLength = source.readUInt16LE(offset + 26);
    const extraLength = source.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const nextOffset = dataOffset + compressedSize;
    if (
      nameLength === 0 ||
      nameLength > 512 ||
      extraLength > 4096 ||
      nextOffset > scanLimit
    )
      break;
    const rawName = source
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString("utf8");
    const encrypted = (flags & 1) !== 0;
    const hasDescriptor = (flags & 8) !== 0;
    const supportedMethod = method === 0 || method === 8;
    const bounded =
      uncompressedSize <= 100 * 1024 * 1024 &&
      declaredBytes + uncompressedSize <= 250 * 1024 * 1024;
    const safePath =
      rawName.length > 0 &&
      !rawName.startsWith("/") &&
      !rawName.includes("\\") &&
      !rawName.split("/").includes("..");
    if (
      !encrypted &&
      !hasDescriptor &&
      supportedMethod &&
      bounded &&
      safePath
    ) {
      const safe = sanitizeLocatorFreeText(
        rawName.split("/").at(-1) ?? "",
        200,
      );
      if (safe) entries.push(safe);
      declaredBytes += uncompressedSize;
    }
    offset = nextOffset;
  }
  return entries;
}

function tarEntries(source: Buffer): string[] {
  if (source.length < 1024) return [];
  const entries: string[] = [];
  let offset = 0;
  const scanLimit = Math.min(source.length, MAX_ARCHIVE_SCAN_BYTES);
  while (offset + 512 <= scanLimit && entries.length < MAX_ARCHIVE_ENTRIES) {
    const header = source.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (header.toString("ascii", 257, 263) !== "ustar\0") return [];
    const expected = Number.parseInt(
      header.toString("ascii", 148, 156).trim(),
      8,
    );
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    let actual = 0;
    for (const byte of copy.values()) actual += byte;
    if (!Number.isFinite(expected) || expected !== actual) return [];
    const rawName = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0.*$/u, "");
    const size = Number.parseInt(
      header.toString("ascii", 124, 136).replace(/\0.*$/u, "").trim(),
      8,
    );
    if (!Number.isSafeInteger(size) || size < 0) return [];
    if (
      rawName &&
      !rawName.startsWith("/") &&
      !rawName.includes("\\") &&
      !rawName.split("/").includes("..")
    ) {
      const safe = sanitizePublicText(rawName, 200);
      if (safe) entries.push(safe);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function gzipTarEntries(source: Buffer, deadlineAt?: number): string[] {
  if (
    source.length < 18 ||
    source.length > MAX_READ_BYTES ||
    source[0] !== 0x1f ||
    source[1] !== 0x8b ||
    (deadlineAt !== undefined && Date.now() >= deadlineAt)
  ) {
    return [];
  }
  try {
    const decompressed = gunzipSync(source, {
      maxOutputLength: MAX_ARCHIVE_SCAN_BYTES,
    });
    if (
      decompressed.length > source.length * MAX_ARCHIVE_RATIO ||
      (deadlineAt !== undefined && Date.now() >= deadlineAt)
    ) {
      return [];
    }
    return tarEntries(decompressed);
  } catch {
    return [];
  }
}

export class PreviewBusyError extends Error {
  constructor() {
    super("preview extraction is busy");
    this.name = "PreviewBusyError";
  }
}

export function isPreviewBusy(error: unknown): boolean {
  return error instanceof PreviewBusyError;
}

export function getPreviewExtractionPoolState(): {
  active: number;
  queued: number;
} {
  return previewExtractionPool.state();
}

export class PreviewSourceUnavailableError extends Error {
  constructor() {
    super("preview source unavailable");
    this.name = "PreviewSourceUnavailableError";
  }
}

export function isPreviewSourceUnavailable(error: unknown): boolean {
  return error instanceof PreviewSourceUnavailableError;
}

const require = createRequire(import.meta.url);
const packagedFfmpeg = require("ffmpeg-static") as string | null;
const packagedFfprobe = (require("ffprobe-static") as { path?: unknown }).path;
const MEDIA_TIMEOUT_MS = 2_000;
const MEDIA_OUTPUT_LIMIT = 8 * 1024 * 1024;

function remainingExtractionMs(input: RendererInput): number {
  const remaining =
    (input.deadlineAt ?? Date.now() + MEDIA_TIMEOUT_MS) - Date.now();
  if (remaining <= 0) throw new Error("preview extraction deadline exceeded");
  return Math.max(1, Math.min(MEDIA_TIMEOUT_MS, remaining));
}

function mediaEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

async function documentExcerpt(input: RendererInput): Promise<string[]> {
  const source = await readFullVerifiedSource(input);
  if (!source) return [];
  try {
    const result = await runKillableProcess(
      process.execPath,
      [
        "--experimental-permission",
        "--allow-addons",
        `--allow-fs-read=${path.resolve(process.cwd(), "runtime")}`,
        `--allow-fs-read=${path.resolve(process.cwd(), "node_modules")}`,
        "--max-old-space-size=256",
        path.resolve(process.cwd(), "runtime/docx-text-worker.mjs"),
      ],
      {
        timeoutMs: remainingExtractionMs(input),
        maxOutputBytes: MAX_TEXT_BYTES,
        cwd: process.cwd(),
        env: mediaEnvironment(),
        input: source,
      },
    );
    await readVerifiedSource(input);
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) return [];
    const text = xml
      .replace(/<w:tab\s*\/?>/giu, "\t")
      .replace(/<w:br\s*\/?>/giu, "\n")
      .replace(/<\/w:p\s*>/giu, "\n")
      .replace(/<[^>]{0,1024}>/gu, "")
      .replace(/&#(x[0-9a-f]{1,6}|\d{1,7});/giu, (_, value: string) => {
        const code =
          value[0]?.toLowerCase() === "x"
            ? Number.parseInt(value.slice(1), 16)
            : Number.parseInt(value, 10);
        return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      })
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'");
    return boundedUtf8Lines(Buffer.from(text));
  } catch {
    return [];
  }
}

async function pdfFirstPage(input: RendererInput): Promise<Buffer | null> {
  const source = await readFullVerifiedSource(input);
  if (!source) return null;
  try {
    const result = await runKillableProcess(
      process.execPath,
      [
        "--experimental-permission",
        "--allow-addons",
        `--allow-fs-read=${path.resolve(process.cwd(), "runtime")}`,
        `--allow-fs-read=${path.resolve(process.cwd(), "node_modules")}`,
        "--max-old-space-size=256",
        path.resolve(process.cwd(), "runtime/pdf-page-worker.mjs"),
      ],
      {
        timeoutMs: remainingExtractionMs(input),
        maxOutputBytes: MEDIA_OUTPUT_LIMIT,
        cwd: process.cwd(),
        env: mediaEnvironment(),
        input: source,
      },
    );
    await readVerifiedSource(input);
    return result.stdout;
  } catch {
    return null;
  }
}

function durationLabel(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

async function probeMedia(
  input: RendererInput,
  sourcePath: string,
): Promise<{ duration: number; width?: number; height?: number }> {
  if (typeof packagedFfprobe !== "string" || !packagedFfprobe) {
    throw new Error("packaged ffprobe unavailable");
  }
  const result = await runKillableProcess(
    packagedFfprobe,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_entries",
      "format=duration:stream=codec_type,width,height",
      "-of",
      "json",
      sourcePath,
    ],
    {
      timeoutMs: remainingExtractionMs(input),
      maxOutputBytes: 256 * 1024,
      env: mediaEnvironment(),
    },
  );
  const parsed = JSON.parse(result.stdout.toString("utf8")) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration < 0 || duration > 24 * 60 * 60) {
    throw new Error("invalid media duration");
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  return {
    duration,
    ...(Number.isSafeInteger(video?.width) &&
    Number.isSafeInteger(video?.height)
      ? { width: video?.width, height: video?.height }
      : {}),
  };
}

async function videoPoster(
  input: RendererInput,
): Promise<{ raster: Buffer; duration: string } | null> {
  if (!packagedFfmpeg) return null;
  try {
    return await withVerifiedSnapshot(input, async (sourcePath) => {
      const metadata = await probeMedia(input, sourcePath);
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > 40_000_000
      )
        throw new Error("unsupported video geometry");
      const result = await runKillableProcess(
        packagedFfmpeg,
        [
          "-v",
          "error",
          "-nostdin",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          sourcePath,
          "-frames:v",
          "1",
          "-vf",
          "scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630",
          "-an",
          "-sn",
          "-dn",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ],
        {
          timeoutMs: remainingExtractionMs(input),
          maxOutputBytes: MEDIA_OUTPUT_LIMIT,
          env: mediaEnvironment(),
        },
      );
      return {
        raster: result.stdout,
        duration: durationLabel(metadata.duration),
      };
    });
  } catch {
    return null;
  }
}

async function audioArtwork(
  input: RendererInput,
): Promise<{ raster: Buffer; duration: string } | null> {
  if (!packagedFfmpeg) return null;
  try {
    return await withVerifiedSnapshot(input, async (sourcePath) => {
      const metadata = await probeMedia(input, sourcePath);
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > 40_000_000
      )
        throw new Error("artwork absent");
      const result = await runKillableProcess(
        packagedFfmpeg,
        [
          "-v",
          "error",
          "-nostdin",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          sourcePath,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          "scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630",
          "-an",
          "-sn",
          "-dn",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ],
        {
          timeoutMs: remainingExtractionMs(input),
          maxOutputBytes: MEDIA_OUTPUT_LIMIT,
          env: mediaEnvironment(),
        },
      );
      return {
        raster: result.stdout,
        duration: durationLabel(metadata.duration),
      };
    });
  } catch {
    return null;
  }
}

function pcmWaveform(source: Buffer): number[] {
  const frameCount = Math.floor(source.length / 2);
  if (frameCount < 1) return [];
  const bins = Math.min(48, frameCount);
  const samples: number[] = [];
  for (let bin = 0; bin < bins; bin += 1) {
    const first = Math.floor((bin * frameCount) / bins);
    const last = Math.max(
      first + 1,
      Math.floor(((bin + 1) * frameCount) / bins),
    );
    let peak = 0;
    for (let frame = first; frame < last; frame += 1) {
      peak = Math.max(peak, Math.abs(source.readInt16LE(frame * 2)));
    }
    samples.push(Number((peak / 32768).toFixed(4)));
  }
  return samples;
}

async function compressedAudioWaveform(
  input: RendererInput,
): Promise<{ samples: number[]; duration: string } | null> {
  if (!packagedFfmpeg) return null;
  try {
    return await withVerifiedSnapshot(input, async (sourcePath) => {
      const metadata = await probeMedia(input, sourcePath);
      const result = await runKillableProcess(
        packagedFfmpeg,
        [
          "-v",
          "error",
          "-nostdin",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          sourcePath,
          "-map",
          "0:a:0",
          "-t",
          "30",
          "-ac",
          "1",
          "-ar",
          "8000",
          "-f",
          "s16le",
          "-acodec",
          "pcm_s16le",
          "pipe:1",
        ],
        {
          timeoutMs: remainingExtractionMs(input),
          maxOutputBytes: MEDIA_OUTPUT_LIMIT,
          env: mediaEnvironment(),
        },
      );
      const samples = pcmWaveform(result.stdout);
      if (!samples.length) throw new Error("audio samples unavailable");
      return { samples, duration: durationLabel(metadata.duration) };
    });
  } catch {
    return null;
  }
}

function renderer(
  id: string,
  priority: number,
  family: PreviewFamily,
  matches: (input: RendererInput) => boolean,
  extract: (probe: RendererProbe) => Promise<PreviewExtraction>,
): PreviewRenderer {
  return {
    id,
    priority,
    matches,
    probe: (input) => verifiedProbe(id, input),
    extract,
    renderMetadata(extraction) {
      return extraction;
    },
  };
}

const DOCUMENT_MIMES = new Set([
  "application/msword",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const CODE_MIMES = new Set([
  "application/json",
  "application/toml",
  "application/xml",
  "application/yaml",
  "text/css",
  "text/html",
  "text/javascript",
  "text/x-python",
  "text/x-shellscript",
  "text/x-typescript",
]);
const ARCHIVE_MIMES = new Set([
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-bzip2",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/zip",
]);
const MARKDOWN_MIMES = new Set(["text/markdown", "text/x-markdown"]);
const RASTER_MIMES = new Map([
  ["image/jpeg", "JPG"],
  ["image/png", "PNG"],
  ["image/webp", "WebP"],
]);

export function createDefaultPreviewRendererRegistry(): PreviewRendererRegistry {
  return new PreviewRendererRegistry()
    .register(
      renderer(
        "markdown-exact",
        1050,
        "markdown",
        ({ trustedMime }) => MARKDOWN_MIMES.has(trustedMime),
        async (probe) => {
          let lines: string[] = [];
          try {
            lines = boundedUtf8Lines(sourceFrom(probe));
          } catch {
            /* truthful empty excerpt */
          }
          return baseExtraction(
            probe,
            "markdown",
            "MD",
            lines.length ? { kind: "markdown", lines } : { kind: "binary" },
          );
        },
      ),
    )
    .register(
      renderer(
        "pdf-exact",
        1050,
        "pdf",
        ({ trustedMime }) => trustedMime === "application/pdf",
        async (probe) => {
          const page = await pdfFirstPage(probe.input);
          if (page)
            return baseExtraction(probe, "pdf", "PDF", {
              kind: "page",
              raster: page,
            });
          const lines = pdfLiteralText(sourceFrom(probe));
          return baseExtraction(
            probe,
            "pdf",
            "PDF",
            lines.length ? { kind: "text", lines } : { kind: "binary" },
          );
        },
      ),
    )
    .register(
      renderer(
        "code-exact",
        1045,
        "code",
        ({ trustedMime }) => CODE_MIMES.has(trustedMime),
        async (probe) => {
          let lines: string[] = [];
          try {
            lines = boundedUtf8Lines(sourceFrom(probe));
          } catch {
            /* truthful fallback */
          }
          return baseExtraction(
            probe,
            "code",
            codeLabel(probe.input),
            lines.length ? { kind: "code", lines } : { kind: "binary" },
          );
        },
      ),
    )
    .register(
      renderer(
        "document-group",
        700,
        "document",
        ({ trustedMime }) => DOCUMENT_MIMES.has(trustedMime),
        async (probe) => {
          const lines =
            probe.input.trustedMime ===
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              ? await documentExcerpt(probe.input)
              : [];
          return baseExtraction(
            probe,
            "document",
            documentLabel(probe.input),
            lines.length ? { kind: "text", lines } : { kind: "binary" },
          );
        },
      ),
    )
    .register(
      renderer(
        "archive-exact",
        1040,
        "archive",
        ({ trustedMime }) => ARCHIVE_MIMES.has(trustedMime),
        async (probe) => {
          const source = sourceFrom(probe);
          const entries =
            probe.input.trustedMime === "application/zip"
              ? zipEntries(source)
              : probe.input.trustedMime === "application/x-tar"
                ? tarEntries(source)
                : probe.input.trustedMime === "application/gzip" &&
                    /(?:\.tar\.gz|\.tgz)$/iu.test(probe.input.name)
                  ? gzipTarEntries(source, probe.input.deadlineAt)
                  : [];
          const label = archiveLabel(probe.input);
          return baseExtraction(
            probe,
            "archive",
            label,
            entries.length ? { kind: "archive", entries } : { kind: "binary" },
            [formatBytes(probe.input.size)],
          );
        },
      ),
    )
    .register(
      renderer(
        "image-raster",
        800,
        "image",
        ({ trustedMime }) => trustedMime.startsWith("image/"),
        async (probe) => {
          const label = RASTER_MIMES.get(probe.input.trustedMime);
          if (!label)
            return baseExtraction(probe, "image", "IMAGE", { kind: "binary" });
          try {
            const derived = await withVerifiedSnapshot(
              probe.input,
              async (sourcePath) => {
                const dimensions = await inspectRasterInWorker(
                  sourcePath,
                  probe.input.trustedMime,
                  remainingExtractionMs(probe.input),
                );
                const raster = await deriveRasterPreviewInWorker(
                  sourcePath,
                  probe.input.trustedMime,
                  remainingExtractionMs(probe.input),
                );
                return { dimensions, raster };
              },
            );
            if (!derived)
              return baseExtraction(probe, "image", label, {
                kind: "binary",
              });
            return baseExtraction(
              probe,
              "image",
              label,
              { kind: "image", raster: derived.raster },
              [
                formatBytes(probe.input.size),
                `${derived.dimensions.width}×${derived.dimensions.height}`,
              ],
            );
          } catch {
            await readVerifiedSource(probe.input);
            return baseExtraction(probe, "image", label, { kind: "binary" });
          }
        },
      ),
    )
    .register(
      renderer(
        "video-family",
        790,
        "video",
        ({ trustedMime }) => trustedMime.startsWith("video/"),
        async (probe) => {
          const poster = await videoPoster(probe.input);
          return baseExtraction(
            probe,
            "video",
            probe.input.trustedMime === "video/quicktime" ? "QuickTime" : "MP4",
            poster
              ? { kind: "poster", raster: poster.raster }
              : { kind: "binary" },
            [
              formatBytes(probe.input.size),
              ...(poster ? [poster.duration] : []),
            ],
          );
        },
      ),
    )
    .register(
      renderer(
        "audio-family",
        780,
        "audio",
        ({ trustedMime }) => trustedMime.startsWith("audio/"),
        async (probe) => {
          const label =
            probe.input.trustedMime === "audio/mpeg"
              ? "MP3"
              : probe.input.trustedMime === "audio/flac"
                ? "FLAC"
                : "Audio";
          const artwork = await audioArtwork(probe.input);
          if (artwork) {
            return baseExtraction(
              probe,
              "audio",
              label,
              { kind: "artwork", raster: artwork.raster },
              [formatBytes(probe.input.size), artwork.duration],
            );
          }
          const wav = wavWaveform(sourceFrom(probe));
          const waveform = wav ?? (await compressedAudioWaveform(probe.input));
          return baseExtraction(
            probe,
            "audio",
            label,
            waveform
              ? { kind: "waveform", samples: waveform.samples }
              : { kind: "binary" },
            [
              formatBytes(probe.input.size),
              ...(waveform ? [waveform.duration] : []),
            ],
          );
        },
      ),
    )
    .register(
      renderer(
        "text-family",
        700,
        "text",
        ({ trustedMime }) => trustedMime.startsWith("text/"),
        async (probe) => {
          let lines: string[] = [];
          try {
            lines = boundedUtf8Lines(sourceFrom(probe));
          } catch {
            /* truthful fallback */
          }
          return baseExtraction(
            probe,
            "text",
            "TXT",
            lines.length ? { kind: "text", lines } : { kind: "binary" },
          );
        },
      ),
    )
    .register(
      renderer(
        "generic-binary",
        0,
        "binary",
        () => true,
        async (probe) => {
          const source = sourceFrom(probe);
          const hex = [...source.subarray(0, 24)]
            .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
            .join(" ");
          return baseExtraction(
            probe,
            "binary",
            "BIN",
            hex ? { kind: "binary", hex } : { kind: "binary" },
          );
        },
      ),
    );
}

export async function derivePreview(
  input: RendererInput,
  registry = createDefaultPreviewRendererRegistry(),
): Promise<PreviewExtraction> {
  const deadlineAt = Date.now() + PREVIEW_EXTRACTION_LIMITS.wallTimeoutMs;
  const deadlineInput: RendererInput = { ...input, deadlineAt };
  try {
    await previewExtractionPool.acquire(Math.max(1, deadlineAt - Date.now()));
  } catch {
    throw new PreviewBusyError();
  }

  let operationSettled = false;
  const operation = (async () => {
    await readVerifiedSource(deadlineInput);
    const renderer = registry.resolve(deadlineInput);
    const probe = await renderer.probe(deadlineInput);
    if (probe.rendererId !== renderer.id || probe.input !== deadlineInput) {
      throw new Error("renderer probe contract violated");
    }
    const extracted = await renderer.extract(probe);
    if (extracted.sourceDigest !== deadlineInput.sha256) {
      throw new Error("renderer source identity mismatch");
    }
    remainingExtractionMs(deadlineInput);
    await readVerifiedSource(deadlineInput);
    return renderer.renderMetadata(extracted);
  })().finally(() => {
    operationSettled = true;
  });

  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error("preview extraction deadline exceeded")),
      Math.max(1, deadlineAt - Date.now()),
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (isPreviewSourceUnavailable(error)) throw error;
    throw new PreviewSourceUnavailableError();
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (operationSettled) {
      previewExtractionPool.release();
    } else {
      void operation
        .finally(() => previewExtractionPool.release())
        .catch(() => undefined);
    }
  }
}
