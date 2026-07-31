import {
  assertCsrf,
  jsonObject,
  publicUser,
  requireAdmin,
} from "@/server/auth/http";
import { AppError } from "@/server/files/errors";
import { errorResponse, json } from "@/server/files/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { service } = await requireAdmin(request);
    return json({ users: (await service.auth.listUsers()).map(publicUser) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { service, principal } = await requireAdmin(request);
    assertCsrf(request, service, principal);
    const body = await jsonObject(request);
    if (
      typeof body.username !== "string" ||
      typeof body.password !== "string" ||
      (body.role !== "admin" && body.role !== "member")
    ) {
      throw new AppError(
        400,
        "invalid_user",
        "Username, password, and role are required",
      );
    }
    const user = await service.auth.createUser(
      {
        username: body.username,
        password: body.password,
        role: body.role,
      },
      principal.source === "legacy"
        ? undefined
        : (principal.userId ?? undefined),
    );
    return json({ user: publicUser(user) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
