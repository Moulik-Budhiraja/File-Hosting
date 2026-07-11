import { createHash, timingSafeEqual } from "node:crypto";

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[\t ]+([^\s]+)$/iu.exec(header);
  return match?.[1] ?? null;
}

export function isAuthorized(request: Request, expectedToken: string): boolean {
  const supplied = extractBearerToken(request) ?? "";
  return timingSafeEqual(tokenDigest(supplied), tokenDigest(expectedToken));
}
