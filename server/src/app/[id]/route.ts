import { notFound } from "@/server/files/http";
import { renderPreview } from "@/server/files/preview";
import { getViewableFile } from "@/server/files/request";
import {
  captureSourceIdentity,
  sourceIdentityMatches,
} from "@/server/files/source-state";
import {
  buildUnfurlModel,
  publicUnfurlRevisionMatches,
  renderUnfurlHead,
} from "@/server/files/unfurl";
import { unavailablePageResponse } from "@/server/files/unavailable";

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
    const sourceIdentity = await captureSourceIdentity(service, file);
    if (!sourceIdentity) throw notFound();
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
    if (!(await sourceIdentityMatches(service, file, sourceIdentity)))
      throw notFound();
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
  } catch {
    return unavailablePageResponse(includeBody);
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
