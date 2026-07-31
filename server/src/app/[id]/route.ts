import { AppError } from "@/server/files/errors";
import { errorResponse } from "@/server/files/http";
import { renderPreview } from "@/server/files/preview";
import { getViewableFile } from "@/server/files/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// One constant body for every not-found outcome — missing id, private
// without access, protected without a session — so the branded page keeps
// the exact status/body indistinguishability the privacy model requires.
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fs-server</title>
<style>
body{margin:0;display:grid;place-items:center;min-height:100vh;background:#101214;color:#E8EAED;font:14px/20px ui-sans-serif,system-ui,sans-serif}
main{max-width:420px;padding:24px;text-align:center}
.code{font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.09em;color:#6E7880}
h1{font-size:16px;font-weight:600;margin:8px 0}
p{color:#A9B1B9;margin:0}
</style>
</head>
<body>
<main>
<p class="code">404 · NOT FOUND</p>
<h1>This link doesn't exist or you don't have access.</h1>
<p>If someone shared it with you, ask them to check the visibility — or sign in.</p>
</main>
</body>
</html>
`;

function brandedNotFound(): Response {
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { service, file } = await getViewableFile(
      request,
      (await context.params).id,
    );
    const html = await renderPreview(service, file);
    return new Response(html, {
      headers: {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      return brandedNotFound();
    }
    return errorResponse(error);
  }
}
