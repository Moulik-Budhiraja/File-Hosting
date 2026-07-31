import { lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import * as tar from "tar";
import { CliError, EXIT } from "./errors.js";

function unsafePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    isAbsolute(normalized) ||
    normalized.split("/").includes("..") ||
    posix.normalize(normalized).startsWith("../")
  );
}

function unsafeLink(entryPath: string, linkPath: string): boolean {
  const normalizedEntry = entryPath.replaceAll("\\", "/");
  const normalizedLink = linkPath.replaceAll("\\", "/");
  if (isAbsolute(normalizedLink) || /^[A-Za-z]:\//u.test(normalizedLink))
    return true;
  const target = posix.normalize(
    posix.join(posix.dirname(normalizedEntry), normalizedLink),
  );
  return target === ".." || target.startsWith("../");
}

export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 100 * 1024 ** 3;
const MAX_ARCHIVE_RATIO = 2_048;
const ARCHIVE_RATIO_FLOOR = 64 * 1024;
const SAFE_ENTRY_TYPES = new Set([
  "File",
  "OldFile",
  "Directory",
  "SymbolicLink",
  "Link",
]);

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

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function extractArchive(
  archivePath: string,
  outputPath: string,
  force: boolean,
): Promise<void> {
  const destination = resolve(outputPath);
  if ((await exists(destination)) && !force) {
    throw new CliError(
      `Destination already exists: ${outputPath} (use --force to replace it)`,
      EXIT.conflict,
      "OUTPUT_EXISTS",
    );
  }

  // Server metadata is not trusted: the archive is scanned locally before a
  // single byte is written. A violation is recorded rather than thrown —
  // throwing inside tar's onentry event handler escapes the promise chain as
  // an uncaught exception instead of a clean CLI failure.
  let violation: CliError | null = null;
  const compressedBytes = (await stat(archivePath)).size;
  let entryCount = 0;
  let uncompressedBytes = 0;
  try {
    await tar.list({
      file: archivePath,
      // Validation must see the original names. Extraction below still uses
      // preservePaths:false as a second line of defence.
      preservePaths: true,
      onentry(entry) {
        if (violation) return;
        entryCount += 1;
        uncompressedBytes += entry.size;
        try {
          enforceArchiveBudget(entryCount, uncompressedBytes, compressedBytes);
        } catch (error) {
          violation = error as CliError;
          return;
        }
        if (!SAFE_ENTRY_TYPES.has(entry.type)) {
          violation = new CliError(
            `Unsupported archive entry type: ${entry.type}`,
            EXIT.general,
            "UNSAFE_ARCHIVE",
          );
        } else if (unsafePath(entry.path)) {
          violation = new CliError(
            `Archive contains an unsafe path: ${entry.path}`,
            EXIT.general,
            "UNSAFE_ARCHIVE",
          );
        } else if (
          (entry.type === "SymbolicLink" || entry.type === "Link") &&
          entry.linkpath &&
          unsafeLink(entry.path, entry.linkpath)
        ) {
          violation = new CliError(
            `Archive contains an unsafe link: ${entry.path}`,
            EXIT.general,
            "UNSAFE_ARCHIVE",
          );
        }
      },
    });
  } catch (error) {
    if (violation) throw violation;
    throw error;
  }
  if (violation) throw violation;

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(
    join(parent, `.${basename(destination)}.fs-`),
  );
  const staging = join(stagingRoot, "content");
  await mkdir(staging);
  try {
    await tar.extract({
      file: archivePath,
      cwd: staging,
      preservePaths: false,
      unlink: true,
    });
    if (force) await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
