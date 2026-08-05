import { readFile } from "node:fs/promises";
import path from "node:path";

const FALLBACK_ORIGIN = "https://files.moulik.dev";
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const pageCache = new Map<string, Buffer>();

function unavailablePage(publicUrl?: string): Buffer {
  const configured = publicUrl ?? process.env.FS_PUBLIC_URL ?? FALLBACK_ORIGIN;
  const origin = new URL(configured).origin;
  const imageUrl = `${origin}/og/0000000.png`;
  const cached = pageCache.get(origin);
  if (cached) return cached;
  const page = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta property="og:site_name" content="File-Hosting">
<meta property="og:title" content="File unavailable">
<meta property="og:description" content="Preview unavailable">
<meta property="og:type" content="website">
<meta property="og:url" content="${origin}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="File unavailable">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="File unavailable">
<meta name="twitter:description" content="Preview unavailable">
<meta name="twitter:image" content="${imageUrl}">
<meta name="twitter:image:alt" content="File unavailable">
<link rel="canonical" href="${origin}">
<title>File unavailable</title><style>
body{margin:0;display:grid;place-items:center;min-height:100vh;background:#101214;color:#E8EAED;font:14px/20px ui-sans-serif,system-ui,sans-serif}
main{max-width:420px;padding:24px;text-align:center}
.brand{font-weight:600;color:#E8EAED;margin:0 0 20px}
.code{font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.09em;color:#828C94}
h1{font-size:16px;font-weight:600;margin:8px 0}
p{color:#A9B1B9;margin:0}
a{display:inline-block;margin-top:20px;padding:8px 14px;border:1px solid #394047;border-radius:6px;color:#E8EAED;text-decoration:none}
a:focus-visible{outline:2px solid #E8EAED;outline-offset:2px}
</style></head><body><main><p class="brand">fs-server</p><p class="code">404 · NOT FOUND</p><h1>This link doesn't exist or you don't have access.</h1><a href="/login?next=referrer">Sign in</a></main></body></html>`);
  pageCache.set(origin, page);
  return page;
}
let imagePromise: Promise<Buffer> | undefined;
export const UNAVAILABLE_TIMING_FLOOR_MS = 2_350;

export async function settleUnavailableTiming(
  startedAt: number,
): Promise<void> {
  const remaining =
    UNAVAILABLE_TIMING_FLOOR_MS - (performance.now() - startedAt);
  if (remaining > 0)
    await new Promise((resolve) => setTimeout(resolve, remaining));
}

function commonHeaders(contentType: string, length: number): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-length": String(length),
    "content-security-policy": CSP,
    "content-type": contentType,
    date: "Thu, 01 Jan 1970 00:00:00 GMT",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-content-type-options": "nosniff",
  });
}

export function unavailablePageResponse(
  includeBody: boolean,
  publicUrl?: string,
): Response {
  const page = unavailablePage(publicUrl);
  const headers = commonHeaders("text/html; charset=utf-8", page.length);
  // Preserve only a same-origin recovery path. Cross-origin requests still
  // receive no path-bearing referrer data.
  headers.set("referrer-policy", "same-origin");
  return new Response(includeBody ? new Uint8Array(page) : null, {
    status: 200,
    headers,
  });
}

export async function unavailableImageResponse(
  includeBody: boolean,
): Promise<Response> {
  imagePromise ??= readFile(
    path.resolve(process.cwd(), "runtime/assets/unavailable.png"),
  );
  const image = await imagePromise;
  return new Response(includeBody ? new Uint8Array(image) : null, {
    status: 200,
    headers: commonHeaders("image/png", image.length),
  });
}
