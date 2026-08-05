import {
  assertCsrf,
  jsonObject,
  publicUser,
  requireAdmin,
} from "@/server/auth/http";
import { validatePassword } from "@/server/auth/password";
import { AppError } from "@/server/files/errors";
import { errorResponse, json } from "@/server/files/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { service, principal } = await requireAdmin(request);
    assertCsrf(request, service, principal);
    const id = (await context.params).id;
    const body = await jsonObject(request);
    const allowed = new Set(["role", "active", "password", "request_id"]);
    if (
      Object.keys(body).length === 0 ||
      Object.keys(body).some((key) => !allowed.has(key))
    ) {
      throw new AppError(
        400,
        "invalid_user_patch",
        "Patch may contain role, active, password, and request_id",
      );
    }
    if (body.request_id !== undefined && typeof body.request_id !== "string") {
      throw new AppError(
        400,
        "invalid_request_id",
        "request_id must be a string",
      );
    }
    if (body.request_id !== undefined && body.password === undefined) {
      throw new AppError(
        400,
        "invalid_user_patch",
        "request_id applies only to password resets",
      );
    }
    const mutations = [body.role, body.active, body.password].filter(
      (value) => value !== undefined,
    );
    if (mutations.length !== 1) {
      throw new AppError(
        400,
        "invalid_user_patch",
        "Patch must contain exactly one user change",
      );
    }
    if (
      body.role !== undefined &&
      body.role !== "admin" &&
      body.role !== "member"
    ) {
      throw new AppError(400, "invalid_role", "Role must be admin or member");
    }
    if (body.active !== undefined && typeof body.active !== "boolean") {
      throw new AppError(400, "invalid_active", "Active must be a boolean");
    }
    if (body.password !== undefined && typeof body.password !== "string") {
      throw new AppError(400, "invalid_password", "Password must be a string");
    }
    if (typeof body.password === "string") validatePassword(body.password);

    let user = await service.auth.getUser(id);
    if (!user) throw new AppError(404, "user_not_found", "User not found");
    const actorUserId = principal.source === "legacy" ? null : principal.userId;
    if (body.role === "admin" || body.role === "member") {
      user = await service.auth.setRole(id, body.role, actorUserId);
    }
    if (typeof body.active === "boolean") {
      user = await service.auth.setActive(id, body.active, actorUserId);
    }
    if (typeof body.password === "string") {
      if (typeof body.request_id === "string") {
        // Idempotent reset: the candidate password applies exactly once
        // per request id; a retry after a lost response reconciles
        // without generating or re-applying another password.
        const outcome = await service.auth.resetPasswordIdempotent(
          id,
          body.password,
          principal.source === "legacy" ? null : principal.userId,
          body.request_id,
        );
        return json({
          user: publicUser(outcome.user),
          password_applied: outcome.applied,
        });
      }
      user = await service.auth.setPassword(
        id,
        body.password,
        new Date(),
        undefined,
        actorUserId,
      );
    }
    return json({ user: publicUser(user) });
  } catch (error) {
    return errorResponse(error);
  }
}
