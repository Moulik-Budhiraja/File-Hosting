import { errorResponse, json } from "@/server/files/http";
import { decodeCursor } from "@/server/files/database";
import { AppError } from "@/server/files/errors";
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
      authorizeFinalize: async () => {
        const current = await requireApiContext(request, true);
        if (
          current.principal.userId !== principal.userId ||
          current.principal.source !== principal.source
        ) {
          throw new AppError(
            401,
            "invalid_token",
            "Credential is no longer valid",
          );
        }
      },
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
    // Backward-compatible owner scope: only the literal "me" is accepted,
    // resolved server-side so the filter runs in SQL before pagination.
    const ownerValue = params.get("owner");
    let owner: string | undefined;
    if (ownerValue !== null) {
      if (ownerValue !== "me") {
        throw new AppError(400, "invalid_owner", "owner must be 'me'");
      }
      if (!principal.userId) {
        throw new AppError(
          400,
          "invalid_owner",
          "owner=me requires a user credential",
        );
      }
      owner = principal.userId;
    }
    const result = await service.list({
      q: params.get("q") ?? undefined,
      name: params.get("name") ?? undefined,
      tags: validateTags(params.getAll("tag")),
      visibility,
      owner,
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
