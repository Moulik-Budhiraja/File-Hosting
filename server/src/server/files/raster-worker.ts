import { execFile } from "node:child_process";

export const RASTER_WORKER_LIMITS = Object.freeze({
  maxConcurrent: 2,
  maxOldSpaceMiB: 256,
  maxOutputBytes: 8 * 1024 * 1024,
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
  } else if (mode === "thumbnail") {
    const thumbnail = await sharp(source, inputOptions)
      .timeout({ seconds: 2 })
      .rotate()
      .resize(386, 386, { fit: "cover", position: "centre" })
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

let activeWorkers = 0;
const workerWaiters: Array<() => void> = [];
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

async function acquireWorkerSlot(): Promise<void> {
  if (activeWorkers < RASTER_WORKER_LIMITS.maxConcurrent) {
    activeWorkers += 1;
    return;
  }
  await new Promise<void>((resolve) => workerWaiters.push(resolve));
}

function releaseWorkerSlot(): void {
  const next = workerWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeWorkers -= 1;
}

async function runRasterWorker(
  mode: "metadata" | "thumbnail",
  filePath: string,
  mimeType: string,
): Promise<Buffer> {
  await acquireWorkerSlot();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      execFile(
        process.execPath,
        [
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
          encoding: null,
          env: rasterWorkerEnvironment(),
          killSignal: "SIGKILL",
          maxBuffer: RASTER_WORKER_LIMITS.maxOutputBytes,
          timeout: RASTER_WORKER_LIMITS.wallTimeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = Buffer.isBuffer(stderr)
              ? stderr.toString("utf8").trim()
              : String(stderr).trim();
            reject(
              new Error(detail || error.message || "raster worker failed"),
            );
            return;
          }
          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        },
      );
    });
  } finally {
    releaseWorkerSlot();
  }
}

export async function inspectRasterInWorker(
  filePath: string,
  mimeType: string,
): Promise<{ width: number; height: number }> {
  const output = await runRasterWorker("metadata", filePath, mimeType);
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

export async function deriveRasterThumbnailInWorker(
  filePath: string,
  mimeType: string,
): Promise<Buffer> {
  return runRasterWorker("thumbnail", filePath, mimeType);
}
