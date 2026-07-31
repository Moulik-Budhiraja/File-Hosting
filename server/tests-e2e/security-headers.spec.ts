import { expect, test } from "@playwright/test";

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

test("app routes carry CSP frame-ancestors, XFO DENY, nosniff, referrer and permissions policies", async ({
  request,
}) => {
  for (const route of APP_ROUTES) {
    const response = await request.get(route, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    const headers = response.headers();
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
  }
});

test("API routes carry nosniff and framing denial", async ({ request }) => {
  const response = await request.get("/api/auth/me", {
    failOnStatusCode: false,
  });
  const headers = response.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-powered-by"]).toBeUndefined();
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
  expect(raw.headers()["x-content-type-options"]).toBe("nosniff");
  expect(raw.headers()["cache-control"]).toBe("no-store");
  // Raw plain-text responses must NOT inherit the app-shell CSP — the
  // preview iframe depends on the existing per-route policy.
  expect(raw.headers()["x-frame-options"]).toBeUndefined();

  const preview = await request.get(`/${file.id}`);
  expect(preview.status()).toBe(200);
  expect(preview.headers()["content-security-policy"]).toContain(
    "frame-src 'self'",
  );
  expect(preview.headers()["referrer-policy"]).toBe("no-referrer");
});

test("the authenticated app cannot be framed", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  // Sanity: the app itself renders for this session.
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();

  // An attacker page embedding the console must get a blocked frame.
  await page.goto("about:blank");
  await page.setContent(
    `<iframe id="target" src="${baseURL}/files" width="800" height="600"></iframe>`,
  );
  await page.waitForTimeout(1500);
  const frameRendered = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#target");
    try {
      return Boolean(frame?.contentDocument?.body?.innerText.includes("Files"));
    } catch {
      return false;
    }
  });
  expect(frameRendered).toBe(false);
});
