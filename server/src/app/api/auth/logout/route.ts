import {
  assertCsrf,
  cookieValue,
  requirePrincipal,
  SESSION_COOKIE,
} from "@/server/auth/http";
import { errorResponse } from "@/server/files/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const { service, principal } = await requirePrincipal(request);
    assertCsrf(request, service, principal);
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) await service.auth.revokeSession(token);
    const secure =
      process.env.NODE_ENV === "production" ||
      new URL(service.config.publicUrl).protocol === "https:";
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
