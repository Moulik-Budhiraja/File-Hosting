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
      expect(response.status()).toBe(204);
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

  await expect(
    page.getByText("Password change outcome unknown."),
  ).toBeVisible();
  await expect(
    page.getByText(
      /may have changed and every browser session may have been signed out/i,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /go to sign in/i }),
  ).toBeVisible();
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
  const oldSession = await context.request.get("/api/auth/me");
  expect(oldSession.status()).toBe(401);
  await api.dispose();
});
