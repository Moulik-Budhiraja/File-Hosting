import { assertCsrf, requirePrincipal } from "@/server/auth/http";
import { AppError } from "@/server/files/errors";
import { errorResponse, json } from "@/server/files/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 2 of browser key creation: activate a pending key only after the
// client confirmed it received the show-once secret. Idempotent, so a
// lost activation response reconciles on retry.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { service, principal } = await requirePrincipal(request);
    assertCsrf(request, service, principal);
    const { id } = await context.params;
    const isAdmin = principal.role === "admin";
    if (!principal.userId && !isAdmin) {
      throw new AppError(401, "unauthorized", "A user identity is required");
    }
    // Admin actors (including the legacy service credential) may activate
    // any pending key; members only their own.
    const activated = await service.auth.activateApiKey(
      id,
      principal.userId ?? "",
      isAdmin,
    );
    return json({ api_key: activated });
  } catch (error) {
    return errorResponse(error);
  }
}
