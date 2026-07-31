// Regenerates the implementation-pass screenshot set against the real
// standalone production build with synthetic fixtures only.
//
//   npm run build
//   node scripts/capture-screens.mjs /path/to/output-dir
//
// Every state is captured live; shown-once secret values are replaced with
// obvious EXAMPLE placeholders in the DOM before capture.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node scripts/capture-screens.mjs <output-dir>");
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PORT = Number(process.env.CAPTURE_PORT ?? 3957);
const BASE = `http://127.0.0.1:${PORT}`;
const LEGACY = "capture-synthetic-service-token";
const ADMIN = { username: "ops-admin", password: "ops-admin-fixture-pass-12+" };

const dataDir = mkdtempSync(path.join(os.tmpdir(), "fs-capture-"));
const child = spawn(
  process.execPath,
  [path.join(serverRoot, ".next", "standalone", "server.js")],
  {
    stdio: "ignore",
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(PORT),
      FS_TOKEN: LEGACY,
      FS_PUBLIC_URL: BASE,
      DATABASE_URL: `file:${path.join(dataDir, "files.db")}`,
      FS_STORAGE_DIR: path.join(dataDir, "objects"),
      FS_BOOTSTRAP_USERNAME: ADMIN.username,
      FS_BOOTSTRAP_PASSWORD: ADMIN.password,
    },
  },
);

process.on("uncaughtException", (error) => {
  console.error(error);
  child.kill("SIGTERM");
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error(error);
  child.kill("SIGTERM");
  process.exit(1);
});

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server did not become healthy");
}

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.77.0.${ipCounter}`;
}

async function api(pathname, { method = "GET", body, bearer, cookie } = {}) {
  const headers = { origin: BASE, "x-real-ip": nextIp() };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined && typeof body !== "string") {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
  return response;
}

async function loginCookie(username, password) {
  const response = await api("/api/auth/login", {
    method: "POST",
    body: { username, password },
  });
  if (response.status !== 200) {
    throw new Error(`login ${username}: ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /fs_session=([^;]+)/u.exec(setCookie);
  return `fs_session=${match[1]}`;
}

await waitForServer();

// ---- synthetic fixtures (Paper-adjacent names, throwaway secrets) ----
const users = {};
for (const [username, role] of [
  ["sam-ops", "member"],
  ["priya.k", "member"],
  ["intern-2025", "member"],
]) {
  const response = await api("/api/users", {
    method: "POST",
    bearer: LEGACY,
    body: { username, password: `${username}-fixture-pass-12+`, role },
  });
  if (response.status !== 201) {
    throw new Error(
      `create ${username}: ${response.status} ${await response.text()}`,
    );
  }
  users[username] = (await response.json()).user;
}
await api(`/api/users/${users["intern-2025"].id}`, {
  method: "PATCH",
  bearer: LEGACY,
  body: { active: false },
});

async function makeKey(userId, name) {
  const response = await api("/api/api-keys", {
    method: "POST",
    bearer: LEGACY,
    body: { name, user_id: userId },
  });
  return (await response.json()).api_key;
}

const adminList = await api("/api/users", { bearer: LEGACY });
const adminUser = (await adminList.json()).users.find(
  (entry) => entry.username === ADMIN.username,
);

await makeKey(adminUser.id, "laptop-mbp");
const samKeyA = await makeKey(users["sam-ops"].id, "ingest-pipeline");
await makeKey(users["sam-ops"].id, "batch-loader");
const samOld = await makeKey(users["sam-ops"].id, "old-desktop");
await api(`/api/api-keys/${samOld.id}`, { method: "DELETE", bearer: LEGACY });

async function upload(bearer, name, visibility, content) {
  const response = await api(
    `/api/files?name=${encodeURIComponent(name)}&visibility=${visibility}`,
    { method: "POST", bearer, body: content ?? `synthetic bytes for ${name}` },
  );
  if (response.status !== 201) {
    throw new Error(`upload ${name}: ${response.status} ${await response.text()}`);
  }
}

const samBearer = samKeyA.secret;
const adminKey = await makeKey(adminUser.id, "capture-admin-key");
await upload(adminKey.secret, "keynote-2026-poster.png", "public");
await upload(samBearer, "telemetry-batch-0412.parquet", "private");
await upload(adminKey.secret, "api-reference-v3.pdf", "protected");
await upload(samBearer, "geo-tiles-eu-west.mbtiles", "protected");
await upload(adminKey.secret, "onboarding-runbook.md", "public");
await upload(samBearer, "sampler-config.yaml", "private");

const adminCookie = await loginCookie(ADMIN.username, ADMIN.password);
const samCookie = await loginCookie("sam-ops", "sam-ops-fixture-pass-12+");

