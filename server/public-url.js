export const DEFAULT_PUBLIC_ORIGIN = "http://localhost:3000";

const ORIGIN_INPUT = /^https?:\/\/[^/?#\\]+\/?$/iu;

/**
 * @param {string} value
 * @returns {string}
 */
export function canonicalPublicOrigin(value) {
  let parsed;
  try {
    if (!ORIGIN_INPUT.test(value)) throw new TypeError("invalid origin shape");
    parsed = new URL(value);
  } catch {
    throw new Error("FS_PUBLIC_URL must be a canonical HTTP or HTTPS origin");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/"
  ) {
    throw new Error("FS_PUBLIC_URL must be a canonical HTTP or HTTPS origin");
  }

  return parsed.origin;
}
