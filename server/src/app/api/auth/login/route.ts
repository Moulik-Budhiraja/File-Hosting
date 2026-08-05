import {
  assertCsrf,
  jsonObject,
  publicUser,
  sessionCookieHeader,
  trustedClientAddress,
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
    const authentication = await service.auth.authenticatePassword(
      body.username,
      body.password,
      trustedClientAddress(request, service.config),
    );
    const session = await service.auth.createSession(authentication);
    const { user } = authentication;
    const cookie = sessionCookieHeader(
      service.config.publicUrl,
      session.token,
      Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000),
    );
    return json(
      { user: publicUser(user), expires_at: session.expiresAt },
      { headers: { "set-cookie": cookie } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
