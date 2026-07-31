import { lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as tar from "tar";
import { CliError, EXIT } from "./errors.js";
import { scanTarGzArchive } from "./tar-scan.js";

export {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  enforceArchiveBudget,
} from "./tar-scan.js";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function throwIfExtractionWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  throw new CliError(
    `Archive extraction reported warnings: ${warnings.join("; ")}`,
    EXIT.general,
    "EXTRACT_FAILED",
  );
}

// Second line of defense behind the strict pre-scan: every scanner-accepted
// entry must actually exist in the staged tree before the destination is
// published. A skipped entry (for any reason node-tar might choose) would
// otherwise become a silently incomplete "successful" extraction.
export async function verifyExtractionCompleteness(
  root: string,
  entries: string[],
): Promise<void> {
  for (const entry of entries) {
    if (!(await exists(join(root, ...entry.split("/"))))) {
      throw new CliError(
        `Archive extraction is incomplete: ${entry} was not materialized`,
        EXIT.general,
        "INCOMPLETE_EXTRACTION",
      );
    }
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

  // Server metadata is not trusted: the archive's raw bytes are scanned
  // against the strict structural contract (complete gzip, strict tar
  // end-of-archive marker, platform-independent path/link safety, pax-aware
  // framing and budgets) before a single byte is written. node-tar alone
  // cannot enforce trailer completeness or trailing-data rejection.
  const compressedBytes = (await stat(archivePath)).size;
  const manifest = await scanTarGzArchive(archivePath, compressedBytes);

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(
    join(parent, `.${basename(destination)}.fs-`),
  );
  const staging = join(stagingRoot, "content");
  await mkdir(staging);
  try {
    // strict makes node-tar's warnings (skipped/invalid entries, zlib
    // trouble) reject the promise instead of silently resolving; onwarn is a
    // belt-and-braces collector so nothing downgraded to a warning can slip
    // through. Either path aborts before the destination is touched.
    const warnings: string[] = [];
    await tar.extract({
      file: archivePath,
      cwd: staging,
      preservePaths: false,
      unlink: true,
      strict: true,
      onwarn: (code, message) => warnings.push(`${code}: ${message}`),
    });
    throwIfExtractionWarnings(warnings);
    await verifyExtractionCompleteness(staging, manifest.entries);
    if (force) await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
