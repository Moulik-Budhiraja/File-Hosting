// Streaming structural validation for uploads marked archive=tar.gz. The
// stored object is the original compressed bytes; validation only proves the
// contract (gzip stream containing a complete, safe tar) before any
// metadata/object commit. Nothing is extracted to the filesystem; content is
// discarded after header inspection, so memory is O(entries) for the path
// index that hardlink-target validation needs, never O(content).
//
// A hand-rolled header walker is used instead of node-tar's parser because
// node-tar (strict mode) accepts archives whose end-of-archive trailer is
// missing — i.e. it cannot reject trailer-truncated archives, which this
// contract requires.
import { createGunzip, type Gunzip } from "node:zlib";

import { AppError } from "./errors";

const BLOCK = 512;
// Metadata entries (pax headers, GNU long names) legitimately carry small
// path payloads; anything larger is hostile or corrupt.
const METADATA_ENTRY_LIMIT = 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100_000;
// Decompression-bomb guard: output may not exceed maxRatio × input (with a
// small floor so tiny archives are never false-rejected). gzip/DEFLATE tops
// out near 1030:1, so 2048 never rejects a legitimate archive.
const DEFAULT_MAX_RATIO = 2048;
const RATIO_INPUT_FLOOR = 64 * 1024;

function invalid(message: string): AppError {
  return new AppError(400, "invalid_archive", message);
}

function parseNumeric(field: Buffer): number | null {
  // GNU base-256 encoding for large values.
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

// Platform-independent lexical safety: the archive contract must hold on
// every consumer OS, so Windows spellings reject even on POSIX hosts. After
// backslash normalization a leading "/" covers POSIX-absolute, UNC
// (\\server\share), device (\\.\) and extended (\\?\) forms; a single-letter
// drive prefix covers both drive-absolute (C:/x, C:\x) and drive-relative
// (C:x) forms.
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

// Portable per-segment policy: a segment must denote the same ordinary
// file on every consumer OS. Windows reserves DOS device basenames (even
// with extensions, and with the superscript-digit spellings it recognizes),
// treats `:` as an alternate-data-stream separator, strips trailing dots and
// spaces, and forbids control characters — so all of these reject on every
// host.
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
// root-relative path — `.` and empty segments dropped, matching how the
// shipped extractor normalizes paths — or null when the target is absolute,
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

function isUnsafeLinkTarget(entryPath: string, linkTarget: string): boolean {
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

function parsePaxRecords(payload: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space <= offset) throw invalid("malformed pax metadata record");
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^\d+$/u.test(lengthText)) {
      throw invalid("malformed pax metadata record");
    }
    const length = Number(lengthText);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      end > payload.length ||
      end <= space + 2
    ) {
      throw invalid("malformed pax metadata record");
    }
    if (payload[end - 1] !== 0x0a) {
      throw invalid("malformed pax metadata record");
    }
    const body = payload.subarray(space + 1, end - 1);
    const equals = body.indexOf(0x3d);
    if (equals <= 0) throw invalid("malformed pax metadata record");
    const key = body.subarray(0, equals).toString("utf8");
    const value = body.subarray(equals + 1).toString("utf8");
    records.set(key, value);
    offset = end;
  }
  return records;
}

// Incremental tar block walker. push() throws AppError(400, invalid_archive)
// as soon as a structural violation is provable; finish() proves the archive
// ended exactly at a complete end-of-archive marker.
class TarWalker {
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
  private entrySeen = false;
  private entryCount = 0;
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
    const key = TarWalker.collisionKey(spelling);
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
    throw invalid("archive contains conflicting entry paths");
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

