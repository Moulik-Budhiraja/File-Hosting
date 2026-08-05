import {
  assertCsrf,
  jsonObject,
  requirePrincipal,
  sessionCookieHeader,
} from "@/server/auth/http";
import { AppError } from "@/server/files/errors";
import { errorResponse, json } from "@/server/files/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const { service, principal } = await requirePrincipal(request);
    assertCsrf(request, service, principal);
    if (!principal.userId || !principal.sessionToken) {
      throw new AppError(
        400,
        "user_session_required",
        "A user credential is required",
      );
    }
    const body = await jsonObject(request);
    if (
      typeof body.current_password !== "string" ||
      typeof body.new_password !== "string"
    ) {
      throw new AppError(
        400,
        "invalid_password_change",
        "Current and new passwords are required",
      );
    }
    const rotated = await service.auth.changePasswordAndRotateSession(
      principal.userId,
      body.current_password,
      body.new_password,
      principal.sessionToken,
    );
    const maxAge = Math.floor(
      (Date.parse(rotated.expiresAt) - Date.now()) / 1000,
    );
    const cookie = sessionCookieHeader(
      service.config.publicUrl,
      rotated.token,
      maxAge,
    );
    return json(
      { expires_at: rotated.expiresAt },
      { headers: { "set-cookie": cookie } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
