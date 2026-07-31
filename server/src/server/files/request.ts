import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  assertCsrf,
  authenticate,
  requirePrincipal,
  type Principal,
} from "../auth/http";
import { getFileService } from "./singleton";
import type { FileService } from "./service";
import type { AccessScope, StoredFile } from "./types";
import { notFound } from "./http";

export function accessFor(principal: Principal | null): AccessScope {
  return principal
    ? { role: principal.role, userId: principal.userId }
    : { role: "anonymous", userId: null };
}

export function canRead(
  file: StoredFile,
  principal: Principal | null,
): boolean {
  if (file.visibility === "public") return true;
  if (!principal) return false;
  if (file.visibility === "protected") return true;
  return (
    principal.role === "admin" ||
    (file.ownerId !== null && file.ownerId === principal.userId)
  );
}

export function canManage(file: StoredFile, principal: Principal): boolean {
  return (
    principal.role === "admin" ||
    (file.ownerId !== null && file.ownerId === principal.userId)
  );
}

export async function requireApiContext(
  request: Request,
  mutation = false,
): Promise<{ service: FileService; principal: Principal }> {
  const context = await requirePrincipal(request);
  if (mutation) assertCsrf(request, context.service, context.principal);
  return context;
}

export async function requireApiService(
  request: Request,
): Promise<FileService> {
  return (await requireApiContext(request)).service;
}

export async function getAuthorizedFile(
  request: Request,
  id: string,
  mutation = false,
): Promise<{ service: FileService; file: StoredFile; principal: Principal }> {
  const { service, principal } = await requireApiContext(request, mutation);
  const file = await service.get(id);
  if (
    !file ||
    (mutation ? !canManage(file, principal) : !canRead(file, principal))
  ) {
    throw notFound();
  }
  return { service, file, principal };
}

export async function getViewableFile(
  request: Request,
  id: string,
): Promise<{ service: FileService; file: StoredFile }> {
  const service = await getFileService();
  const principal = await authenticate(request, service);
  const file = await service.get(id);
  if (!file || !canRead(file, principal)) throw notFound();
  return { service, file };
}

export function requestBody(request: Request): AsyncIterable<Uint8Array> {
  if (!request.body) {
    return (async function* empty() {
      // Empty files are valid uploads.
    })();
  }
  return Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>);
}
