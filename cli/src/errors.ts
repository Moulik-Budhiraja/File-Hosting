export const EXIT = {
  success: 0,
  general: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  conflict: 5,
  network: 6,
  approval: 7,
  partial: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode = EXIT.general,
    public readonly code = "CLI_ERROR",
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError(error instanceof Error ? error.message : String(error));
}
