import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rename,
  rm,
  stat,
} from "node:fs/promises";
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

// Filesystems fold case and Unicode normalization differently, so staging
// paths are compared under the same collision key the scanner uses.
function comparisonKey(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) => segment.normalize("NFC").toLowerCase())
    .join("/");
}

// Second line of defense behind the strict pre-scan: the staged tree must
// match the scan manifest EXACTLY. Every scanner-accepted entry must exist,
// and nothing the scanner never declared may exist — an extractor that
// interpreted the stream differently than the scanner must never publish.
export async function verifyExtractionCompleteness(
  root: string,
  entries: string[],
  links: readonly { path: string; target: string }[] = [],
): Promise<void> {
  // A published symlink's target is as much a destination as its path: the
  // scanner validated one exact string, so anything else in the staged tree
  // means the extractor read the stream differently.
  for (const link of links) {
    const staged = join(root, ...link.path.split("/"));
    const actual = await readlink(staged).catch(() => null);
    if (actual !== link.target) {
      throw new CliError(
        `Archive extraction produced an unexpected link target: ${link.path} -> ${actual ?? "(not a symlink)"}`,
        EXIT.general,
        "INCOMPLETE_EXTRACTION",
      );
    }
  }
  for (const entry of entries) {
    if (!(await exists(join(root, ...entry.split("/"))))) {
      throw new CliError(
        `Archive extraction is incomplete: ${entry} was not materialized`,
        EXIT.general,
        "INCOMPLETE_EXTRACTION",
      );
    }
  }
  const expected = new Set<string>();
  for (const entry of entries) {
    const segments = entry.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      // Declared entries and their implicit parent directories.
      expected.add(comparisonKey(segments.slice(0, index).join("/")));
    }
  }
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (!expected.has(comparisonKey(relative))) {
        throw new CliError(
          `Archive extraction produced an undeclared entry: ${relative}`,
          EXIT.general,
          "INCOMPLETE_EXTRACTION",
        );
      }
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative);
    }
  };
  await walk(root, "");
}

// Replacement backups live beside the destination as
// `.<name>.fs-backup-<unique>/previous`. The trailing dash keeps the prefix
// disjoint from the `.<name>.fs-<unique>` staging spelling.
const BACKUP_INFIX = ".fs-backup-";

// Failure-injection seams for the publish steps; production always uses the
// real fs operations.
export interface PublishHooks {
  publishRename?: (from: string, to: string) => Promise<void>;
  removeBackup?: (backupRoot: string) => Promise<void>;
}

// Detect and resolve backups a crashed prior invocation left behind: if the
// destination is missing, the backed-up destination is restored; either way
// the leftover backup directory is removed. Runs before the exists-check so
// a restored destination is treated like any other existing one.
async function recoverLeftoverBackups(
  parent: string,
  destination: string,
): Promise<void> {
  const prefix = `.${basename(destination)}${BACKUP_INFIX}`;
  let names: string[];
  try {
    names = await readdir(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const backups = names.filter((name) => name.startsWith(prefix)).sort();
  // Two backups can only coexist after two crashes or two concurrent runs
  // against this destination. There is no evidence for which one holds the
  // real previous content, so restoring one and deleting the other would
  // destroy data on a guess: refuse, keep both, and let the user decide.
  if (backups.length > 1) {
    throw new CliError(
      `Multiple leftover backups found beside ${destination} (${backups.join(", ")}); remove all but the correct one and retry`,
      EXIT.conflict,
      "AMBIGUOUS_BACKUP",
    );
  }
  for (const name of backups) {
    const backupRoot = join(parent, name);
    const previous = join(backupRoot, "previous");
    if (!(await exists(destination)) && (await exists(previous))) {
      await rename(previous, destination);
    }
    await rm(backupRoot, { recursive: true, force: true });
  }
}

export async function extractArchive(
  archivePath: string,
  outputPath: string,
  force: boolean,
  hooks: PublishHooks = {},
): Promise<void> {
  const destination = resolve(outputPath);
  const parent = dirname(destination);
  await recoverLeftoverBackups(parent, destination);
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
    await verifyExtractionCompleteness(
      staging,
      manifest.entries,
      manifest.links,
    );

    // Rollback-safe replacement: the old destination is moved to a unique
    // backup beside it, the staging tree is published, and only after a
    // successful publish is the backup removed. An ordinary publish failure
    // restores the old destination; a crash leaves a backup the next
    // invocation recovers.
    let backupRoot: string | null = null;
    if (await exists(destination)) {
      backupRoot = await mkdtemp(
        join(parent, `.${basename(destination)}${BACKUP_INFIX}`),
      );
      await rename(destination, join(backupRoot, "previous"));
    }
    try {
      if (hooks.publishRename) await hooks.publishRename(staging, destination);
      else await rename(staging, destination);
    } catch (error) {
      if (backupRoot) {
        await rename(join(backupRoot, "previous"), destination);
        await rm(backupRoot, { recursive: true, force: true });
      }
      throw error;
    }
    if (backupRoot) {
      if (hooks.removeBackup) await hooks.removeBackup(backupRoot);
      else await rm(backupRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
