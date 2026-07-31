// 64-symbol URL-safe alphabet: 6 bits per character. 256 % 64 === 0, so
// masking a uniform byte to 6 bits is exactly uniform — no modulo bias.
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const TEMP_PASSWORD_LENGTH = 22;

// 22 characters × 6 bits = 132 bits of entropy, above the 128-bit target
// and well under the 72-UTF-8-byte backend limit (all symbols are ASCII).
export const TEMP_PASSWORD_ENTROPY_BITS = TEMP_PASSWORD_LENGTH * 6;

// Generates a shown-once temporary credential. The value is uniform over
// 64^22 possibilities; nothing about expiry or forced rotation is implied
// because the backend implements neither.
export function generateTempPassword(): string {
  const bytes = new Uint8Array(TEMP_PASSWORD_LENGTH);
  crypto.getRandomValues(bytes);
  let password = "";
  for (const byte of bytes) {
    password += ALPHABET[byte & 63]!;
  }
  return password;
}
