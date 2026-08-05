import { expect, test, type APIResponse } from "@playwright/test";

import {
  ADMIN,
  createApiKeyFor,
  ensureUser,
  signInContext,
  uploadFile,
} from "./helpers";

// P2-10 regression: the app shell needs defensive headers without
// weakening the file-serving routes' route-specific policies.

const APP_ROUTES = ["/login", "/files", "/users", "/keys", "/account", "/"];
const EXPECTED_HSTS = "max-age=31536000; includeSubDomains";
const EXPECT_HSTS = process.env.E2E_PUBLIC_URL?.startsWith("https://") ?? false;

function expectTransportSecurity(response: APIResponse, label: string) {
  const actual = response.headers()["strict-transport-security"];
  if (EXPECT_HSTS) {
    expect.soft(actual, `${label} HSTS`).toBe(EXPECTED_HSTS);
  } else {
    expect.soft(actual, `${label} HSTS`).toBeUndefined();
  }
}

async function expectSingleHeader(
  response: {
    headersArray():
      | Array<{ name: string; value: string }>
      | Promise<Array<{ name: string; value: string }>>;
  },
  name: string,
  expectedValue?: string,
) {
  const matches = (await response.headersArray()).filter(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  );
  expect(matches, `${name} header count`).toHaveLength(1);
  if (expectedValue !== undefined) {
    expect(matches[0]?.value).toBe(expectedValue);
  }
}

function minimalPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let body = "%PDF-1.4\n%âãÏÓ\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("app routes carry CSP frame-ancestors, XFO DENY, nosniff, referrer and permissions policies", async ({
  request,
}) => {
  for (const route of APP_ROUTES) {
    const response = await request.get(route, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    const headers = response.headers();
    expectTransportSecurity(response, route);
    expect
      .soft(headers["content-security-policy"], `${route} CSP`)
      .toContain("frame-ancestors 'none'");
    expect.soft(headers["x-frame-options"], `${route} XFO`).toBe("DENY");
    expect
      .soft(headers["x-content-type-options"], `${route} nosniff`)
      .toBe("nosniff");
    expect
      .soft(headers["referrer-policy"], `${route} referrer`)
      .toBe("strict-origin-when-cross-origin");
    expect
      .soft(headers["permissions-policy"], `${route} permissions`)
      .toContain("camera=()");
    expect
      .soft(headers["x-powered-by"], `${route} x-powered-by`)
      .toBeUndefined();
    await expectSingleHeader(response, "content-security-policy");
    await expectSingleHeader(response, "x-frame-options", "DENY");
  }
});

test("API routes carry nosniff and framing denial", async ({ request }) => {
  const response = await request.get("/api/auth/me", {
    failOnStatusCode: false,
  });
  const headers = response.headers();
  expectTransportSecurity(response, "/api/auth/me");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-powered-by"]).toBeUndefined();
  await expectSingleHeader(response, "content-security-policy");
  await expectSingleHeader(response, "x-frame-options", "DENY");
});