  // Largest decompressed size a single entry may declare. Derived from the
  // configured upload maximum × the gzip ratio ceiling; Infinity when no
  // maximum is configured.
  constructor(
    private readonly maxEntryBytes = Infinity,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  push(data: Buffer): void {
    let offset = 0;
    while (offset < data.length) {
      if (this.done) {
        // Strict termination: once the end-of-archive marker (two zero
        // records) is reached, only zero-valued padding may follow — full
        // records, or a partial final record cut by end-of-stream. Every
        // non-zero trailing byte rejects, block-aligned or not.
        for (let index = offset; index < data.length; index += 1) {
          if (data[index] !== 0) {
            throw invalid("data found after the end-of-archive marker");
          }
        }
        return;
      }
      if (this.contentRemaining > 0) {
        const take = Math.min(this.contentRemaining, data.length - offset);
        if (this.capture) {
          this.captured += take;
          if (this.captured > METADATA_ENTRY_LIMIT) {
            throw invalid("metadata entry exceeds the 1 MiB limit");
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
            throw invalid("archive entry padding contains non-zero bytes");
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
          ? "tar stream is truncated mid-entry"
          : "tar stream ended without an end-of-archive marker",
      );
    }
    if (!this.entrySeen && this.zeroBlocks >= 2) {
      // An empty archive (trailer only) is well-formed; nothing else to prove.
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
      throw invalid("lone zero block inside the archive body");
    }
    if (!checksumMatches(block)) {
      throw invalid("tar header checksum mismatch — not a tar archive");
    }
    const size = parseNumeric(block.subarray(124, 136));
    if (size === null || size < 0) {
      throw invalid("tar header has an invalid size field");
    }
    const typeByte = block[156] ?? 0;
    const type = String.fromCharCode(typeByte === 0 ? 0x30 : typeByte);
    const prefix = cString(block.subarray(345, 500));
    const headerPath = prefix
      ? `${prefix}/${cString(block.subarray(0, 100))}`
      : cString(block.subarray(0, 100));
    // Metadata records are always framed by their own header size; only an
    // ordinary entry's content honors a pending pax size override (the pax
    // spelling for members beyond the 8 GiB octal header limit).
    let frameSize = size;

    if (type === "L" || type === "K" || type === "x" || type === "g") {
      // Metadata entry — its payload can override the next entry's path or
      // link target, so it must be captured (bounded) and checked too.
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
        throw invalid("metadata entry exceeds the 1 MiB limit");
      }
    } else {
      if (!["0", "1", "2", "5"].includes(type)) {
        throw invalid(`unsupported archive entry type ${JSON.stringify(type)}`);
      }
      this.entrySeen = true;
      this.entryCount += 1;
      if (this.entryCount > this.maxEntries) {
        throw invalid(
          `archive exceeds the ${this.maxEntries.toLocaleString("en-US")} entry safety limit`,
        );
      }
      frameSize = this.overrideSize ?? this.globalSize ?? size;
      const entryPath = this.overridePath ?? this.globalPath ?? headerPath;
      if (entryPath === "" || isUnsafeArchivePath(entryPath)) {
        throw invalid("archive contains an unsafe entry path");
      }
      const headerLink = cString(block.subarray(157, 257));
      const linkTarget = this.overrideLink ?? this.globalLink ?? headerLink;
      if (type === "1") {
        // Hardlink targets resolve from the archive root, never from the
        // containing entry; any `..` component (or absolute/device form)
        // therefore rejects outright, and the target must already be
        // declared as a materializable regular file so the extractor is
        // guaranteed to produce it.
        const target = linkTarget ? normalizeRootRelative(linkTarget) : null;
        if (
          target === null ||
          target === "" ||
          target.split("/").some(isUnsafePortableSegment)
        ) {
          throw invalid("archive contains an unsafe link target");
        }
        if (!this.materializable.has(target)) {
          throw invalid(
            "archive hardlink target is not an already-declared regular file",
          );
        }
      } else if (
        type === "2" &&
        linkTarget &&
        isUnsafeLinkTarget(entryPath, linkTarget)
      ) {
        throw invalid("archive contains an unsafe link target");
      }
      const trailingSeparator = entryPath.replaceAll("\\", "/").endsWith("/");
      if (
        trailingSeparator &&
        type !== "5" &&
        !(type === "0" && frameSize === 0)
      ) {
        throw invalid("archive contains an unsafe entry path");
      }
      const normalizedPath = normalizeEntryPath(entryPath) ?? "";
      // Pre-ustar tars spell directories as regular entries with a trailing
      // slash; the shipped extractor coerces those to directories, so the
      // manifest must agree.
      const isDir = type === "5" || trailingSeparator;
      if (normalizedPath === "") {
        // Only the archive root itself ("./" or ".") may normalize to
        // nothing, and only as a directory.
        if (!isDir) throw invalid("archive contains an unsafe entry path");
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
        if (!isDir && (type === "0" || type === "1")) {
          this.materializable.add(normalizedPath);
        }
      }
      this.overridePath = null;
      this.overrideLink = null;
      this.overrideSize = null;
    }

    if (frameSize > this.maxEntryBytes) {
      throw invalid(
        "archive entry size exceeds the configured archive size limit",
      );
    }
    // Link and directory entries carry no content regardless of size field
    // quirks; everything else advances by the padded content size.
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
      const size =
        sizeText === undefined ? undefined : this.parsePaxSize(sizeText);
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

  // A pax size must be plain decimal digits. BigInt parsing distinguishes a
  // malformed value from one that is well-formed but beyond the safe-integer
  // range or the configured decompressed ceiling — the latter two get an
  // explicit size-limit reason, never a misleading framing/checksum claim.
  private parsePaxSize(text: string): number {
    if (!/^\d+$/u.test(text)) {
      throw invalid("malformed pax size record");
    }
    const value = BigInt(text);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalid(
        "archive entry size exceeds the configured archive size limit",
      );
    }
    const resolved = Number(value);
    if (resolved > this.maxEntryBytes) {
      throw invalid(
        "archive entry size exceeds the configured archive size limit",
      );
    }
    return resolved;
  }
}

export class TarGzArchiveValidator {
  private readonly gunzip: Gunzip;
  private readonly walker: TarWalker;
  private readonly maxRatio: number;
  private compressedBytes = 0;
  private decompressedBytes = 0;
  private failure: AppError | null = null;

  constructor(
    options: {
      maxRatio?: number;
      maxUploadBytes?: number;
      maxEntries?: number;
    } = {},
  ) {
    this.maxRatio = options.maxRatio ?? DEFAULT_MAX_RATIO;
    // With a configured upload maximum, no entry can decompress beyond
    // maxRatio × that maximum — declared sizes above it are impossible and
    // reject with an explicit size-limit reason before framing goes wrong.
    this.walker = new TarWalker(
      options.maxUploadBytes && options.maxUploadBytes > 0
        ? options.maxUploadBytes * this.maxRatio
        : Infinity,
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    );
    this.gunzip = createGunzip();
    this.gunzip.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      this.decompressedBytes += chunk.length;
      if (
        this.decompressedBytes >
        this.maxRatio * Math.max(this.compressedBytes, RATIO_INPUT_FLOOR)
      ) {
        this.fail(
          invalid("decompressed size exceeds the safety ratio for gzip"),
        );
        return;
      }
      try {
        this.walker.push(chunk);
      } catch (error) {
        this.fail(
          error instanceof AppError
            ? error
            : invalid("tar stream could not be parsed"),
        );
      }
    });
    this.gunzip.on("error", (error) => {
      this.fail(invalid(`not a valid gzip stream (${error.message})`));
    });
  }

