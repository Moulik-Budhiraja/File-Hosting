// Strict structural pre-extraction scan for tar.gz archives. This mirrors the
// server's archive contract (server/src/server/files/archive-validation.ts):
// node-tar alone cannot enforce it — it accepts trailer-truncated archives and
// trailing garbage — so the CLI walks the raw blocks itself before a single
// byte is written to the destination. Equivalence with the server semantics is
// proven by mirrored test fixtures on both sides.
//
// The contract:
// - gzip must decode to end-of-input; concatenated members are one stream.
// - the tar stream must end with at least two consecutive 512-byte zero
//   records; after that marker only zero-valued padding (full or partial
//   final record) may follow — every non-zero trailing byte rejects.
// - entry paths and link targets are validated lexically and
//   platform-independently: POSIX-absolute, Windows drive-absolute and
//   drive-relative, UNC/device/extended forms, and `..` traversal all reject
//   on every host OS.
// - pax `size` overrides (local over global over header field) drive the
//   framing of the following ordinary entry; metadata records are framed by
//   their own header size. Malformed sizes reject; declared sizes feed the
//   entry/uncompressed budgets.
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

import { CliError, EXIT } from "./errors.js";

export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 100 * 1024 ** 3;
const MAX_ARCHIVE_RATIO = 2_048;
const ARCHIVE_RATIO_FLOOR = 64 * 1024;

export function enforceArchiveBudget(
  entryCount: number,
  uncompressedBytes: number,
  compressedBytes: number,
): void {
  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new CliError(
      `Archive exceeds the ${MAX_ARCHIVE_ENTRIES.toLocaleString("en-US")} entry safety limit`,
      EXIT.general,
      "UNSAFE_ARCHIVE",
    );
  }
  if (uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
    throw new CliError(
      "Archive declared uncompressed size exceeds the 100 GiB safety limit",
      EXIT.general,
      "UNSAFE_ARCHIVE",
    );
  }
  if (
    uncompressedBytes >
    MAX_ARCHIVE_RATIO * Math.max(compressedBytes, ARCHIVE_RATIO_FLOOR)
  ) {
    throw new CliError(
      "Archive declared uncompressed size exceeds the gzip safety ratio",
      EXIT.general,
      "UNSAFE_ARCHIVE",
    );
  }
}

const BLOCK = 512;
const METADATA_ENTRY_LIMIT = 1024 * 1024;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

function invalid(message: string): CliError {
  return new CliError(message, EXIT.general, "INVALID_ARCHIVE");
}

function unsafe(message: string): CliError {
  return new CliError(message, EXIT.general, "UNSAFE_ARCHIVE");
}

export function isUnsafeArchivePath(entryPath: string): boolean {
  const normalized = entryPath.replaceAll("\\", "/");
  if (normalized.startsWith("/")) return true;
  if (WINDOWS_DRIVE_PREFIX.test(normalized)) return true;
  return normalized.split("/").includes("..");
}

export function isUnsafeLinkTarget(
  entryPath: string,
  linkTarget: string,
): boolean {
  const normalizedTarget = linkTarget.replaceAll("\\", "/");
  if (normalizedTarget.startsWith("/")) return true;
  if (WINDOWS_DRIVE_PREFIX.test(normalizedTarget)) return true;
  const parent = entryPath.replaceAll("\\", "/").split("/").slice(0, -1);
  const segments = [...parent];
  for (const segment of normalizedTarget.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return true;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return false;
}

function parseNumeric(field: Buffer): number | null {
  if (field.length > 0 && (field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f;
    for (let index = 1; index < field.length; index += 1) {
      value = value * 256 + field[index]!;
    }
    return Number.isSafeInteger(value) ? value : null;
  }
  const text = field
    .toString("latin1")
    .replace(/\0[\s\S]*$/u, "")
    .trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : null;
}

function cString(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8");
}

function checksumMatches(block: Buffer): boolean {
  const stored = parseNumeric(block.subarray(148, 156));
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : block[index]!;
    unsigned += byte;
    signed += byte < 0x80 ? byte : byte - 256;
  }
  return stored === unsigned || stored === signed;
}

function parsePaxRecords(payload: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space <= offset) throw invalid("Archive has a malformed pax record");
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^\d+$/u.test(lengthText)) {
      throw invalid("Archive has a malformed pax record");
    }
    const length = Number(lengthText);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      end > payload.length ||
      end <= space + 2
    ) {
      throw invalid("Archive has a malformed pax record");
    }
    if (payload[end - 1] !== 0x0a) {
      throw invalid("Archive has a malformed pax record");
    }
    const body = payload.subarray(space + 1, end - 1);
    const equals = body.indexOf(0x3d);
    if (equals <= 0) throw invalid("Archive has a malformed pax record");
    const key = body.subarray(0, equals).toString("utf8");
    const value = body.subarray(equals + 1).toString("utf8");
    records.set(key, value);
    offset = end;
  }
  return records;
}

