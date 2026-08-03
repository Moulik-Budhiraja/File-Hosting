import path from "node:path";

import { runKillableProcess } from "./process-tree";

export const RASTER_WORKER_LIMITS = Object.freeze({
  maxConcurrent: 2,
  maxQueued: 16,
  maxOldSpaceMiB: 256,
  maxOutputBytes: 8 * 1024 * 1024,
  queueTimeoutMs: 2_500,
  wallTimeoutMs: 2_500,
});

const WORKER_PROGRAM = String.raw`
import { readFile, stat } from "node:fs/promises";
import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const [mode, filePath, mimeType] = process.argv.slice(1);
const expectedFormats = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

try {
  const expectedFormat = expectedFormats[mimeType];
  if (!expectedFormat || !filePath) throw new Error("unsupported raster source");
  const sourceStat = await stat(filePath);
  if (!sourceStat.isFile() || sourceStat.size > MAX_SOURCE_BYTES) {
    throw new Error("raster source exceeds byte limit");
  }
  const source = await readFile(filePath);
  if (source.length !== sourceStat.size || source.length > MAX_SOURCE_BYTES) {
    throw new Error("raster source changed during read");
  }
  const require = createRequire(import.meta.url);
  const sharpPath = require.resolve("sharp");
  const sharp = (await import(pathToFileURL(sharpPath).href)).default;
  const inputOptions = {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
    pages: 1,
    sequentialRead: true,
  };
  const metadata = await sharp(source, inputOptions)
    .timeout({ seconds: 2 })
    .metadata();
  const orientedWidth = metadata.autoOrient?.width ?? metadata.width;
  const orientedHeight = metadata.autoOrient?.height ?? metadata.height;
  if (
    metadata.format !== expectedFormat ||
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_INPUT_PIXELS ||
    (metadata.pages ?? 1) !== 1
  ) {
    throw new Error("raster decoder or geometry mismatch");
  }
  if (mode === "metadata") {
    writeSync(1, JSON.stringify({
      width: orientedWidth,
      height: orientedHeight,
    }));
  } else if (mode === "thumbnail" || mode === "preview") {
    const width = mode === "preview" ? 1200 : 386;
    const height = mode === "preview" ? 630 : 386;
    const thumbnail = await sharp(source, inputOptions)
      .timeout({ seconds: 2 })
      .rotate()
      .resize(width, height, { fit: "cover", position: "centre" })
      .toColorspace("srgb")
      .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
      .toBuffer();
    writeSync(1, thumbnail);
  } else {
    throw new Error("unknown raster worker mode");
  }
  process.exit(0);
} catch (error) {
  writeSync(2, error instanceof Error ? error.message : "raster worker failed");
  process.exit(1);
}
`;

interface WorkerWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class BoundedWorkerPool {
  private activeWorkers = 0;
  private readonly workerWaiters: WorkerWaiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
    private readonly queueTimeoutMs: number,
  ) {}

  async acquire(timeoutMs = this.queueTimeoutMs): Promise<void> {
    if (this.activeWorkers < this.maxConcurrent) {
      this.activeWorkers += 1;
      return;
    }
    if (this.workerWaiters.length >= this.maxQueued) {
      throw new Error("raster worker queue is full");
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: WorkerWaiter = {
        resolve,
        reject,
        timeout: setTimeout(
          () => {
            const index = this.workerWaiters.indexOf(waiter);
            if (index >= 0) this.workerWaiters.splice(index, 1);
            reject(new Error("raster worker queue wait timed out"));
          },
          Math.min(this.queueTimeoutMs, Math.max(1, timeoutMs)),
        ),
      };
      this.workerWaiters.push(waiter);
    });
  }

  release(): void {
    const next = this.workerWaiters.shift();
    if (next) {
      clearTimeout(next.timeout);
      next.resolve();
      return;
    }
    this.activeWorkers -= 1;
  }

  state(): { active: number; queued: number } {
    return { active: this.activeWorkers, queued: this.workerWaiters.length };
  }
}

const workerPool = new BoundedWorkerPool(
  RASTER_WORKER_LIMITS.maxConcurrent,
  RASTER_WORKER_LIMITS.maxQueued,
  RASTER_WORKER_LIMITS.queueTimeoutMs,
);
const WORKER_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "WINDIR",
  "DYLD_LIBRARY_PATH",
  "LD_LIBRARY_PATH",
] as const;

function rasterWorkerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of WORKER_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

async function runRasterWorker(
  mode: "metadata" | "thumbnail" | "preview",
  filePath: string,
  mimeType: string,
  timeoutMs: number = RASTER_WORKER_LIMITS.wallTimeoutMs,
): Promise<Buffer> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  await workerPool.acquire(Math.max(1, deadline - Date.now()));
  try {
    const result = await runKillableProcess(
      process.execPath,
      [
        "--experimental-permission",
        "--allow-addons",
        `--allow-fs-read=${filePath}`,
        `--allow-fs-read=${path.resolve(process.cwd(), "node_modules")}`,
        `--max-old-space-size=${RASTER_WORKER_LIMITS.maxOldSpaceMiB}`,
        "--input-type=module",
        "--eval",
        WORKER_PROGRAM,
        "--",
        mode,
        filePath,
        mimeType,
      ],
      {
        cwd: process.cwd(),
        env: rasterWorkerEnvironment(),
        maxOutputBytes: RASTER_WORKER_LIMITS.maxOutputBytes,
        timeoutMs: Math.max(1, deadline - Date.now()),
      },
    );
    return result.stdout;
  } finally {
    workerPool.release();
  }
}

export async function inspectRasterInWorker(
  filePath: string,
  mimeType: string,
  timeoutMs?: number,
): Promise<{ width: number; height: number }> {
  const output = await runRasterWorker(
    "metadata",
    filePath,
    mimeType,
    timeoutMs,
  );
  const parsed: unknown = JSON.parse(output.toString("utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("width" in parsed) ||
    !("height" in parsed) ||
    typeof parsed.width !== "number" ||
    typeof parsed.height !== "number"
  ) {
    throw new Error("invalid raster worker response");
  }
  return { width: parsed.width, height: parsed.height };
}

export async function deriveRasterPreviewInWorker(
  filePath: string,
  mimeType: string,
  timeoutMs?: number,
): Promise<Buffer> {
  return runRasterWorker("preview", filePath, mimeType, timeoutMs);
}

export async function deriveRasterThumbnailInWorker(
  filePath: string,
  mimeType: string,
): Promise<Buffer> {
  return runRasterWorker("thumbnail", filePath, mimeType);
}
