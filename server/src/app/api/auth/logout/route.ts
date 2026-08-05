import {
  authenticate,
  assertCsrf,
  sessionCookieHeader,
  sessionCookieName,
  sessionCookieValue,
} from "@/server/auth/http";
import { AppError } from "@/server/files/errors";
import { errorResponse } from "@/server/files/http";
import { getFileService } from "@/server/files/singleton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const service = await getFileService();
    const cookieName = sessionCookieName(service.config.publicUrl);
    const token = sessionCookieValue(request, service.config.publicUrl);
    const hasSessionCookie = (request.headers.get("cookie") ?? "")
      .split(";")
      .some((part) => part.trim().split("=", 1)[0] === cookieName);
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
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": sessionCookieHeader(service.config.publicUrl, "", 0),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
