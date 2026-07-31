import { AppError } from "@/server/files/errors";
import { errorResponse, json } from "@/server/files/http";
import { decodeCursor } from "@/server/files/database";
import { requestBody, requireApiService } from "@/server/files/request";
import {
  parseArchive,
  parseArchiveFilter,
  parseBoolean,
  parseLimit,
  parseVisibility,
  validateFilename,
  validateTags,
} from "@/server/files/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Upload metadata may arrive percent-encoded in x-fs-* headers so request
// URLs (and any access logs of them) never carry filenames or tags. The
// query-parameter contract remains supported for existing clients.
function decodeMetadataHeader(
  value: string,
  code: string,
  what: string,
): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AppError(
      400,
      code,
      `${what} header must be percent-encoded UTF-8`,
    );
  }
}

function uploadMetadataInputs(request: Request, url: URL) {
  const headers = request.headers;
  const headerName = headers.get("x-fs-name");
  const headerTags = headers.get("x-fs-tags");
  const headerPrivate = headers.get("x-fs-private");
  const headerArchive = headers.get("x-fs-archive");
  return {
    name:
      headerName !== null
        ? decodeMetadataHeader(headerName, "invalid_name", "x-fs-name")
        : url.searchParams.get("name"),
    tags:
      headerTags !== null
        ? headerTags
            .split(",")
            .filter((tag) => tag !== "")
            .map((tag) =>
              decodeMetadataHeader(tag, "invalid_tags", "x-fs-tags"),
            )
        : url.searchParams.getAll("tag"),
    private: headerPrivate ?? url.searchParams.get("private"),
    archive: headerArchive ?? url.searchParams.get("archive"),
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const service = await requireApiService(request);
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

    const metadata = uploadMetadataInputs(request, url);
    const file = await service.upload(requestBody(request), {
      name: validateFilename(metadata.name),
      tags: validateTags(metadata.tags),
      visibility: parseBoolean(metadata.private) ? "private" : "public",
      archive: parseArchive(metadata.archive),
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
    const service = await requireApiService(request);
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
      archive: parseArchiveFilter(params.get("archive")),
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
