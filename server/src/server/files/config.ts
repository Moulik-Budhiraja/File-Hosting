import path from "node:path";

import { AppError } from "./errors";

export interface FilesConfig {
  token: string;
  databaseUrl: string;
  storageDir: string;
  publicUrl: string;
  maxUploadBytes: number;
  minFreeBytes: number;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(
      500,
      "invalid_configuration",
      `${name} must be a non-negative integer`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FilesConfig {
  const token = env.FS_TOKEN;
  if (!token) {
    throw new AppError(500, "invalid_configuration", "FS_TOKEN is required");
  }

  const publicUrl = env.FS_PUBLIC_URL ?? "http://localhost:3000";
  let parsedPublicUrl: URL;
  try {
    parsedPublicUrl = new URL(publicUrl);
  } catch (cause) {
    throw new AppError(
      500,
      "invalid_configuration",
      "FS_PUBLIC_URL must be an absolute URL",
      {
        cause,
      },
    );
  }
  if (
    parsedPublicUrl.protocol !== "http:" &&
    parsedPublicUrl.protocol !== "https:"
  ) {
    throw new AppError(
      500,
      "invalid_configuration",
      "FS_PUBLIC_URL must use http or https",
    );
  }

  const readInteger = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AppError(
        500,
        "invalid_configuration",
        `${name} must be a non-negative integer`,
      );
    }
    return value;
  };

  return {
    token,
    databaseUrl: env.DATABASE_URL ?? "file:./data/files.db",
    storageDir: path.resolve(env.FS_STORAGE_DIR ?? "./data/objects"),
    publicUrl: publicUrl.replace(/\/+$/, ""),
    maxUploadBytes: readInteger("FS_MAX_UPLOAD_BYTES", 10_737_418_240),
    minFreeBytes: readInteger("FS_MIN_FREE_BYTES", 1_073_741_824),
  };
}

// Kept exported for tests of the environment-independent validation behavior.
export const configInternals = { readNonNegativeInteger };
