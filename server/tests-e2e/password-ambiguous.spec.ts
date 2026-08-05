import { expect, test } from "@playwright/test";

import { apiContext, ensureUser, nextAddress, signInContext } from "./helpers";

// Codex P1 regression: the password POST commits before its 204 response is
// delivered. This test lets the real server commit and then drops only response
// delivery, so the UI must treat the outcome as unknown and provide recovery
// that is safe whether or not the commit happened.
test("a committed password change with a lost response reports an unknown outcome and safe recovery", async ({
  context,
  page,
  baseURL,
}) => {
  const member = await ensureUser(baseURL!, "password-loss-member", "member");
  const replacement = ["replacement", "fixture", "credential", "value"].join(
    "-",
  );
  await signInContext(context, baseURL!, member.username, member.password);
  await page.goto("/account");

  let committed = false;
  await page.route("**/api/auth/password", async (route) => {
    if (route.request().method() === "POST" && !committed) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed = true;
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page
    .getByLabel("Current password", { exact: true })
    .fill(member.password);
  await page.getByLabel("New password", { exact: true }).fill(replacement);
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill(replacement);
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(page.getByText("Request timed out.")).toBeVisible();
  await expect(
    page.getByText("Password may have changed. Try the new password first."),
  ).toBeVisible();
  const recovery = page.getByRole("link", { name: /go to sign in/i });
  await expect(recovery).toBeVisible();
  await expect(recovery).toHaveAttribute("href", "/login?next=%2Faccount");
  // The in-flight submit control was disabled, so without a deliberate move
  // keyboard focus would land on the document body.
  await expect(recovery).toBeFocused();
  expect(
    await recovery.evaluate((el) => getComputedStyle(el).outlineStyle),
  ).toBe("solid");
  await page.emulateMedia({ forcedColors: "active" });
  expect(
    parseInt(
      await recovery.evaluate((el) => getComputedStyle(el).outlineWidth),
      10,
    ),
  ).toBeGreaterThanOrEqual(2);
  await expect(page.getByText(/password not changed/i)).toHaveCount(0);
  await expect(page.getByText(/current password still works/i)).toHaveCount(0);
  await expect(
    page.getByLabel("Current password", { exact: true }),
  ).toHaveValue("");
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue(
    "",
  );
  expect(committed).toBe(true);

  // Server truth proves this was the post-commit ambiguity: the replacement
  // credential works, the old one does not, and every existing session is dead.
  const api = await apiContext(baseURL!);
  const replacementLogin = await api.post("/api/auth/login", {
    data: { username: member.username, password: replacement },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(replacementLogin.status()).toBe(200);
  const oldLogin = await api.post("/api/auth/login", {
    data: { username: member.username, password: member.password },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(oldLogin.status()).toBe(401);
  const currentSession = await context.request.get("/api/auth/me");
  expect(currentSession.status()).toBe(200);
  await api.dispose();
});

// Fable P3 regression: a DELIVERED HTTP 500 is a known outcome — the route
// rolls back before erroring — so the UI must never call it a lost response
// or enter unknown-outcome recovery.
test("a delivered server error reports password not changed and keeps the form usable", async ({
  context,
  page,
  baseURL,
}) => {
  const member = await ensureUser(baseURL!, "password-500-member", "member");
  await signInContext(context, baseURL!, member.username, member.password);
  await page.goto("/account");

  await page.route("**/api/auth/password", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "internal_error",
            message: "The server could not complete the request",
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  const current = page.getByLabel("Current password", { exact: true });
  await current.fill(member.password);
  await page
    .getByLabel("New password", { exact: true })
    .fill("replacement-fixture-credential");
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill("replacement-fixture-credential");
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(page.getByText("Password not changed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText(/response was lost/i)).toHaveCount(0);
  await expect(page.getByText(/outcome unknown/i)).toHaveCount(0);
  await expect(page.getByText(/may have changed/i)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /go to sign in/i })).toHaveCount(
    0,
  );
  // The failure belongs to the server, not the current-password field, and
  // the typed credential stays so retry is one click.
  await expect(current).not.toHaveAttribute("aria-invalid", "true");
  await expect(current).toHaveValue(member.password);
  await expect(
    page.getByRole("button", { name: "Change password" }),
  ).toBeEnabled();

  // Server truth: the intercepted request never reached the route, and the
  // UI said so — the original credential still signs in.
  const api = await apiContext(baseURL!);
  const oldLogin = await api.post("/api/auth/login", {
    data: { username: member.username, password: member.password },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(oldLogin.status()).toBe(200);
  await api.dispose();
});

// Fable P3 regression: a real 401 from a dead session (code "unauthorized")
// must ask for re-authentication instead of blaming the current password.
test("a revoked session 401 asks for re-authentication without blaming the current password", async ({
  context,
  page,
  baseURL,
}) => {
  const member = await ensureUser(baseURL!, "password-dead-session", "member");
  await signInContext(context, baseURL!, member.username, member.password);
  await page.goto("/account");

  const current = page.getByLabel("Current password", { exact: true });
  await current.fill(member.password);
  await page
    .getByLabel("New password", { exact: true })
    .fill("replacement-fixture-credential");
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill("replacement-fixture-credential");
  // Kill the session cookie after the page is fully interactive: the next
  // POST reaches the real route and gets a real 401 "unauthorized".
  await context.clearCookies();
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(page.getByText("Session expired.")).toBeVisible();
  await expect(
    page.getByText(/sign in again to change your password/i),
  ).toBeVisible();
  const recovery = page.getByRole("link", { name: /go to sign in/i });
  await expect(recovery).toBeVisible();
  await expect(recovery).toHaveAttribute("href", "/login?next=%2Faccount");
  // The credential was never judged — no false field attribution…
  await expect(page.getByText("Current password is invalid.")).toHaveCount(0);
  await expect(current).not.toHaveAttribute("aria-invalid", "true");
  await expect(current).not.toHaveAttribute("aria-describedby", /.+/u);
  // …the dead page keeps no typed credentials, and focus is not stolen.
  await expect(current).toHaveValue("");
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue(
    "",
  );
  await expect(recovery).not.toBeFocused();

  // Server truth: the credential is untouched — it still signs in.
  const api = await apiContext(baseURL!);
  const oldLogin = await api.post("/api/auth/login", {
    data: { username: member.username, password: member.password },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(oldLogin.status()).toBe(200);
  await api.dispose();
});

test("a committed change hidden by an unstructured gateway 502 stays conservative", async ({
  context,
  page,
  baseURL,
}) => {
  const member = await ensureUser(
    baseURL!,
    "password-gateway-member",
    "member",
  );
  const replacement = "gateway-hidden-replacement";
  await signInContext(context, baseURL!, member.username, member.password);
  await page.goto("/account");

  let committed = false;
  await page.route("**/api/auth/password", async (route) => {
    if (route.request().method() === "POST" && !committed) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed = true;
      await route.fulfill({
        status: 502,
        contentType: "text/html",
        body: "<html><body>Bad Gateway</body></html>",
      });
      return;
    }
    await route.continue();
  });

  await page
    .getByLabel("Current password", { exact: true })
    .fill(member.password);
  await page.getByLabel("New password", { exact: true }).fill(replacement);
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill(replacement);
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(page.getByText("Request timed out.")).toBeVisible();
  await expect(page.getByText("Password not changed.")).toHaveCount(0);
  const recovery = page.getByRole("link", { name: /go to sign in/i });
  await expect(recovery).toBeFocused();
  await expect(
    page.getByLabel("Current password", { exact: true }),
  ).toHaveValue("");
  expect(committed).toBe(true);

  const api = await apiContext(baseURL!);
  const replacementLogin = await api.post("/api/auth/login", {
    data: { username: member.username, password: replacement },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(replacementLogin.status()).toBe(200);
  const oldLogin = await api.post("/api/auth/login", {
    data: { username: member.username, password: member.password },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(oldLogin.status()).toBe(401);
  const currentSession = await context.request.get("/api/auth/me");
  expect(currentSession.status()).toBe(200);
  await api.dispose();
});

test("editing judged password values clears stale field errors", async ({
  context,
  page,
  baseURL,
}) => {
  const member = await ensureUser(baseURL!, "password-edit-member", "member");
  await signInContext(context, baseURL!, member.username, member.password);
  await page.goto("/account");

  const current = page.getByLabel("Current password", { exact: true });
  const next = page.getByLabel("New password", { exact: true });
  const confirmation = page.getByLabel("Confirm new password", { exact: true });
  await current.fill("definitely-wrong-password");
  await next.fill("replacement-fixture-credential");
  await confirmation.fill("replacement-fixture-credential");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Current password is invalid.")).toBeVisible();
  await expect(current).toHaveAttribute("aria-invalid", "true");

  await current.fill(member.password);
  await expect(page.getByText("Current password is invalid.")).toHaveCount(0);
  await expect(current).not.toHaveAttribute("aria-invalid", "true");
  await expect(current).not.toHaveAttribute("aria-describedby", /.+/u);

  await next.fill("replacement-fixture-first");
  await confirmation.fill("replacement-fixture-second");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Doesn't match.")).toBeVisible();
  await expect(confirmation).toHaveAttribute("aria-invalid", "true");

  await next.fill("replacement-fixture-second");
  await expect(page.getByText("Doesn't match.")).toHaveCount(0);
  await expect(confirmation).not.toHaveAttribute("aria-invalid", "true");
  await expect(confirmation).not.toHaveAttribute("aria-describedby", /.+/u);
});
