import { errorResponse, notFound } from "@/server/files/http";
import { renderPreview } from "@/server/files/preview";
import { getViewableFile } from "@/server/files/request";
import {
  isMissingSourceError,
  sourceMatchesFile,
} from "@/server/files/source-state";
import {
  buildUnfurlModel,
  publicUnfurlRevisionMatches,
  renderUnfurlHead,
} from "@/server/files/unfurl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function responseFor(
  request: Request,
  context: RouteContext,
  includeBody: boolean,
): Promise<Response> {
  try {
    const { service, file } = await getViewableFile(
      request,
      (await context.params).id,
    );
    if (!(await sourceMatchesFile(service, file))) throw notFound();
    const unfurlHead =
      file.visibility === "public"
        ? renderUnfurlHead(await buildUnfurlModel(service, file))
        : "";
    const html = await renderPreview(service, file, unfurlHead);
    if (
      file.visibility === "public" &&
      !publicUnfurlRevisionMatches(file, await service.get(file.id))
    ) {
      throw notFound();
    }
    if (!(await sourceMatchesFile(service, file))) throw notFound();
    return new Response(includeBody ? html : null, {
      headers: {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const response = errorResponse(
      isMissingSourceError(error) ? notFound() : error,
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
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return responseFor(request, context, true);
}

export async function HEAD(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return responseFor(request, context, false);
}