// ---- browser ----
const browser = await chromium.launch();

async function newPage(viewport, cookie) {
  const context = await browser.newContext({ viewport });
  if (cookie) {
    const [name, value] = cookie.split("=");
    await context.addCookies([
      { name, value, url: BASE, httpOnly: true, sameSite: "Strict" },
    ]);
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("fs.session-active", "1");
      } catch {
        /* ignore */
      }
    });
  }
  const page = await context.newPage();
  return { context, page };
}

async function capture(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    fullPage: false,
  });
  console.log(`captured ${name}`);
}

async function maskSecret(page, placeholder) {
  await page.evaluate((value) => {
    for (const element of document.querySelectorAll(".secret-value")) {
      element.textContent = value;
    }
  }, placeholder);
}

const DESKTOP = { width: 1440, height: 960 };
const MOBILE = { width: 390, height: 844 };

// ---- desktop: login states ----
{
  const { context, page } = await newPage(DESKTOP);
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Username").click();
  await capture(page, "desktop-login-default-1440x960");

  await page.route("**/api/auth/login", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-real-ip": nextIp() },
    }),
  );
  await page.getByLabel("Username").fill("ops-admin");
  await page.getByLabel("Password").fill("wrong password fixture");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Username or password is incorrect.").waitFor();
  await capture(page, "desktop-login-invalid-1440x960");

  await page.evaluate(() => {
    window.localStorage.setItem("fs.last-username", "ops-admin");
  });
  await page.goto(`${BASE}/login?expired=1`);
  await page.getByText(/session expired/i).waitFor();
  await capture(page, "desktop-login-session-expired-1440x960");
  await context.close();
}

// ---- desktop: users ----
{
  const { context, page } = await newPage(DESKTOP, adminCookie);
  await page.goto(`${BASE}/users`);
  await page.getByRole("button", { name: "sam-ops", exact: true }).waitFor();
  await capture(page, "desktop-users-directory-1440x960");

  await page.getByRole("button", { name: "sam-ops", exact: true }).click();
  await page.getByRole("heading", { name: /sam-ops/ }).waitFor();
  await capture(page, "desktop-users-detail-1440x960");

  await page.getByRole("button", { name: "New user" }).click();
  const usernameField = page
    .getByRole("dialog")
    .getByLabel("Username", { exact: true });
  await usernameField.fill("nadia.r");
  await capture(page, "desktop-users-create-dialog-1440x960");

  await usernameField.fill("sam-ops");
  await page.getByRole("button", { name: "Create user" }).click();
  await page.getByText("That username is already taken.").waitFor();
  await capture(page, "desktop-users-create-conflict-1440x960");

  await usernameField.fill("nadia.r");
  await page.getByRole("button", { name: "Create user" }).click();
  await page.locator(".secret-value").waitFor();
  await maskSecret(page, "EXAMPLE-not-a-real-secret-0");
  await capture(page, "desktop-users-temp-password-once-1440x960");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Done" }).click();

  // Selection is a toggle; make sure sam-ops ends up selected.
  await page.getByRole("button", { name: "priya.k", exact: true }).click();
  await page.getByRole("button", { name: "sam-ops", exact: true }).click();
  await page.getByRole("button", { name: "Disable account…" }).click();
  await page.getByRole("dialog").waitFor();
  await capture(page, "desktop-users-disable-confirm-1440x960");
  await page.keyboard.press("Escape");

  // Last-active-admin conflict: attempt to demote the only active admin.
  await page.getByRole("button", { name: /ops-admin · you/ }).click();
  await page.getByRole("button", { name: "Change role…" }).click();
  await page.getByRole("button", { name: "Change role", exact: true }).click();
  await page.getByText(/only active admin/).waitFor();
  await capture(page, "desktop-users-last-admin-conflict-1440x960");
  await page.getByRole("button", { name: "OK" }).click();
  await context.close();
}

// ---- desktop: member denied /users ----
{
  const { context, page } = await newPage(DESKTOP, samCookie);
  await page.goto(`${BASE}/users`);
  await page.getByText("403 · NOT ALLOWED").waitFor();
  await capture(page, "desktop-users-denied-member-1440x960");
  await context.close();
}

