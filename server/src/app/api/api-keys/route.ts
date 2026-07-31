import {
  decodeApiKeyCursor,
  type ApiKeyMetadata,
  type OwnedApiKeyMetadata,
} from "@/server/auth/database";
import { assertCsrf, jsonObject, requirePrincipal } from "@/server/auth/http";
import { AppError } from "@/server/files/errors";
import { errorResponse, json } from "@/server/files/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function keyMetadata(key: ApiKeyMetadata) {
  return {
    id: key.id,
    user_id: key.userId,
    name: key.name,
    prefix: key.prefix,
    last_four: key.lastFour,
    created_at: key.createdAt,
    last_used_at: key.lastUsedAt,
    revoked_at: key.revokedAt,
  };
}

const DEFAULT_AGGREGATE_LIMIT = 100;

function ownedKeyMetadata(key: OwnedApiKeyMetadata) {
  return { ...keyMetadata(key), owner_username: key.ownerUsername };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { service, principal } = await requirePrincipal(request);
    const params = new URL(request.url).searchParams;
    if (params.get("scope") === "all") {
      // Aggregate admin view: one paginated SQL join instead of a
      // per-user fan-out; includes owner identity.
      if (principal.role !== "admin") {
        throw new AppError(
          403,
          "forbidden",
          "Administrator access is required",
        );
      }
      const rawLimit = Number(params.get("limit") ?? DEFAULT_AGGREGATE_LIMIT);
      const limit =
        Number.isSafeInteger(rawLimit) && rawLimit > 0
          ? rawLimit
          : DEFAULT_AGGREGATE_LIMIT;
      const cursorValue = params.get("cursor");
      const page = await service.auth.listAllApiKeys({
        limit,
        cursor: cursorValue ? decodeApiKeyCursor(cursorValue) : undefined,
      });
      return json({
        api_keys: page.apiKeys.map(ownedKeyMetadata),
        next_cursor: page.nextCursor,
      });
    }
    const requestedUser = params.get("user_id");
    const userId =
      principal.role === "admin"
        ? (requestedUser ?? principal.userId ?? undefined)
        : principal.userId!;
    return json({
      api_keys: (await service.auth.listApiKeys(userId)).map(keyMetadata),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { service, principal } = await requirePrincipal(request);
    assertCsrf(request, service, principal);
    const body = await jsonObject(request);
    if (typeof body.name !== "string")
      throw new AppError(
        400,
        "invalid_api_key_name",
        "API key name is required",
      );
    const requestedUser =
      typeof body.user_id === "string" ? body.user_id : null;
    if (
      principal.role !== "admin" &&
      requestedUser &&
      requestedUser !== principal.userId
    ) {
      throw new AppError(
        403,
        "forbidden",
        "Users may create API keys only for themselves",
      );
    }
    const userId =
      principal.role === "admin"
        ? (requestedUser ?? principal.userId)
        : principal.userId;
    if (!userId)
      throw new AppError(
        400,
        "user_id_required",
        "user_id is required for the legacy service credential",
      );
    const created = await service.auth.createApiKey(userId, body.name);
    return json(
      { api_key: { id: created.id, secret: created.secret } },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
