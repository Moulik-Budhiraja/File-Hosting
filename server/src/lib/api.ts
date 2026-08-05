export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly hasErrorEnvelope: boolean,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  skipUnauthorizedHandler?: boolean;
}

type UnauthorizedHandler = () => void;

const unauthorizedHandlers = new Set<UnauthorizedHandler>();
const forbiddenHandlers = new Set<UnauthorizedHandler>();

export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);
  return () => unauthorizedHandlers.delete(handler);
}

// A 403 on a session request is authoritative evidence of role drift
// (e.g. this admin was demoted in another tab). Subscribers refresh the
// identity before rendering any further privileged UI.
export function onForbidden(handler: UnauthorizedHandler): () => void {
  forbiddenHandlers.add(handler);
  return () => forbiddenHandlers.delete(handler);
}

// Lets non-JSON call sites (streamed uploads) route their 401s through the
// same session-expiry flow as apiFetch.
export function notifyUnauthorized(): void {
  for (const handler of unauthorizedHandlers) handler();
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export async function apiFetch<T = unknown>(
  url: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "same-origin",
    signal: options.signal,
  };
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    let code = "internal_error";
    let message = "The server could not complete the request";
    let hasErrorEnvelope = false;
    try {
      const payload = (await response.json()) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (
        typeof payload.error?.code === "string" &&
        typeof payload.error?.message === "string"
      ) {
        hasErrorEnvelope = true;
        code = payload.error.code;
        message = payload.error.message;
      }
    } catch {
      // Non-JSON error bodies keep the generic mapping.
    }
    if (response.status === 401 && !options.skipUnauthorizedHandler) {
      for (const handler of unauthorizedHandlers) handler();
    }
    if (response.status === 403) {
      for (const handler of forbiddenHandlers) handler();
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const retryAfterSeconds =
      Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 86_400
        ? retryAfter
        : null;
    throw new ApiError(
      response.status,
      code,
      message,
      hasErrorEnvelope,
      retryAfterSeconds,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
