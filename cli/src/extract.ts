import { createReadStream } from "node:fs";
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

// Windows stores a relative symlink's substitute name with "\" separators
// even when the link was created with "/", so the host's readlink spelling of
// a scanner-accepted target differs only in separators. Fold them back to the
// canonical archive spelling before comparison. Off Windows a backslash is a
// literal name character (and the scanner rejects any target carrying one),
// so the value must not be rewritten there.
function canonicalLinkSpelling(target: string): string {
  return process.platform === "win32" ? target.replaceAll("\\", "/") : target;
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
    const raw = await readlink(staged).catch(() => null);
    const actual = raw === null ? null : canonicalLinkSpelling(raw);
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

// Failure-injection seams for the publish and extraction steps; production
// always uses the real fs operations and the real node-tar extractor.
export interface PublishHooks {
  publishRename?: (from: string, to: string) => Promise<void>;
  removeBackup?: (backupRoot: string) => Promise<void>;
  runExtract?: (options: {
    file: string;
    cwd: string;
    onwarn: (code: string, message: string) => void;
  }) => Promise<void>;
  // Test seam for a deterministic failure from the real streaming extractor.
  // Production never supplies it; keeping the ordinary Unpack path lets tests
  // exercise queued-write quiescence without platform-specific filesystem
  // limits or errno values.
  onExtractEntry?: (entryPath: string) => void;
}

function asExtractionFailure(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError(
    `Archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    EXIT.general,
    "EXTRACT_FAILED",
  );
}

// Bound on waiting for node-tar to finish materializing already-queued
// entries after its promise settles. An ordinary failure quiesces in
// milliseconds once the input stops; the bound only cuts off a wedged
// extractor whose close event will never fire.
const EXTRACTOR_QUIESCE_TIMEOUT_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait for the quiesce signal, giving up after the bound. The timer is
// cleared as soon as the signal fires so a finished extraction never holds
// the process (or a test run) open for the full bound.
async function boundedQuiesce(quiesced: Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, EXTRACTOR_QUIESCE_TIMEOUT_MS);
    void quiesced.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface ExtractionHandle {
  // Settles exactly the way `tar.extract`'s promise does: resolves on
  // complete success, rejects on the first error.
  result: Promise<void>;
  // Resolves once the extractor has stopped touching the filesystem. In
  // strict mode node-tar rejects on the first invalid entry while its Unpack
  // keeps materializing already-queued entries; removing the staging tree
  // while those writes are in flight races them. Never rejects.
  quiesced: Promise<void>;
}

// The real extraction, driven the way `tar.extract({ file })` drives it (a
// file read stream piped into a strict Unpack), but keeping a handle on the
// Unpack stream so a failure can be drained: once the extraction has failed,
// the source stops feeding the parser, and Unpack's `close` event — which
// fires only after parsing is done AND every pending filesystem operation
// has completed, with or without a preceding `error` — becomes the quiesce
// signal the cleanup needs.
function startRealExtraction(options: {
  file: string;
  cwd: string;
  onwarn: (code: string, message: string) => void;
  onentry?: (entryPath: string) => void;
}): ExtractionHandle {
  let markQuiesced: (() => void) | undefined;
  const quiesced = new Promise<void>((resolve) => {
    markQuiesced = resolve;
  });
  const result = new Promise<void>((resolve, reject) => {
    const unpack = new tar.Unpack({
      cwd: options.cwd,
      preservePaths: false,
      unlink: true,
      strict: true,
      onwarn: options.onwarn,
    });
    const source = createReadStream(options.file);
    let stopped = false;
    // Deferred: the error is emitted synchronously from inside the parser's
    // own consume loop, and ending the stream reentrantly there would write
    // into a parser that is still dispatching.
    const stopFeeding = () => {
      if (stopped) return;
      stopped = true;
      setImmediate(() => {
        source.unpipe(unpack);
        source.destroy();
        unpack.end();
      });
    };
    unpack.on("close", () => {
      markQuiesced?.();
      resolve();
    });
    unpack.on("error", (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
      stopFeeding();
    });
    if (options.onentry) {
      unpack.on("entry", (entry) => {
        try {
          options.onentry?.(entry.path);
        } catch (error) {
          unpack.emit(
            "error",
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    }
    source.on("error", (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
      stopFeeding();
    });
    source.pipe(unpack);
  });
  result.catch(() => {});
  return { result, quiesced };
}

// The failure-injection seam has no filesystem writer of its own: once its
// promise settles nothing remains in flight, and an injected never-settling
// fault is surfaced by the escape listeners, which already mark the
// extraction as quiesced.
function startHookedExtraction(run: () => Promise<void>): ExtractionHandle {
  // Wrapping in an async IIFE turns a synchronous throw into a rejection.
  const result = (async () => run())();
  result.catch(() => {});
  return {
    result,
    quiesced: result.then(
      () => undefined,
      () => undefined,
    ),
  };
}

// node-tar performs its filesystem work in raw fs callbacks. A fault raised
// there — `fs.lstat`/`fs.mkdir` throwing ERR_INVALID_ARG_VALUE for a path
// node-tar derived that contains a NUL byte, for instance — is thrown on the
// event loop, not into the promise the extraction returned. That promise then
// never settles, so awaiting it would abort the process with a raw stack
// trace, skip the caller's cleanup, and leave a `.<name>.fs-XXXXXX` staging
// directory beside the destination.
//
// Racing the extraction against listeners installed only for its duration
// turns any escaped fault back into an ordinary rejection, so the caller
// still removes the staging tree and the user still gets a truthful
// CliError. Before returning — thrown or not — the extractor is drained
// (bounded): node-tar keeps materializing already-queued entries after its
// promise settles, and the caller's cleanup must never race those writes. A
// fault that escaped to the process instead broke the extractor mid-callback
// — nothing further runs and its close event will never fire — so it counts
// as quiesced. The listeners stay installed until the extractor is quiet, so
// a fault raised by one of those late writes stays contained too, and are
// removed immediately afterwards, so no other command's failure mode or exit
// code is affected.
async function runContainedExtraction(
  start: () => ExtractionHandle,
): Promise<void> {
  let escape: ((error: unknown) => void) | undefined;
  const escaped = new Promise<never>((_, reject) => {
    escape = reject;
  });
  // Whichever side loses the race must not become an unhandled rejection.
  escaped.catch(() => {});
  let escapedFault = false;
  const onEscape = (error: unknown) => {
    escapedFault = true;
    escape?.(error);
  };
  process.on("uncaughtException", onEscape);
  process.on("unhandledRejection", onEscape);
  let handle: ExtractionHandle | undefined;
  try {
    handle = start();
    await Promise.race([handle.result, escaped]);
  } catch (error) {
    throw asExtractionFailure(error);
  } finally {
    try {
      if (handle !== undefined && !escapedFault) {
        await boundedQuiesce(handle.quiesced);
      }
    } finally {
      process.off("uncaughtException", onEscape);
      process.off("unhandledRejection", onEscape);
    }
  }
}

const STAGING_CLEANUP_ATTEMPTS = 5;
const STAGING_CLEANUP_RETRY_MS = 100;

// Verified, non-throwing removal of the staging root. The extractor has
// quiesced (bounded) before this runs, so a failure here is unexpected — but
// it must never replace the propagating primary error, so the outcome is
// returned instead of thrown, and removal only counts when the root is
// verifiably absent.
async function removeStagingRoot(stagingRoot: string): Promise<Error | null> {
  let lastFailure: Error | null = null;
  for (let attempt = 0; attempt < STAGING_CLEANUP_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(STAGING_CLEANUP_RETRY_MS);
    try {
      await rm(stagingRoot, { recursive: true, force: true });
      if (!(await exists(stagingRoot))) return null;
      lastFailure = new Error(`${stagingRoot} still exists after removal`);
    } catch (error) {
      lastFailure = error instanceof Error ? error : new Error(String(error));
    }
  }
  return lastFailure;
}

// A cleanup failure is secondary context: the primary error keeps its
// identity, code, and exit code, and the leftover staging path is appended
// so the user can remove it.
function withCleanupContext(
  error: unknown,
  stagingRoot: string,
  cleanupFailure: Error | null,
): unknown {
  if (cleanupFailure !== null && error instanceof Error) {
    error.message += ` (staging cleanup also failed: ${cleanupFailure.message}; remove ${stagingRoot} manually)`;
  }
  return error;
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
  const backups: string[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith(prefix)) continue;
    // mkdtemp appends exactly six alphanumeric characters. A shared prefix is
    // not ownership: only the CLI's generated spelling with its `previous`
    // payload is eligible for recovery or removal.
    const suffix = name.slice(prefix.length);
    if (!/^[A-Za-z0-9]{6}$/.test(suffix)) continue;
    if (!(await exists(join(parent, name, "previous")))) continue;
    backups.push(name);
  }
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
  let failure: { error: unknown } | null = null;
  try {
    // strict makes node-tar's warnings (skipped/invalid entries, zlib
    // trouble) reject the promise instead of silently resolving; onwarn is a
    // belt-and-braces collector so nothing downgraded to a warning can slip
    // through. Either path aborts before the destination is touched.
    const warnings: string[] = [];
    const onwarn = (code: string, message: string) =>
      warnings.push(`${code}: ${message}`);
    const runExtract = hooks.runExtract;
    await runContainedExtraction(() =>
      runExtract
        ? startHookedExtraction(() =>
            runExtract({ file: archivePath, cwd: staging, onwarn }),
          )
        : startRealExtraction({
            file: archivePath,
            cwd: staging,
            onwarn,
            onentry: hooks.onExtractEntry,
          }),
    );
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
  } catch (error) {
    failure = { error };
  }
  // The extractor has quiesced (bounded) by the time control reaches here —
  // `runContainedExtraction` drains it before returning — so this cleanup
  // cannot race queued writes, and it never throws, so it can never replace
  // the propagating error.
  const cleanupFailure = await removeStagingRoot(stagingRoot);
  if (failure !== null) {
    throw withCleanupContext(failure.error, stagingRoot, cleanupFailure);
  }
  if (cleanupFailure !== null) {
    throw new CliError(
      `Archive extraction staging cleanup failed: ${cleanupFailure.message} (remove ${stagingRoot} manually)`,
      EXIT.general,
      "EXTRACT_FAILED",
    );
  }
}
