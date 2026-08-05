import { AppError, isAppError } from "./errors";

export function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (isAppError(error)) {
    return json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: error.headers },
    );
  }
  console.error("Unhandled request error", error);
  return json(
    {
      error: {
        code: "internal_error",
        message: "An internal server error occurred",
      },
    },
    { status: 500 },
  );
}

export function unauthorized(): AppError {
  return new AppError(401, "unauthorized", "A valid bearer token is required");
}

export function notFound(): AppError {
  return new AppError(404, "not_found", "File not found");
}
