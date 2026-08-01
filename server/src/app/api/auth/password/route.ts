import { assertCsrf, jsonObject, requirePrincipal } from "@/server/auth/http";
import { AppError } from "@/server/files/errors";
import { errorResponse } from "@/server/files/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const { service, principal } = await requirePrincipal(request);
    assertCsrf(request, service, principal);
    if (!principal.userId) {
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
    await service.auth.changePassword(
      principal.userId,
      body.current_password,
      body.new_password,
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
