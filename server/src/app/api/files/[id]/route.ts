import { AppError } from "@/server/files/errors";
import { jsonObject } from "@/server/auth/http";
import { errorResponse, json, notFound } from "@/server/files/http";
import { getAuthorizedFile } from "@/server/files/request";
import type { TagOperation } from "@/server/files/types";
import {
  parseVisibility,
  validateId,
  validateTags,
} from "@/server/files/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const id = validateId((await context.params).id);
    const { service, file } = await getAuthorizedFile(request, id);
    return json(service.toMetadata(file));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const id = validateId((await context.params).id);
    const { service, principal } = await getAuthorizedFile(request, id, true);
    const record = await jsonObject(request);
    const allowed = new Set(["visibility", "tags", "owner_id"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) {
      throw new AppError(
        400,
        "invalid_patch",
        "Patch contains an unsupported field",
      );
    }

    const visibility =
      record.visibility === undefined
        ? undefined
        : parseVisibility(record.visibility);
    let ownerId: string | undefined;
    if (record.owner_id !== undefined) {
      if (principal.role !== "admin") {
        throw new AppError(
          403,
          "forbidden",
          "Administrator access is required",
        );
      }
      if (typeof record.owner_id !== "string" || !record.owner_id) {
        throw new AppError(400, "invalid_owner", "Owner is required");
      }
      const owner = await service.auth.getUser(record.owner_id);
      if (!owner?.active) {
        throw new AppError(
          400,
          "invalid_owner",
          "Owner must be an active user",
        );
      }
      ownerId = owner.id;
    }
    let tags: { operation: TagOperation; values: string[] } | undefined;
    if (record.tags !== undefined) {
      if (
        !record.tags ||
        typeof record.tags !== "object" ||
        Array.isArray(record.tags)
      ) {
        throw new AppError(
          400,
          "invalid_patch",
          "Tags patch must be an object",
        );
      }
      const tagPatch = record.tags as Record<string, unknown>;
      if (
        Object.keys(tagPatch).some(
          (key) => key !== "operation" && key !== "values",
        ) ||
        (tagPatch.operation !== "add" &&
          tagPatch.operation !== "remove" &&
          tagPatch.operation !== "set") ||
        !Array.isArray(tagPatch.values)
      ) {
        throw new AppError(
          400,
          "invalid_patch",
          "Tags patch requires operation add, remove, or set and a values array",
        );
      }
      tags = {
        operation: tagPatch.operation,
        values: validateTags(tagPatch.values),
      };
    }
    if (!visibility && !tags && !ownerId) {
      throw new AppError(
        400,
        "invalid_patch",
        "Patch must change visibility, ownership, and/or tags",
      );
    }

    const actorUserId = principal.source === "legacy" ? null : principal.userId;
    const file = await service.update(
      id,
      { visibility, tags, ownerId },
      actorUserId,
    );
    if (!file) throw notFound();
    return json(service.toMetadata(file));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const id = validateId((await context.params).id);
    const { service, principal } = await getAuthorizedFile(request, id, true);
    const actorUserId = principal.source === "legacy" ? null : principal.userId;
    const file = await service.delete(id, actorUserId);
    if (!file) throw notFound();
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
