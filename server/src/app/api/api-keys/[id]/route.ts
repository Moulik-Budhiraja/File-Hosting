import { assertCsrf, requirePrincipal } from "@/server/auth/http";
import { errorResponse } from "@/server/files/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { service, principal } = await requirePrincipal(request);
    assertCsrf(request, service, principal);
    const actorUserId = principal.source === "legacy" ? null : principal.userId;
    await service.auth.revokeApiKey(
      (await context.params).id,
      actorUserId,
      principal.role === "admin",
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