class TarScanWalker {
  private readonly header = Buffer.alloc(BLOCK);
  private headerFill = 0;
  private contentRemaining = 0;
  private paddingRemaining = 0;
  private zeroBlocks = 0;
  private done = false;
  private capture: Buffer[] | null = null;
  private captureKind:
    | "gnu-path"
    | "gnu-link"
    | "pax-next"
    | "pax-global"
    | null = null;
  private captured = 0;
  private overridePath: string | null = null;
  private overrideLink: string | null = null;
  private overrideSize: number | null = null;
  private globalPath: string | null = null;
  private globalLink: string | null = null;
  private globalSize: number | null = null;
  private entryCount = 0;
  private uncompressedBytes = 0;

  constructor(private readonly compressedBytes: number) {}

  push(data: Buffer): void {
    let offset = 0;
    while (offset < data.length) {
      if (this.done) {
        for (let index = offset; index < data.length; index += 1) {
          if (data[index] !== 0) {
            throw invalid(
              "Archive has data after the end-of-archive marker",
            );
          }
        }
        return;
      }
      if (this.contentRemaining > 0) {
        const take = Math.min(this.contentRemaining, data.length - offset);
        if (this.capture) {
          this.captured += take;
          if (this.captured > METADATA_ENTRY_LIMIT) {
            throw invalid("Archive metadata entry exceeds the 1 MiB limit");
          }
          this.capture.push(Buffer.from(data.subarray(offset, offset + take)));
        }
        this.contentRemaining -= take;
        offset += take;
        if (this.contentRemaining === 0) this.finishCapture();
        continue;
      }
      if (this.paddingRemaining > 0) {
        const take = Math.min(this.paddingRemaining, data.length - offset);
        this.paddingRemaining -= take;
        offset += take;
        continue;
      }
      const take = Math.min(BLOCK - this.headerFill, data.length - offset);
      data.copy(this.header, this.headerFill, offset, offset + take);
      this.headerFill += take;
      offset += take;
      if (this.headerFill === BLOCK) {
        this.headerFill = 0;
        this.consumeHeaderBlock(this.header);
      }
    }
  }

  finish(): void {
    if (!this.done) {
      throw invalid(
        this.headerFill > 0 ||
          this.contentRemaining > 0 ||
          this.paddingRemaining > 0
          ? "Archive tar stream is truncated mid-entry"
          : "Archive tar stream ended without an end-of-archive marker",
      );
    }
  }

