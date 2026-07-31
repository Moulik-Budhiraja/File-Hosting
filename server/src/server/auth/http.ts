import { timingSafeEqual } from "node:crypto";

import type { User } from "./database";
import { extractBearerToken } from "../files/auth";
import { AppError } from "../files/errors";
import { getFileService } from "../files/singleton";
import type { FileService } from "../files/service";

export const SESSION_COOKIE = "fs_session";

export interface Principal {
  user: User | null;
  userId: string | null;
  role: "admin" | "member";
  source: "legacy" | "api_key" | "session";
}

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function authenticate(
  request: Request,
  service: FileService,
): Promise<Principal | null> {
  const bearer = extractBearerToken(request);
  if (bearer) {
    if (equalSecret(bearer, service.config.token)) {
      return { user: null, userId: null, role: "admin", source: "legacy" };
    }
    const user = await service.auth.resolveApiKey(bearer);
    return user
      ? { user, userId: user.id, role: user.role, source: "api_key" }
      : null;
  }
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const user = await service.auth.resolveSession(token);
  return user
    ? { user, userId: user.id, role: user.role, source: "session" }
    : null;
}

export async function requirePrincipal(
  request: Request,
): Promise<{ service: FileService; principal: Principal }> {
  const service = await getFileService();
  const principal = await authenticate(request, service);
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

export async function jsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch (cause) {
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
  };
}
