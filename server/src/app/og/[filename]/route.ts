import { AppError } from "@/server/files/errors";
import { errorResponse, notFound } from "@/server/files/http";
import { renderOgImage } from "@/server/files/og-image";
import {
  isPreviewBusy,
  isPreviewSourceUnavailable,
} from "@/server/files/preview-renderers";
import { getFileService } from "@/server/files/singleton";
import {
  captureSourceIdentity,
  sourceIdentityMatches,
} from "@/server/files/source-state";
import {
  buildUnfurlModel,
  publicUnfurlRevisionMatches,
} from "@/server/files/unfurl";
import { BASE62_ID_PATTERN } from "@/server/files/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ filename: string }>;
}

const IMAGE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "content-type": "image/png",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

async function responseFor(
  context: RouteContext,
  includeBody: boolean,
): Promise<Response> {
  try {
    const { filename } = await context.params;
    if (!filename.endsWith(".png")) throw notFound();
    const id = filename.slice(0, -4);
    if (!BASE62_ID_PATTERN.test(id)) throw notFound();
    const service = await getFileService();
    const file = await service.get(id);
    if (file?.visibility !== "public") throw notFound();
    const sourceIdentity = await captureSourceIdentity(service, file);
    if (!sourceIdentity) throw notFound();
    const model = await buildUnfurlModel(service, file);
    const image = await renderOgImage(service, file, model);
    const current = await service.get(id);
    if (!publicUnfurlRevisionMatches(file, current)) throw notFound();
    if (!(await sourceIdentityMatches(service, file, sourceIdentity)))
      throw notFound();
    const headers = new Headers(IMAGE_HEADERS);
    headers.set("content-length", String(image.length));
    return new Response(includeBody ? new Uint8Array(image) : null, {
      headers,
    });
  } catch (error) {
    const response = errorResponse(
      isPreviewBusy(error)
        ? new AppError(503, "preview_busy", "Preview rendering is busy")
        : isPreviewSourceUnavailable(error)
          ? notFound()
          : error,
    );
    return includeBody
      ? response
      : new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
  }
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  return responseFor(context, true);
}

export async function HEAD(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  return responseFor(context, false);
}
