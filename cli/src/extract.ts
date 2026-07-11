import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import * as tar from "tar";
import { CliError, EXIT } from "./errors.js";

function unsafePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return isAbsolute(normalized) || normalized.split("/").includes("..") || posix.normalize(normalized).startsWith("../");
}

function unsafeLink(entryPath: string, linkPath: string): boolean {
  if (isAbsolute(linkPath)) return true;
  const target = posix.normalize(posix.join(posix.dirname(entryPath), linkPath));
  return target === ".." || target.startsWith("../");
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

export async function extractArchive(archivePath: string, outputPath: string, force: boolean): Promise<void> {
  const destination = resolve(outputPath);
  if ((await exists(destination)) && !force) {
    throw new CliError(`Destination already exists: ${outputPath} (use --force to replace it)`, EXIT.conflict, "OUTPUT_EXISTS");
  }

  await tar.list({
    file: archivePath,
    onentry(entry) {
      if (unsafePath(entry.path)) {
        throw new CliError(`Archive contains an unsafe path: ${entry.path}`, EXIT.general, "UNSAFE_ARCHIVE");
      }
      if ((entry.type === "SymbolicLink" || entry.type === "Link") && entry.linkpath && unsafeLink(entry.path, entry.linkpath)) {
        throw new CliError(`Archive contains an unsafe link: ${entry.path}`, EXIT.general, "UNSAFE_ARCHIVE");
      }
    },
  });

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(join(parent, `.${basename(destination)}.fs-`));
  const staging = join(stagingRoot, "content");
  await mkdir(staging);
  try {
    await tar.extract({ file: archivePath, cwd: staging, preservePaths: false, unlink: true });
    if (force) await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
