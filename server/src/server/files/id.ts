import { randomBytes } from "node:crypto";

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_UNBIASED_BYTE = 248;

export function generateFileId(): string {
  let id = "";
  while (id.length < 7) {
    for (const byte of randomBytes(12)) {
      if (byte >= MAX_UNBIASED_BYTE) continue;
      id += ALPHABET[byte % ALPHABET.length];
      if (id.length === 7) break;
    }
  }
  return id;
}
