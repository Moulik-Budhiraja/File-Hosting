export class AppError extends Error {
  public readonly headers: Headers;

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    options?: ErrorOptions & { headers?: HeadersInit },
  ) {
    super(message, options);
    this.name = "AppError";
    this.headers = new Headers(options?.headers);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
