import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { isAuthorized } from "./auth";
import { getFileService } from "./singleton";
import type { FileService } from "./service";
import type { StoredFile } from "./types";
import { notFound, unauthorized } from "./http";

export async function requireApiService(
  request: Request,
): Promise<FileService> {
  const service = await getFileService();
  if (!isAuthorized(request, service.config.token)) throw unauthorized();
  return service;
}

export async function getViewableFile(
  request: Request,
  id: string,
): Promise<{ service: FileService; file: StoredFile }> {
  const service = await getFileService();
  const file = await service.get(id);
  if (
    !file ||
    (file.visibility === "private" &&
      !isAuthorized(request, service.config.token))
  ) {
    throw notFound();
  }
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
