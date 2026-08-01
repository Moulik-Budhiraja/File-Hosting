import {
  authenticate,
  assertCsrf,
  cookieValue,
  SESSION_COOKIE,
} from "@/server/auth/http";
import { AppError } from "@/server/files/errors";
import { errorResponse } from "@/server/files/http";
import { getFileService } from "@/server/files/singleton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const service = await getFileService();
    const token = cookieValue(request, SESSION_COOKIE);
    const hasSessionCookie = (request.headers.get("cookie") ?? "")
      .split(";")
      .some((part) => part.trim().split("=", 1)[0] === SESSION_COOKIE);
    const principal = await authenticate(request, service);
    if (principal) assertCsrf(request, service, principal);
    else if (hasSessionCookie) assertCsrf(request, service);
    else
      throw new AppError(
        401,
        "unauthorized",
        "A valid bearer token is required",
      );
    if (token) await service.auth.revokeSession(token);
    const secure = new URL(service.config.publicUrl).protocol === "https:";
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
