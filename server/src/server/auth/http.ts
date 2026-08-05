import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { User } from "./database";
import { extractBearerToken } from "../files/auth";
import { AppError } from "../files/errors";
import { getFileService } from "../files/singleton";
import type { FileService } from "../files/service";
import type { FilesConfig } from "../files/config";

export const HTTP_SESSION_COOKIE = "fs_session";
export const HTTPS_SESSION_COOKIE = "__Host-fs_session";

export interface Principal {
  user: User | null;
  userId: string | null;
  role: "admin" | "member";
  source: "legacy" | "api_key" | "session";
  sessionToken: string | null;
}

function equalSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function trustedClientAddress(
  request: Request,
  config: Pick<FilesConfig, "trustedIngress">,
): string | null {
  const ingress = config.trustedIngress;
  if (!ingress) return null;
  const proof = request.headers.get(ingress.secretHeader);
  if (proof === null || !equalSecret(proof, ingress.secret)) return null;
  const address = request.headers.get(ingress.ipHeader)?.trim() ?? "";
  return isIP(address) === 0 ? null : address.toLowerCase();
}

export function cookieValue(request: Request, name: string): string | null {
  const matches: string[] = [];
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) matches.push(value.join("="));
  }
  if (matches.length !== 1) return null;
  try {
    return decodeURIComponent(matches[0]!);
  } catch {
    return null;
  }
}

export function sessionCookieName(publicUrl: string): string {
  return new URL(publicUrl).protocol === "https:"
    ? HTTPS_SESSION_COOKIE
    : HTTP_SESSION_COOKIE;
}

export function sessionCookieValue(
  request: Request,
  publicUrl: string,
): string | null {
  const expected = sessionCookieName(publicUrl);
  const alternate =
    expected === HTTPS_SESSION_COOKIE
      ? HTTP_SESSION_COOKIE
      : HTTPS_SESSION_COOKIE;
  const hasAlternate = (request.headers.get("cookie") ?? "")
    .split(";")
    .some((part) => part.trim().split("=", 1)[0] === alternate);
  return hasAlternate ? null : cookieValue(request, expected);
}

export function sessionCookieHeader(
  publicUrl: string,
  token: string,
  maxAge: number,
): string {
  const secure = new URL(publicUrl).protocol === "https:";
  return `${sessionCookieName(publicUrl)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export async function authenticate(
  request: Request,
  service: FileService,
  { slideSession = true }: { slideSession?: boolean } = {},
): Promise<Principal | null> {
  const bearer = extractBearerToken(request);
  if (bearer) {
    if (equalSecret(bearer, service.config.token)) {
      return {
        user: null,
        userId: null,
        role: "admin",
        source: "legacy",
        sessionToken: null,
      };
    }
    const user = await service.auth.resolveApiKey(bearer);
    return user
      ? {
          user,
          userId: user.id,
          role: user.role,
          source: "api_key",
          sessionToken: null,
        }
      : null;
  }
  const token = sessionCookieValue(request, service.config.publicUrl);
  if (!token) return null;
  const user = await service.auth.resolveSession(token, new Date(), {
    slide: slideSession,
  });
  return user
    ? {
        user,
        userId: user.id,
        role: user.role,
        source: "session",
        sessionToken: token,
      }
    : null;
}

export async function requirePrincipal(
  request: Request,
  options: { slideSession?: boolean } = {},
): Promise<{ service: FileService; principal: Principal }> {
  const service = await getFileService();
  const principal = await authenticate(request, service, options);
  if (!principal) {
    throw new AppError(401, "unauthorized", "A valid bearer token is required");
  }
  return { service, principal };
}

export async function requireAdmin(
  request: Request,
): Promise<{ service: FileService; principal: Principal }> {
  const context = await requirePrincipal(request);
  if (context.principal.role !== "admin") {
    throw new AppError(403, "forbidden", "Administrator access is required");
  }
  return context;
}

export function assertCsrf(
  request: Request,
  service: FileService,
  principal?: Principal,
): void {
  if (principal && principal.source !== "session") return;
  const expected = new URL(service.config.publicUrl).origin;
  const origin = request.headers.get("origin");
  if (origin !== expected) {
    throw new AppError(403, "csrf_rejected", "Request origin was not accepted");
  }
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

async function boundedJsonText(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new AppError(
      413,
      "request_too_large",
      "JSON request body is too large",
    );
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new AppError(
          413,
          "request_too_large",
          "JSON request body is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function jsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await boundedJsonText(request)) as unknown;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError(400, "invalid_json", "Request body must be valid JSON", {
      cause,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(
      400,
      "invalid_json",
      "Request body must be a JSON object",
    );
  }
  return value as Record<string, unknown>;
}

export function publicUser(user: User): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
    password_changed_at: user.passwordChangedAt,
    temporary_password_expires_at: user.temporaryPasswordExpiresAt,
  };
}
