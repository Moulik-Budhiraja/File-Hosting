import { AppError, isAppError } from "./errors";

export function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

// A client tearing down its own request mid-stream is ordinary behaviour
// (cancelled upload, closed tab, dropped connection) — expected cancellation,
// not a server fault.
export function isClientAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ECONNRESET" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "UND_ERR_ABORTED" ||
    error.message === "aborted"
  );
}

export function errorResponse(error: unknown): Response {
  if (isAppError(error)) {
    return json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (isClientAbortError(error)) {
    // Structured info, never error-level: the response below is a formality
    // the disconnected client will not read.
    console.info(
      JSON.stringify({
        level: "info",
        event: "client_aborted",
        message: (error as Error).message,
      }),
    );
    return json(
      {
        error: {
          code: "client_aborted",
          message: "The client aborted the request",
        },
      },
      { status: 400 },
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
