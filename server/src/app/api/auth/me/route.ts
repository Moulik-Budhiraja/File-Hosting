import { publicUser, requirePrincipal } from "@/server/auth/http";
import { errorResponse, json } from "@/server/files/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    // Probe semantics are selected by this dedicated endpoint mode, never by
    // forwarding/client headers. Pure identity polling validates the session
    // without claiming user activity; every ordinary request remains sliding.
    const probe = new URL(request.url).searchParams.get("probe") === "1";
    const { service, principal } = await requirePrincipal(request, {
      slideSession: !probe,
    });
    const session = principal.sessionToken
      ? await service.auth.sessionInfo(principal.sessionToken)
      : null;
    return json({
      user: principal.user ? publicUser(principal.user) : null,
      legacy_service_credential: principal.source === "legacy",
      role: principal.role,
      session: session
        ? {
            created_at: session.createdAt,
            last_seen_at: session.lastSeenAt,
            idle_expires_at: session.idleExpiresAt,
            expires_at: session.expiresAt,
          }
        : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
