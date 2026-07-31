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

// Portable per-segment policy, mirroring the server: a segment must denote
// the same ordinary file on every consumer OS. Windows reserves DOS device
// basenames (even with extensions, and the superscript-digit spellings it
// recognizes), treats `:` as an alternate-data-stream separator, strips
// trailing dots and spaces, and forbids control characters — so all of
// these reject on every host.
const RESERVED_DEVICE_BASENAMES =
  /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function isUnsafePortableSegment(segment: string): boolean {
  if (segment.includes(":")) return true;
  if (CONTROL_CHARS.test(segment)) return true;
  if (segment.endsWith(".") || segment.endsWith(" ")) return true;
  const base = segment.split(".", 1)[0]!.replace(/[. ]+$/u, "");
  return RESERVED_DEVICE_BASENAMES.test(base);
}

function normalizeEntryPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/")) return null;
  if (WINDOWS_DRIVE_PREFIX.test(normalized)) return null;
  const segments = normalized.split("/");
  // Preserve compatibility with the conventional tar `./name` prefix and
  // directory trailing slash, but reject empty/dot segments everywhere else.
  if (segments[0] === ".") segments.shift();
  if (segments.at(-1) === "") segments.pop();
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return segments.join("/");
}

export function isUnsafeArchivePath(entryPath: string): boolean {
  const normalized = normalizeEntryPath(entryPath);
  if (normalized === null) return true;
  return normalized.split("/").filter(Boolean).some(isUnsafePortableSegment);
}

// Tar hardlink linknames are archive-root-relative (unlike symlinks, which
// resolve from the entry's parent directory). Returns the normalized
// root-relative path — `.` and empty segments dropped, matching how
// node-tar normalizes paths — or null when the target is absolute,
// drive/device-formed, or contains any `..` component.
function normalizeRootRelative(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/")) return null;
  if (WINDOWS_DRIVE_PREFIX.test(normalized)) return null;
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return segments.join("/");
}