test("nested app and arbitrary Next fallbacks keep their intended header policies", async ({
  request,
}) => {
  const nestedApp = await request.get("/files/nested/security-probe", {
    failOnStatusCode: false,
  });
  expect(nestedApp.status()).toBe(404);
  expectTransportSecurity(nestedApp, "nested app 404");
  expect(nestedApp.headers()["x-content-type-options"]).toBe("nosniff");
  expect(nestedApp.headers()["x-frame-options"]).toBe("DENY");
  expect(nestedApp.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  await expectSingleHeader(nestedApp, "x-frame-options", "DENY");
  await expectSingleHeader(nestedApp, "content-security-policy");

  const arbitrary = await request.get("/arbitrary/next/fallback", {
    failOnStatusCode: false,
  });
  expect(arbitrary.status()).toBe(404);
  expectTransportSecurity(arbitrary, "arbitrary Next 404");
  expect(arbitrary.headers()["x-content-type-options"]).toBe("nosniff");
});

test("raw bad-id JSON errors carry nosniff and framing denial", async ({
  request,
}) => {
  const response = await request.get("/raw/badid7x", {
    failOnStatusCode: false,
  });
  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expectTransportSecurity(response, "raw bad-id 404");
  await expectSingleHeader(response, "x-frame-options", "DENY");
  expect(response.headers()["content-security-policy"]).toBe(
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
});

test("raw and preview file routes keep their route-specific policies", async ({
  request,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "headers-owner", "member");
  const bearer = await createApiKeyFor(baseURL!, owner.id, "headers-key");
  const file = await uploadFile(baseURL!, bearer, "headers.txt", "public");

  const raw = await request.get(`/raw/${file.id}`);
  expect(raw.status()).toBe(200);
  expectTransportSecurity(raw, `/raw/${file.id}`);
  expect(raw.headers()["x-content-type-options"]).toBe("nosniff");
  expect(raw.headers()["cache-control"]).toBe("no-store");
  // Raw plain-text responses must not inherit app-shell framing headers.
  expect(raw.headers()["x-frame-options"]).toBeUndefined();

  const preview = await request.get(`/${file.id}`);
  expect(preview.status()).toBe(200);
  expectTransportSecurity(preview, `/${file.id}`);
  expect(preview.headers()["content-security-policy"]).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  expect(preview.headers()["referrer-policy"]).toBe("no-referrer");
});

test("a real PDF renders as an inline first-page raster while hostile raw framing stays blocked", async ({
  page,
  request,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "pdf-frame-owner", "member");
  const bearer = await createApiKeyFor(baseURL!, owner.id, "pdf-frame-key");
  const pdf = await uploadFile(
    baseURL!,
    bearer,
    "metadata-not-extension.txt",
    "public",
    minimalPdf(),
    "application/pdf",
  );
  const html = await uploadFile(
    baseURL!,
    bearer,
    "attacker.pdf",
    "public",
    "<script>top.location='/files'</script>",
    "text/html",
  );
  const svg = await uploadFile(
    baseURL!,
    bearer,
    "attacker.svg",
    "public",
    '<svg xmlns="http://www.w3.org/2000/svg"><script>top.location="/files"</script></svg>',
    "image/svg+xml",
  );

  await page.goto(`/${pdf.id}`);
  const pdfPreview = page.locator("img.pdf-page-preview");
  await expect(pdfPreview).toBeVisible();
  await expect(pdfPreview).toHaveAttribute("src", /^data:image\/png;base64,/u);
  await expect(pdfPreview).toHaveAttribute(
    "alt",
    "First page of metadata-not-extension.txt",
  );

  const pdfResponse = await request.get(`/raw/${pdf.id}`);
  expect(pdfResponse.status()).toBe(200);
  expect(pdfResponse.headers()["content-type"]).toBe("application/pdf");
  expect(pdfResponse.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'self'",
  );
  expect(pdfResponse.headers()["x-frame-options"]).toBeUndefined();
  await expectSingleHeader(pdfResponse, "content-security-policy");

  for (const file of [html, svg]) {
    const raw = await request.get(`/raw/${file.id}`);
    expect(raw.status()).toBe(200);
    expect(raw.headers()["content-security-policy"]).toBe(
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(raw.headers()["x-content-type-options"]).toBe("nosniff");
    expect(raw.headers()["x-frame-options"]).toBeUndefined();
    expect(raw.headers()["referrer-policy"]).toBe("no-referrer");
    await expectSingleHeader(raw, "content-security-policy");
  }

  async function expectBlockedFrame(rawPath: string) {
    await page.goto("about:blank");
    const target = `${baseURL}${rawPath}`;
    await page.evaluate((src) => {
      const frame = document.createElement("iframe");
      frame.src = src;
      document.body.append(frame);
    }, target);
    await expect(page.locator(`iframe[src="${target}"]`)).toHaveCount(1);
    await page.waitForTimeout(500);
    expect(page.frames().some((frame) => frame.url() === target)).toBe(false);
  }

  await expectBlockedFrame(`/raw/${pdf.id}`);
  await expectBlockedFrame(`/raw/${html.id}`);
  await expectBlockedFrame(`/raw/${svg.id}`);
});

test("the app cannot be framed", async ({ context, page, baseURL }) => {
  const targetPath = EXPECT_HSTS ? "/login" : "/files";
  if (EXPECT_HSTS) {
    await page.goto(targetPath);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } else {
    await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
    // Sanity: the authenticated app itself renders for this session.
    await page.goto(targetPath);
    await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
  }

  // An attacker page embedding the console must get a blocked frame.
  await page.goto("about:blank");
  await page.setContent(
    `<iframe id="target" src="${baseURL}${targetPath}" width="800" height="600"></iframe>`,
  );
  await page.waitForTimeout(1500);
  const frameRendered = await page.evaluate(
    (expectedText) => {
      const frame = document.querySelector<HTMLIFrameElement>("#target");
      try {
        return Boolean(
          frame?.contentDocument?.body?.innerText.includes(expectedText),
        );
      } catch {
        return false;
      }
    },
    EXPECT_HSTS ? "Sign in" : "Files",
  );
  expect(frameRendered).toBe(false);
});
