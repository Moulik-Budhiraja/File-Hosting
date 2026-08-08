import { Readable } from "node:stream";

import { AppError } from "@/server/files/errors";
import { errorResponse, notFound } from "@/server/files/http";
import {
  DERIVATIVE_PROFILE_NAMES,
  type DerivativeProfileName,
} from "@/server/files/image-derivatives";
import { parseRangeHeader } from "@/server/files/range";
import { getViewableFile } from "@/server/files/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; profile: string }>;
}

function isProfile(value: string): value is DerivativeProfileName {
  return DERIVATIVE_PROFILE_NAMES.includes(value as DerivativeProfileName);
}

async function respond(
  request: Request,
  context: RouteContext,
  head: boolean,
): Promise<Response> {
  let sizeForRangeError: number | undefined;
  try {
    const { id, profile } = await context.params;
    const { service, file } = await getViewableFile(request, id);
    if (!isProfile(profile)) throw notFound();
    const derivative = await service.getDerivative(file.id, profile);
    if (!derivative) throw notFound();
    sizeForRangeError = derivative.size;
    const range = parseRangeHeader(
      request.headers.get("range"),
      derivative.size,
    );
    const contentLength = range ? range.end - range.start + 1 : derivative.size;
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": String(contentLength),
      "content-security-policy":
        "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "content-type": "image/webp",
      etag: `"sha256-${derivative.sha256}"`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    if (range) {
      headers.set(
        "content-range",
        `bytes ${range.start}-${range.end}/${derivative.size}`,
      );
    }
    if (head || derivative.size === 0) {
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const stream = service.openDerivativeReadStream(
      derivative,
      range?.start,
      range?.end,
    );
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