export function isUnsafeLinkTarget(
  entryPath: string,
  linkTarget: string,
): boolean {
  const normalizedTarget = linkTarget.replaceAll("\\", "/");
  if (normalizedTarget.startsWith("/")) return true;
  if (WINDOWS_DRIVE_PREFIX.test(normalizedTarget)) return true;
  const normalizedEntry = normalizeEntryPath(entryPath);
  if (normalizedEntry === null) return true;
  const parent =
    normalizedEntry === "" ? [] : normalizedEntry.split("/").slice(0, -1);
  const segments = [...parent];
  for (const segment of normalizedTarget.split("/")) {
    if (segment === "" || segment === ".") return true;
    if (segment === "..") {
      if (segments.length === 0) return true;
      segments.pop();
    } else {
      // `..`/`.` are traversal syntax judged by containment above; every
      // named segment must additionally be portable on its own.
      if (isUnsafePortableSegment(segment)) return true;
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
    "gnu-path" | "gnu-link" | "pax-next" | "pax-global" | null = null;
  private captured = 0;
  private overridePath: string | null = null;
  private overrideLink: string | null = null;
  private overrideSize: number | null = null;
  private globalPath: string | null = null;
  private globalLink: string | null = null;
  private globalSize: number | null = null;
  private entryCount = 0;
  private uncompressedBytes = 0;
  // Normalized root-relative paths a hardlink may legally target: regular
  // files and previously accepted hardlinks (which chain back to one).
  // Backward-only references make cycles impossible by construction.
  private readonly materializable = new Set<string>();
  // Destination manifest keyed by the collision key (NFC + lowercase per
  // segment): paths that alias under Windows/macOS case or Unicode
  // normalization rules would extract nondeterministically across
  // platforms, so any conflicting claim rejects deterministically here.
  private readonly manifest = new Map<
    string,
    { kind: "file" | "hardlink" | "symlink" | "dir"; spelling: string }
  >();
  // Every accepted entry path, in order — extraction verifies each one
  // materialized before the destination is published.
  readonly expectedPaths: string[] = [];

  constructor(private readonly compressedBytes: number) {}

  private static collisionKey(normalizedPath: string): string {
    return normalizedPath
      .split("/")
      .map((segment) => segment.normalize("NFC").toLowerCase())
      .join("/");
  }

  private claimPath(
    spelling: string,
    kind: "file" | "hardlink" | "symlink" | "dir",
  ): void {
    const key = TarScanWalker.collisionKey(spelling);
    const existing = this.manifest.get(key);
    if (!existing) {
      this.manifest.set(key, { kind, spelling });
      return;
    }
    // Only an identically spelled directory redeclaration is idempotent
    // (implicit parents, or explicit dir entries before/after children).
    if (
      existing.kind === "dir" &&
      kind === "dir" &&
      existing.spelling === spelling
    ) {
      return;
    }
    throw unsafe(`Archive contains conflicting entry paths: ${spelling}`);
  }

  private recordEntry(
    normalizedPath: string,
    kind: "file" | "hardlink" | "symlink" | "dir",
  ): void {
    const segments = normalizedPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      this.claimPath(segments.slice(0, index).join("/"), "dir");
    }
    this.claimPath(normalizedPath, kind);
  }

  push(data: Buffer): void {
    let offset = 0;
    while (offset < data.length) {
      if (this.done) {
        for (let index = offset; index < data.length; index += 1) {
          if (data[index] !== 0) {
            throw invalid("Archive has data after the end-of-archive marker");
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
        // Tar specifies unused record bytes as NUL-filled; non-zero bytes
        // hidden in content padding are not verifiable structure.
        for (let index = offset; index < offset + take; index += 1) {
          if (data[index] !== 0) {
            throw invalid("Archive entry padding contains non-zero bytes");
          }
        }
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
      if (type === "1") {
        // Hardlink targets resolve from the archive root, never from the
        // containing entry; any `..` component (or absolute/device form)
        // rejects outright, and the target must already be declared as a
        // materializable regular file so extraction is provably complete.
        const target = linkTarget ? normalizeRootRelative(linkTarget) : null;
        if (
          target === null ||
          target === "" ||
          target.split("/").some(isUnsafePortableSegment)
        ) {
          throw unsafe(`Archive contains an unsafe link: ${entryPath}`);
        }
        if (!this.materializable.has(target)) {
          throw unsafe(
            `Archive hardlink target is not an already-declared regular file: ${entryPath}`,
          );
        }
      } else if (
        type === "2" &&
        linkTarget &&
        isUnsafeLinkTarget(entryPath, linkTarget)
      ) {
        throw unsafe(`Archive contains an unsafe link: ${entryPath}`);
      }
      const trailingSeparator = entryPath.replaceAll("\\", "/").endsWith("/");
      if (
        trailingSeparator &&
        type !== "5" &&
        !(type === "0" && frameSize === 0)
      ) {
        throw unsafe(`Archive contains an unsafe path: ${entryPath}`);
      }
      const normalizedPath = normalizeEntryPath(entryPath) ?? "";
      // Pre-ustar tars spell directories as regular entries with a trailing
      // slash; node-tar coerces those to directories, so the manifest must
      // agree.
      const isDir = type === "5" || trailingSeparator;
      if (normalizedPath === "") {
        // Only the archive root itself ("./" or ".") may normalize to
        // nothing, and only as a directory.
        if (!isDir)
          throw unsafe(`Archive contains an unsafe path: ${entryPath}`);
      } else {
        this.recordEntry(
          normalizedPath,
          isDir
            ? "dir"
            : type === "1"
              ? "hardlink"
              : type === "2"
                ? "symlink"
                : "file",
        );
        this.expectedPaths.push(normalizedPath);
        if (!isDir && (type === "0" || type === "1")) {
          this.materializable.add(normalizedPath);
        }
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

export interface ArchiveScanManifest {
  // Normalized root-relative paths of every accepted entry, in archive
  // order; extraction must materialize each one before publishing.
  entries: string[];
}

// Scan the archive file's raw bytes against the strict contract. Resolves
// with the accepted-entry manifest only when the whole gzip stream decodes
// and the tar structure is complete and safe; throws CliError otherwise.
// Nothing is extracted; decompressed content is discarded after header
// inspection, so memory is O(entries), never O(content).
export async function scanTarGzArchive(
  archivePath: string,
  compressedBytes: number,
): Promise<ArchiveScanManifest> {
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
  return { entries: walker.expectedPaths };
}
