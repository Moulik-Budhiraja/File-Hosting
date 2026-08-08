import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

export const FILE_ID_PATTERN = /^[0-9A-Za-z]{7}$/u;

function assertSegment(segment: string): void {
  if (!/^(?!\.{1,2}$)[.0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(segment))
    throw new Error("unsafe storage namespace segment");
}

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export async function ensureSafeDirectory(
  storageRoot: string,
  segments: string[],
): Promise<string> {
  for (const segment of segments) assertSegment(segment);
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(storageRoot);
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    try {
      const details = await lstat(next);
      if (!details.isDirectory() || details.isSymbolicLink())
        throw new Error("unsafe storage namespace component");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(next, { mode: 0o700 });
      const details = await lstat(next);
      if (!details.isDirectory() || details.isSymbolicLink())
        throw new Error("unsafe storage namespace component");
    }
    current = await realpath(next);
    if (!isContained(root, current))
      throw new Error("storage namespace escaped root");
  }
  return current;
}

export async function openSafeStoredFile(
  storageRoot: string,
  storageKey: string,
): Promise<FileHandle> {
  if (path.isAbsolute(storageKey))
    throw new Error("absolute storage key rejected");
  const segments = storageKey.split("/");
  if (segments.length < 2 || segments.some((segment) => !segment))
    throw new Error("invalid storage key");
  for (const segment of segments) assertSegment(segment);
  const root = await realpath(storageRoot);
  const parent = await realpath(path.join(root, ...segments.slice(0, -1)));
  if (!isContained(root, parent)) throw new Error("storage key escaped root");
  const filename = path.join(parent, segments.at(-1)!);
  const details = await lstat(filename);
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("stored object is not a regular file");
  return open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
}

export async function removeSafeTree(
  storageRoot: string,
  segments: string[],
): Promise<void> {
  for (const segment of segments) assertSegment(segment);
  const root = await realpath(storageRoot);
  const target = path.join(root, ...segments);
  try {
    const details = await lstat(target);
    if (details.isSymbolicLink()) throw new Error("refusing symlink cleanup");
    const resolved = await realpath(target);
    if (!isContained(root, resolved)) throw new Error("cleanup escaped root");
    await rm(resolved, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function removeSafeFile(
  root: string,
  storageKey: string,
): Promise<void> {
  const segments = storageKey.split("/");
  const filename = segments.pop();
  if (!filename) throw new Error("invalid storage key");
  assertSegment(filename);
  const parent = await ensureSafeDirectory(root, segments);
  await unlink(path.join(parent, filename)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
}
