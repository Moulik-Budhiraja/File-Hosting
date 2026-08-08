import sharp, { type Metadata } from "sharp";
import {
  DERIVATIVE_PROFILE_NAMES,
  DERIVATIVE_PROFILES,
  type DerivativeProfileName,
} from "./image-derivative-contract";
export {
  DERIVATIVE_PROFILE_NAMES,
  DERIVATIVE_PROFILES,
  DERIVATIVE_REVISION,
  type DerivativeProfileName,
} from "./image-derivative-contract";

export interface GeneratedDerivative {
  bytes: Buffer;
  width: number;
  height: number;
}

export interface DerivativeInputLimits {
  inputBytes?: number;
  maxDimension?: number;
  maxPixels?: number;
  timeoutSeconds?: number;
}

const DEFAULT_INPUT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_DIMENSION_MAX = 32_768;
const DEFAULT_PIXEL_MAX = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 15;
const RASTER_FORMATS = new Set([
  "jpeg",
  "png",
  "webp",
  "gif",
  "tiff",
  "avif",
  "heif",
]);
const QUALITY_STEPS = [88, 82, 76, 70, 64, 58, 52, 46, 40] as const;
const DIMENSION_FACTORS = [1, 0.85, 0.7, 0.55, 0.4] as const;

async function encodeBoundedWebp(
  source: Buffer,
  maxWidth: number,
  initialQuality: number,
  maxBytes: number,
  timeoutSeconds: number,
): Promise<GeneratedDerivative> {
  const qualities =
    initialQuality === 88
      ? QUALITY_STEPS
      : [initialQuality, Math.max(40, initialQuality - 12)];
  for (const factor of DIMENSION_FACTORS) {
    const width = Math.max(1, Math.floor(maxWidth * factor));
    for (const quality of qualities) {
      const bytes = await sharp(source, {
        pages: 1,
        limitInputPixels: DEFAULT_PIXEL_MAX,
      })
        .timeout({ seconds: timeoutSeconds })
        .rotate()
        .toColorspace("srgb")
        .resize({ width, withoutEnlargement: true, fit: "inside" })
        .webp({ quality, effort: 4, smartSubsample: true })
        .toBuffer();
      if (bytes.length <= maxBytes) {
        const metadata = await sharp(bytes).metadata();
        if (!metadata.width || !metadata.height)
          throw new Error("derivative dimensions unavailable");
        return { bytes, width: metadata.width, height: metadata.height };
      }
    }
  }
  throw new Error("derivative output limit exceeded");
}

export async function generateImageDerivatives(
  input: Buffer,
  limits: DerivativeInputLimits = {},
): Promise<Record<DerivativeProfileName, GeneratedDerivative>> {
  const inputMax = limits.inputBytes ?? DEFAULT_INPUT_MAX_BYTES;
  if (input.length > inputMax)
    throw new Error("image input byte limit exceeded");
  const maxPixels = limits.maxPixels ?? DEFAULT_PIXEL_MAX;
  let metadata: Metadata;
  try {
    metadata = await sharp(input, {
      pages: 1,
      limitInputPixels: maxPixels,
    }).metadata();
  } catch (cause) {
    throw new Error("unsupported image or decode failed", { cause });
  }
  if (!metadata.format || !RASTER_FORMATS.has(metadata.format))
    throw new Error("unsupported raster image format");
  if (!metadata.width || !metadata.height)
    throw new Error("image decode dimensions unavailable");
  const maxDimension = limits.maxDimension ?? DEFAULT_DIMENSION_MAX;
  if (metadata.width > maxDimension || metadata.height > maxDimension)
    throw new Error("image dimension limit exceeded");
  if (metadata.width * metadata.height > maxPixels)
    throw new Error("image decoded pixel limit exceeded");
  const timeoutSeconds = limits.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const result = {} as Record<DerivativeProfileName, GeneratedDerivative>;
  for (const name of DERIVATIVE_PROFILE_NAMES) {
    const profile = DERIVATIVE_PROFILES[name];
    result[name] = await encodeBoundedWebp(
      input,
      profile.maxWidth,
      profile.quality,
      profile.maxBytes,
      timeoutSeconds,
    );
  }
  return result;
}
