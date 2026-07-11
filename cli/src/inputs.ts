import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { glob, hasMagic } from "glob";
import * as tar from "tar";
import { CliError, EXIT } from "./errors.js";

export interface PreparedInput {
  original: string;
  localPath: string;
  name: string;
  logicalSize: number;
  uploadSize: number;
  archive: "tar.gz" | null;
  open(): Readable;
}

export interface PreparedInputs {
  inputs: PreparedInput[];
  logicalSize: number;
  cleanup(): Promise<void>;
}

async function pathLogicalSize(path: string): Promise<number> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) return entry.size;
  if (!entry.isDirectory()) return entry.size;
  let total = 0;
  for (const child of await readdir(path)) total += await pathLogicalSize(join(path, child));
  return total;
}

async function expandOne(value: string): Promise<string[]> {
  if (!hasMagic(value)) {
    try {
      await lstat(value);
      return [resolve(value)];
    } catch {
      throw new CliError(`Input does not exist: ${value}`, EXIT.usage, "INPUT_NOT_FOUND");
    }
  }

  const matches = await glob(value, {
    absolute: true,
    dot: false,
    follow: false,
    nodir: false,
  });
  if (matches.length === 0) {
    throw new CliError(`Pattern did not match any files: ${value}`, EXIT.usage, "UNMATCHED_GLOB");
  }
  return matches.sort();
}

async function spoolStdin(stdin: NodeJS.ReadableStream, destination: string): Promise<number> {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(stdin as Readable, counter, createWriteStream(destination, { flags: "wx" }));
  return size;
}

export async function prepareInputs(
  values: string[],
  options: { recursive: boolean; name?: string },
  stdin: NodeJS.ReadableStream,
): Promise<PreparedInputs> {
  if (values.length === 0) {
    throw new CliError("Upload requires at least one file, directory, glob, or '-'", EXIT.usage, "MISSING_INPUT");
  }
  if (values.filter((value) => value === "-").length > 1) {
    throw new CliError("Standard input may only be specified once", EXIT.usage, "DUPLICATE_STDIN");
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "fs-cli-"));
  try {
    const expanded: Array<{ original: string; path: string | null }> = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (value === "-") {
        expanded.push({ original: value, path: null });
        continue;
      }
      for (const match of await expandOne(value)) {
        const normalized = resolve(match);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          expanded.push({ original: value, path: normalized });
        }
      }
    }

    if (options.name && expanded.length !== 1) {
      throw new CliError("--name can only be used when uploading one object", EXIT.usage, "AMBIGUOUS_NAME");
    }
    if (expanded.some((item) => item.path === null) && !options.name) {
      throw new CliError("Uploading from stdin requires --name", EXIT.usage, "MISSING_NAME");
    }
    if (
      options.name &&
      (!options.name.trim() || options.name === "." || options.name === ".." ||
        Buffer.byteLength(options.name, "utf8") > 255 || /[\\/\u0000-\u001f\u007f]/u.test(options.name))
    ) {
      throw new CliError(
        "--name must be 1-255 UTF-8 bytes without path separators or control characters",
        EXIT.usage,
        "INVALID_NAME",
      );
    }

    const inputs: PreparedInput[] = [];
    for (const [index, item] of expanded.entries()) {
      if (item.path === null) {
        const path = join(tempRoot, `stdin-${index}`);
        const size = await spoolStdin(stdin, path);
        inputs.push({
          original: "-",
          localPath: path,
          name: options.name!,
          logicalSize: size,
          uploadSize: size,
          archive: null,
          open: () => createReadStream(path),
        });
        continue;
      }

      const path = item.path;
      const entry = await lstat(path);
      if (entry.isDirectory()) {
        if (!options.recursive) {
          throw new CliError(
            `${item.original} matched a directory; rerun with -r/--recursive to archive it`,
            EXIT.usage,
            "DIRECTORY_REQUIRES_RECURSIVE",
          );
        }
        const archivePath = join(tempRoot, `archive-${index}.tar.gz`);
        const logicalSize = await pathLogicalSize(path);
        await tar.create(
          { cwd: path, file: archivePath, gzip: true, portable: true, follow: false },
          ["."],
        );
        const archived = await stat(archivePath);
        inputs.push({
          original: item.original,
          localPath: archivePath,
          name: options.name ?? `${basename(path)}.tar.gz`,
          logicalSize,
          uploadSize: archived.size,
          archive: "tar.gz",
          open: () => createReadStream(archivePath),
        });
        continue;
      }

      const followed = await stat(path);
      inputs.push({
        original: item.original,
        localPath: path,
        name: options.name ?? basename(path),
        logicalSize: followed.size,
        uploadSize: followed.size,
        archive: null,
        open: () => createReadStream(path),
      });
    }

    return {
      inputs,
      logicalSize: inputs.reduce((sum, input) => sum + input.logicalSize, 0),
      cleanup: () => rm(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
