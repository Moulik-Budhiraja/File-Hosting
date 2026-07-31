import {
  assertCsrf,
  jsonObject,
  publicUser,
  SESSION_COOKIE,
} from "@/server/auth/http";
import { errorResponse, json } from "@/server/files/http";
import { getFileService } from "@/server/files/singleton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const service = await getFileService();
    assertCsrf(request, service);
    const body = await jsonObject(request);
    if (
      typeof body.username !== "string" ||
      typeof body.password !== "string"
    ) {
      return json(
        {
          error: {
            code: "invalid_credentials",
            message: "Invalid username or password",
          },
        },
        { status: 401 },
      );
    }
    const remoteAddress =
      request.headers.get("x-real-ip") ??
      request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ??
      "unknown";
    const user = await service.auth.authenticatePassword(
      body.username,
      body.password,
      remoteAddress,
    );
    const session = await service.auth.createSession(user.id);
    const secure =
      process.env.NODE_ENV === "production" ||
      new URL(service.config.publicUrl).protocol === "https:";
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000)}${secure ? "; Secure" : ""}`;
    return json(
      { user: publicUser(user), expires_at: session.expiresAt },
      { headers: { "set-cookie": cookie } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