// ---- desktop: keys ----
{
  const { context, page } = await newPage(DESKTOP, adminCookie);
  await page.goto(`${BASE}/keys`);
  await page.getByRole("cell", { name: "ingest-pipeline", exact: true }).waitFor();
  await capture(page, "desktop-keys-admin-1440x960");

  await page.getByRole("button", { name: "New key" }).first().click();
  await page.getByLabel(/where will this key live/i).fill("laptop-mbp-2");
  await capture(page, "desktop-keys-create-dialog-1440x960");

  await page.getByRole("button", { name: "Create key" }).click();
  await page.locator(".secret-value").waitFor();
  await maskSecret(page, "fsk_EXAMPLE0000-not-a-real-key");
  await capture(page, "desktop-keys-secret-once-1440x960");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByRole("row", { name: /laptop-mbp-2/ })
    .getByRole("button", { name: /^Revoke/ })
    .click();
  await page.getByRole("dialog").waitFor();
  await capture(page, "desktop-keys-revoke-confirm-1440x960");
  await page.getByRole("button", { name: "Revoke key" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForTimeout(400);
  await capture(page, "desktop-keys-revoked-result-1440x960");
  await context.close();
}
{
  const { context, page } = await newPage(DESKTOP, samCookie);
  await page.goto(`${BASE}/keys`);
  await page.getByRole("cell", { name: "ingest-pipeline", exact: true }).waitFor();
  await capture(page, "desktop-keys-member-1440x960");
  await context.close();
}

// ---- desktop: account ----
{
  const { context, page } = await newPage(DESKTOP, adminCookie);
  await page.goto(`${BASE}/account`);
  await page.getByRole("heading", { name: "Change password" }).waitFor();
  await capture(page, "desktop-account-1440x960");

  await page.getByLabel("Current password").fill("something current");
  await page.getByLabel("New password", { exact: true }).fill("short");
  await page.getByLabel("Confirm new password").fill("different");
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByText(/too short/i).waitFor();
  await capture(page, "desktop-account-password-validation-1440x960");
  await context.close();
}

// ---- desktop: files ----
{
  const { context, page } = await newPage(DESKTOP, adminCookie);
  await page.goto(`${BASE}/files`);
  await page.getByRole("button", { name: /telemetry-batch/ }).waitFor();
  await capture(page, "desktop-files-admin-1440x960");

  await page.getByRole("button", { name: /telemetry-batch/ }).click();
  await page.getByRole("region", { name: /object record/i }).waitFor();
  await capture(page, "desktop-files-inspector-1440x960");

  await page.getByRole("button", { name: /Change visibility/ }).click();
  await page.getByRole("dialog").waitFor();
  await capture(page, "desktop-files-visibility-editor-1440x960");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByRole("dialog").waitFor();
  await capture(page, "desktop-files-upload-dialog-1440x960");
  await context.close();
}
{
  const { context, page } = await newPage(DESKTOP, samCookie);
  await page.goto(`${BASE}/files?scope=everyone`);
  await page.getByRole("button", { name: /onboarding-runbook/ }).waitFor();
  await capture(page, "desktop-files-member-1440x960");

  await page.getByRole("button", { name: /onboarding-runbook/ }).click();
  await page.getByRole("region", { name: /object record/i }).waitFor();
  await capture(page, "desktop-files-member-readonly-inspector-1440x960");
  await context.close();
}

// ---- mobile ----
{
  const { context, page } = await newPage(MOBILE);
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Username").waitFor();
  await capture(page, "mobile-login-390x844");
  await context.close();
}
{
  const { context, page } = await newPage(MOBILE, adminCookie);
  await page.goto(`${BASE}/account`);
  await page.getByRole("heading", { name: "Change password" }).waitFor();
  await capture(page, "mobile-account-390x844");

  await page.goto(`${BASE}/users`);
  await page.getByRole("button", { name: "sam-ops", exact: true }).waitFor();
  await capture(page, "mobile-users-390x844");

  await page.getByRole("button", { name: /actions for sam-ops/i }).click();
  await page.getByRole("dialog").waitFor();
  await capture(page, "mobile-users-actions-390x844");
  await page.keyboard.press("Escape");

  await page.goto(`${BASE}/keys`);
  await page
    .getByRole("cell", { name: "ingest-pipeline", exact: true })
    .waitFor();
  await capture(page, "mobile-keys-390x844");

  await page
    .getByRole("row", { name: /ingest-pipeline/ })
    .getByRole("button", { name: /^Revoke/ })
    .click();
  await page.getByRole("dialog").waitFor();
  await capture(page, "mobile-keys-revoke-sheet-390x844");
  await page.keyboard.press("Escape");

  await page.goto(`${BASE}/files`);
  await page.getByRole("button", { name: /telemetry-batch/ }).waitFor();
  await capture(page, "mobile-files-390x844");

  await page.getByRole("button", { name: /telemetry-batch/ }).click();
  await page.getByRole("button", { name: /Change visibility/ }).click();
  await page.getByRole("dialog").waitFor();
  await capture(page, "mobile-files-visibility-sheet-390x844");
  await context.close();
}

await browser.close();
child.kill("SIGTERM");
console.log("done");
process.exit(0);
