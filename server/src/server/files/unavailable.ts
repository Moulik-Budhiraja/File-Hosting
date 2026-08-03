import { readFile } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://files.moulik.dev";
const IMAGE_URL = `${ORIGIN}/og/0000000.png`;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGE = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:site_name" content="File-Hosting">
<meta property="og:title" content="File unavailable">
<meta property="og:description" content="Preview unavailable">
<meta property="og:type" content="website">
<meta property="og:url" content="${ORIGIN}">
<meta property="og:image" content="${IMAGE_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="File unavailable">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="File unavailable">
<meta name="twitter:description" content="Preview unavailable">
<meta name="twitter:image" content="${IMAGE_URL}">
<meta name="twitter:image:alt" content="File unavailable">
<link rel="canonical" href="${ORIGIN}">
<title>File unavailable</title></head><body><main><h1>File unavailable</h1><p>Preview unavailable</p><p>files.moulik.dev</p></main></body></html>`);
let imagePromise: Promise<Buffer> | undefined;

function commonHeaders(contentType: string, length: number): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-length": String(length),
    "content-security-policy": CSP,
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

export function unavailablePageResponse(includeBody: boolean): Response {
  return new Response(includeBody ? new Uint8Array(PAGE) : null, {
    status: 200,
    headers: commonHeaders("text/html; charset=utf-8", PAGE.length),
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
