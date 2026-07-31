import { publicUser, requirePrincipal } from "@/server/auth/http";
import { errorResponse, json } from "@/server/files/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { principal } = await requirePrincipal(request);
    return json({
      user: principal.user ? publicUser(principal.user) : null,
      legacy_service_credential: principal.source === "legacy",
      role: principal.role,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