  private fail(error: AppError): void {
    if (this.failure) return;
    this.failure = error;
    this.gunzip.destroy();
  }

  // Feed original (compressed) upload bytes. Throws the recorded failure
  // early so the caller stops paying for a stream that can never validate.
  async update(chunk: Buffer): Promise<void> {
    const early = this.failure;
    if (early) throw early;
    this.compressedBytes += chunk.length;
    const writable = this.gunzip.write(chunk);
    const failed = this.failure;
    if (failed) throw failed;
    if (!writable) {
      await new Promise<void>((resolve) => {
        const settle = () => {
          this.gunzip.off("drain", settle);
          this.gunzip.off("close", settle);
          resolve();
        };
        this.gunzip.once("drain", settle);
        this.gunzip.once("close", settle);
      });
    }
  }

  async finish(): Promise<void> {
    if (!this.failure) {
      await new Promise<void>((resolve) => {
        const settle = () => {
          this.gunzip.off("end", settle);
          this.gunzip.off("close", settle);
          this.gunzip.off("error", settle);
          resolve();
        };
        this.gunzip.once("end", settle);
        this.gunzip.once("close", settle);
        this.gunzip.once("error", settle);
        this.gunzip.end();
      });
    }
    if (this.failure) throw this.failure;
    this.walker.finish();
  }

  // Release zlib resources when the upload fails for unrelated reasons.
  abort(): void {
    this.gunzip.destroy();
  }
}
