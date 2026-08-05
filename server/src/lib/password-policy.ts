// The single client-side home of the password policy. Mirrors the backend
// contract in src/server/auth/password.ts exactly: at least 12 Unicode code
// points and at most 72 UTF-8 bytes (the bcrypt input limit).
export const MIN_PASSWORD_CODE_POINTS = 12;
export const MAX_PASSWORD_UTF8_BYTES = 72;

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: "too-short"; codePoints: number }
  | { ok: false; reason: "too-long"; bytes: number };

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function checkPassword(value: string): PasswordCheck {
  const codePoints = [...value].length;
  if (codePoints < MIN_PASSWORD_CODE_POINTS) {
    return { ok: false, reason: "too-short", codePoints };
  }
  const bytes = utf8ByteLength(value);
  if (bytes > MAX_PASSWORD_UTF8_BYTES) {
    return { ok: false, reason: "too-long", bytes };
  }
  return { ok: true };
}
