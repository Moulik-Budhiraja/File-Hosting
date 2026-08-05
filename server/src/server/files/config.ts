import path from "node:path";

import {
  canonicalPublicOrigin,
  DEFAULT_PUBLIC_ORIGIN,
} from "../../../public-url.js";
import { AppError } from "./errors";

export interface FilesConfig {
  token: string;
  databaseUrl: string;
  storageDir: string;
  publicUrl: string;
  maxUploadBytes: number;
  minFreeBytes: number;
  bootstrapUsername?: string;
  bootstrapPassword?: string;
  trustedIngress?: {
    ipHeader: string;
    secretHeader: string;
    secret: string;
  };
}

const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/u;
const RESERVED_TRUST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "set-cookie",
]);

function trustedIngressConfig(
  env: NodeJS.ProcessEnv,
): FilesConfig["trustedIngress"] {
  const ipHeader = env.FS_TRUSTED_INGRESS_IP_HEADER;
  const secretHeader = env.FS_TRUSTED_INGRESS_SECRET_HEADER;
  const secret = env.FS_TRUSTED_INGRESS_SECRET;
  const configured = [ipHeader, secretHeader, secret].filter(Boolean).length;
  if (configured === 0) return undefined;
  if (configured !== 3) {
    throw new AppError(
      500,
      "invalid_configuration",
      "Trusted ingress IP header, secret header, and secret must be configured together",
    );
  }

  const normalizedIpHeader = ipHeader!.toLowerCase();
  const normalizedSecretHeader = secretHeader!.toLowerCase();
  for (const header of [normalizedIpHeader, normalizedSecretHeader]) {
    if (!HTTP_HEADER_NAME.test(header) || RESERVED_TRUST_HEADERS.has(header)) {
      throw new AppError(
        500,
        "invalid_configuration",
        "Trusted ingress header names must be valid, non-reserved HTTP headers",
      );
    }
  }
  if (normalizedIpHeader === normalizedSecretHeader) {
    throw new AppError(
      500,
      "invalid_configuration",
      "Trusted ingress header names must be distinct",
    );
  }
  if (Buffer.byteLength(secret!, "utf8") < 32) {
    throw new AppError(
      500,
      "invalid_configuration",
      "Trusted ingress secret must contain at least 32 bytes",
    );
  }
  if (secret === env.FS_TOKEN) {
    throw new AppError(
      500,
      "invalid_configuration",
      "Trusted ingress secret must be distinct from FS_TOKEN",
    );
  }
  return {
    ipHeader: normalizedIpHeader,
    secretHeader: normalizedSecretHeader,
    secret: secret!,
  };
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

  let publicUrl: string;
  try {
    publicUrl = canonicalPublicOrigin(
      env.FS_PUBLIC_URL ?? DEFAULT_PUBLIC_ORIGIN,
    );
  } catch {
    throw new AppError(
      500,
      "invalid_configuration",
      "FS_PUBLIC_URL must be a canonical HTTP or HTTPS origin",
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

  const bootstrapUsername = env.FS_BOOTSTRAP_USERNAME;
  const bootstrapPassword = env.FS_BOOTSTRAP_PASSWORD;
  if (Boolean(bootstrapUsername) !== Boolean(bootstrapPassword)) {
    throw new AppError(
      500,
      "invalid_configuration",
      "FS_BOOTSTRAP_USERNAME and FS_BOOTSTRAP_PASSWORD must be configured together",
    );
  }

  return {
    token,
    databaseUrl: env.DATABASE_URL ?? "file:./data/files.db",
    storageDir: path.resolve(env.FS_STORAGE_DIR ?? "./data/objects"),
    publicUrl,
    maxUploadBytes: readInteger("FS_MAX_UPLOAD_BYTES", 10_737_418_240),
    minFreeBytes: readInteger("FS_MIN_FREE_BYTES", 1_073_741_824),
    bootstrapUsername,
    bootstrapPassword,
    trustedIngress: trustedIngressConfig(env),
  };
}

// Kept exported for tests of the environment-independent validation behavior.
export const configInternals = { readNonNegativeInteger };
