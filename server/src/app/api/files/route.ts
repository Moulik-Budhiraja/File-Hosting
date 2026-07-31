import { errorResponse, json } from "@/server/files/http";
import { decodeCursor } from "@/server/files/database";
import { requestBody, requireApiContext } from "@/server/files/request";
import {
  parseArchive,
  parseBoolean,
  parseLimit,
  parseVisibility,
  validateFilename,
  validateTags,
} from "@/server/files/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const { service, principal } = await requireApiContext(request, true);
    const url = new URL(request.url);
    const contentLengthHeader = request.headers.get("content-length");
    let contentLength: number | undefined;
    if (contentLengthHeader !== null) {
      contentLength = Number(contentLengthHeader);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        return json(
          {
            error: {
              code: "invalid_content_length",
              message: "Content-Length must be a non-negative integer",
            },
          },
          { status: 400 },
        );
      }
    }

    const file = await service.upload(requestBody(request), {
      name: validateFilename(url.searchParams.get("name")),
      tags: validateTags(url.searchParams.getAll("tag")),
      visibility: url.searchParams.has("visibility")
        ? parseVisibility(url.searchParams.get("visibility"))
        : parseBoolean(url.searchParams.get("private"))
          ? "private"
          : "public",
      ownerId: principal.userId,
      archive: parseArchive(url.searchParams.get("archive")),
      mimeType: request.headers.get("content-type") ?? undefined,
      contentLength,
    });
    return json(service.toMetadata(file), {
      status: 201,
      headers: { location: `${service.config.publicUrl}/${file.id}` },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { service, principal } = await requireApiContext(request);
    const params = new URL(request.url).searchParams;
    const visibilityValue = params.get("visibility");
    const visibility = visibilityValue
      ? parseVisibility(visibilityValue)
      : undefined;
    const result = await service.list({
      q: params.get("q") ?? undefined,
      name: params.get("name") ?? undefined,
      tags: validateTags(params.getAll("tag")),
      visibility,
      access: { role: principal.role, userId: principal.userId },
      limit: parseLimit(params.get("limit")),
      cursor: params.get("cursor")
        ? decodeCursor(params.get("cursor")!)
        : undefined,
    });
    return json({
      items: result.files.map((file) => service.toMetadata(file)),
      next_cursor: result.nextCursor,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