  private consumeHeaderBlock(block: Buffer): void {
    const isZero = block.every((byte) => byte === 0);
    if (isZero) {
      this.zeroBlocks += 1;
      if (this.zeroBlocks === 2) this.done = true;
      return;
    }
    if (this.zeroBlocks === 1) {
      throw invalid("Archive has a lone zero block inside the tar body");
    }
    if (!checksumMatches(block)) {
      throw invalid("Archive tar header checksum mismatch — not a tar stream");
    }
    const size = parseNumeric(block.subarray(124, 136));
    if (size === null || size < 0) {
      throw invalid("Archive tar header has an invalid size field");
    }
    const typeByte = block[156] ?? 0;
    const type = String.fromCharCode(typeByte === 0 ? 0x30 : typeByte);
    const prefix = cString(block.subarray(345, 500));
    const headerPath = prefix
      ? `${prefix}/${cString(block.subarray(0, 100))}`
      : cString(block.subarray(0, 100));
    // Metadata records are always framed by their own header size; only an
    // ordinary entry's content honors a pending pax size override.
    let frameSize = size;

    if (type === "L" || type === "K" || type === "x" || type === "g") {
      this.capture = [];
      this.captured = 0;
      this.captureKind =
        type === "L"
          ? "gnu-path"
          : type === "K"
            ? "gnu-link"
            : type === "g"
              ? "pax-global"
              : "pax-next";
      if (size > METADATA_ENTRY_LIMIT) {
        throw invalid("Archive metadata entry exceeds the 1 MiB limit");
      }
    } else {
      if (!["0", "1", "2", "5"].includes(type)) {
        throw unsafe(`Unsupported archive entry type: ${JSON.stringify(type)}`);
      }
      frameSize = this.overrideSize ?? this.globalSize ?? size;
      const entryPath = this.overridePath ?? this.globalPath ?? headerPath;
      if (entryPath === "" || isUnsafeArchivePath(entryPath)) {
        throw unsafe(`Archive contains an unsafe path: ${entryPath}`);
      }
      const headerLink = cString(block.subarray(157, 257));
      const linkTarget = this.overrideLink ?? this.globalLink ?? headerLink;
      if (
        (type === "1" || type === "2") &&
        linkTarget &&
        isUnsafeLinkTarget(entryPath, linkTarget)
      ) {
        throw unsafe(`Archive contains an unsafe link: ${entryPath}`);
      }
      this.overridePath = null;
      this.overrideLink = null;
      this.overrideSize = null;
      this.entryCount += 1;
      this.uncompressedBytes += frameSize;
      enforceArchiveBudget(
        this.entryCount,
        this.uncompressedBytes,
        this.compressedBytes,
      );
    }

    const contentSize =
      type === "1" || type === "2" || type === "5" ? 0 : frameSize;
    this.contentRemaining = contentSize;
    this.paddingRemaining =
      contentSize % BLOCK === 0 ? 0 : BLOCK - (contentSize % BLOCK);
    if (contentSize === 0) this.finishCapture();
  }

  private finishCapture(): void {
    if (!this.capture) return;
    const payload = Buffer.concat(this.capture);
    const kind = this.captureKind;
    this.capture = null;
    this.captureKind = null;
    if (kind === "gnu-path") {
      this.overridePath = cString(payload);
    } else if (kind === "gnu-link") {
      this.overrideLink = cString(payload);
    } else if (kind === "pax-next" || kind === "pax-global") {
      const records = parsePaxRecords(payload);
      const path = records.get("path");
      const link = records.get("linkpath");
      const sizeText = records.get("size");
      const size = sizeText === undefined ? undefined : parsePaxSize(sizeText);
      if (kind === "pax-global") {
        if (path !== undefined) this.globalPath = path;
        if (link !== undefined) this.globalLink = link;
        if (size !== undefined) this.globalSize = size;
      } else {
        if (path !== undefined) this.overridePath = path;
        if (link !== undefined) this.overrideLink = link;
        if (size !== undefined) this.overrideSize = size;
      }
    }
  }
}

// A pax size must be plain decimal digits; well-formed values beyond the
// safe-integer range fail the declared-size budget truthfully rather than a
// framing claim.
function parsePaxSize(text: string): number {
  if (!/^\d+$/u.test(text)) {
    throw invalid("Archive has a malformed pax size record");
  }
  const value = BigInt(text);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CliError(
      "Archive declared uncompressed size exceeds the 100 GiB safety limit",
      EXIT.general,
      "UNSAFE_ARCHIVE",
    );
  }
  return Number(value);
}

// Scan the archive file's raw bytes against the strict contract. Resolves
// only when the whole gzip stream decodes and the tar structure is complete
// and safe; throws CliError otherwise. Nothing is extracted and memory stays
// O(1) — decompressed content is discarded after header inspection.
export async function scanTarGzArchive(
  archivePath: string,
  compressedBytes: number,
): Promise<void> {
  const walker = new TarScanWalker(compressedBytes);
  const gunzip = createGunzip();
  const source = createReadStream(archivePath);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      source.destroy();
      gunzip.destroy();
      reject(
        error instanceof CliError
          ? error
          : invalid(
              `Archive is not a valid gzip stream (${
                error instanceof Error ? error.message : String(error)
              })`,
            ),
      );
    };
    gunzip.on("data", (chunk: Buffer) => {
      try {
        walker.push(chunk);
      } catch (error) {
        fail(error);
      }
    });
    gunzip.on("error", fail);
    source.on("error", fail);
    gunzip.on("end", () => {
      if (settled) return;
      try {
        walker.finish();
        settled = true;
        resolve();
      } catch (error) {
        fail(error);
      }
    });
    source.pipe(gunzip);
  });
}
