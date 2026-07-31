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
  await scanTarGzArchive(archivePath, compressedBytes);

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
