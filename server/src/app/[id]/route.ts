import { notFound } from "@/server/files/http";
import {
  PREVIEW_CONTENT_SECURITY_POLICY,
  renderPreview,
} from "@/server/files/preview";

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
import { readUnfurlArtifact } from "@/server/files/preview-artifact";
import {
  settleUnavailableTiming,
  unavailablePageResponse,
} from "../../server/files/unavailable";

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
  const unavailableStartedAt = performance.now();
  const unavailable = async (): Promise<Response> => {
    await settleUnavailableTiming(unavailableStartedAt);
    return unavailablePageResponse(includeBody);
  };
  try {
    const { service, file } = await getViewableFile(
      request,
      (await context.params).id,
    );
    const sourceIdentity = await captureSourceIdentity(service, file);
    if (!sourceIdentity) throw notFound();
    const ready =
      file.visibility === "public" &&
      (await service.repository.getUnfurlArtifactJob(file.id))?.status ===
        "complete";
    const artifact = ready ? await readUnfurlArtifact(service, file) : null;
    const unfurlHead =
      file.visibility === "public"
        ? renderUnfurlHead(
            await buildUnfurlModel(service, file, artifact?.preview, false),
          )
        : "";
    const html = await renderPreview(
      service,
      file,
      unfurlHead,
      artifact?.preview,
      file.visibility !== "public" || Boolean(artifact),
    );
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
        "content-security-policy": PREVIEW_CONTENT_SECURITY_POLICY,
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return unavailable();
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
