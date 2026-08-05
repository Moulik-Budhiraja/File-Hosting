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
    status: key.status,
    pending_expires_at: key.pendingExpiresAt,
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
      // Optional search applied in SQL before pagination — never a
      // page-local filter.
      const trimmedQuery = params.get("q")?.trim();
      const q =
        trimmedQuery !== undefined && trimmedQuery.length > 0
          ? trimmedQuery
          : undefined;
      const page = await service.auth.listAllApiKeys({
        limit,
        cursor: cursorValue ? decodeApiKeyCursor(cursorValue) : undefined,
        q,
      });
      return json({
        api_keys: page.apiKeys.map(ownedKeyMetadata),
        totals: page.totals,
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
    const actorUserId = principal.source === "legacy" ? null : principal.userId;
    if (typeof body.request_id === "string") {
      // Two-phase browser protocol: phase 1 commits a PENDING key under
      // the idempotency request id. Retries reconcile truthfully and
      // never re-expose the plaintext secret.
      const begun = await service.auth.beginApiKeyCreation(
        userId,
        body.name,
        body.request_id,
        new Date(),
        actorUserId,
      );
      return json(
        {
          api_key: {
            id: begun.id,
            name: begun.name,
            secret: begun.secret,
            status: begun.status,
            pending_expires_at: begun.pendingExpiresAt,
            created: begun.created,
          },
        },
        { status: begun.created ? 201 : 200 },
      );
    }
    // One-step creation is preserved ONLY for non-browser bearer callers
    // (CLI, legacy service credential): the key is active immediately.
    // Cookie-session (browser) callers must use the two-phase protocol so
    // a lost response can never leave an active unrecoverable secret.
    if (principal.source === "session") {
      throw new AppError(
        400,
        "request_id_required",
        "Browser sessions must create API keys with a request_id (two-phase flow)",
      );
    }
    const created = await service.auth.createApiKey(
      userId,
      body.name,
      new Date(),
      actorUserId,
    );
    return json(
      { api_key: { id: created.id, secret: created.secret } },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
