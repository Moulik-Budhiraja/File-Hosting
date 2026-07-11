import { Readable } from "node:stream";

import { AppError } from "@/server/files/errors";
import { errorResponse } from "@/server/files/http";
import { parseRangeHeader } from "@/server/files/range";
import { getViewableFile } from "@/server/files/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function respond(
  request: Request,
  context: RouteContext,
  head: boolean,
): Promise<Response> {
  let sizeForRangeError: number | undefined;
  try {
    const { service, file } = await getViewableFile(
      request,
      (await context.params).id,
    );
    sizeForRangeError = file.size;
    const range = parseRangeHeader(request.headers.get("range"), file.size);
    const contentLength = range ? range.end - range.start + 1 : file.size;
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-disposition": contentDisposition(file.name),
      "content-length": String(contentLength),
      "content-type": file.mimeType,
      etag: `"sha256-${file.sha256}"`,
      "x-content-type-options": "nosniff",
    });
    if (range)
      headers.set(
        "content-range",
        `bytes ${range.start}-${range.end}/${file.size}`,
      );
    if (file.mimeType === "text/html" || file.mimeType === "image/svg+xml") {
      headers.set(
        "content-security-policy",
        "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
    }
    if (head || file.size === 0) {
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const stream = service.openReadStream(file, range?.start, range?.end);
    return new Response(
      Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      { status: range ? 206 : 200, headers },
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 416) {
      const response = errorResponse(error);
      if (sizeForRangeError !== undefined) {
        response.headers.set("content-range", `bytes */${sizeForRangeError}`);
        response.headers.set("accept-ranges", "bytes");
      }
      return response;
    }
    return errorResponse(error);
  }
}

export function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return respond(request, context, false);
}

export function HEAD(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return respond(request, context, true);
}
