export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
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

export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);
  return () => unauthorizedHandlers.delete(handler);
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
    try {
      const payload = (await response.json()) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (typeof payload.error?.code === "string") code = payload.error.code;
      if (typeof payload.error?.message === "string") {
        message = payload.error.message;
      }
    } catch {
      // Non-JSON error bodies keep the generic mapping.
    }
    if (response.status === 401 && !options.skipUnauthorizedHandler) {
      for (const handler of unauthorizedHandlers) handler();
    }
    throw new ApiError(response.status, code, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
