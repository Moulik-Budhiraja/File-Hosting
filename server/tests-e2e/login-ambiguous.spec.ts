import { expect, test } from "@playwright/test";

import { ensureUser, nextAddress } from "./helpers";

// Login ambiguity: when the login POST commits but its response is lost,
// the client may still hold the session cookie (headers can land while
// the body does not). The form must consult /api/auth/me instead of
// claiming no session was created.

test("a committed login whose response is lost reconciles through /api/auth/me and follows the safe next path", async ({
  context,
  page,
  baseURL,
}) => {
  const user = await ensureUser(baseURL!, "login-lost-user", "member");
  const address = nextAddress();
  let dropped = false;
  await page.route("**/api/auth/login", async (route) => {
    if (!dropped) {
      dropped = true;
      // The REAL request commits; the session cookie is applied to the
      // context (headers arrived) but the response body is lost.
      const response = await route.fetch({
        headers: { ...route.request().headers(), "x-real-ip": address },
      });
      const setCookie = response.headers()["set-cookie"] ?? "";
      const match = /fs_session=([^;]+)/u.exec(setCookie);
      if (match) {
        await context.addCookies([
          {
            name: "fs_session",
            value: match[1]!,
            url: baseURL!,
            httpOnly: true,
            sameSite: "Strict",
          },
        ]);
      }
      await route.abort();
      return;
    }
    await route.continue();
  });

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("/login?next=%2Fkeys%3Fq%3Dtask");
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Reconciled sign-in navigates through the existing safe-next
  // sanitizer to the requested task.
  await page.waitForURL((url) => url.pathname === "/keys");
  expect(new URL(page.url()).searchParams.get("q")).toBe("task");
  await expect(page.getByText(user.username).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("a committed login loss with a hostile next value still lands on the default route", async ({
  context,
  page,
  baseURL,
}) => {
  const user = await ensureUser(baseURL!, "login-lost-hostile", "member");
  const address = nextAddress();
  let dropped = false;
  await page.route("**/api/auth/login", async (route) => {
    if (!dropped) {
      dropped = true;
      const response = await route.fetch({
        headers: { ...route.request().headers(), "x-real-ip": address },
      });
      const match = /fs_session=([^;]+)/u.exec(
        response.headers()["set-cookie"] ?? "",
      );
      if (match) {
        await context.addCookies([
          {
            name: "fs_session",
            value: match[1]!,
            url: baseURL!,
            httpOnly: true,
            sameSite: "Strict",
          },
        ]);
      }
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page.goto("/login?next=%2F%2Fevil.example%2Fphish");
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/files");
  expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
});

test("a genuinely unreachable server yields a truthful unknown outcome and a working retry", async ({
  page,
  baseURL,
}) => {
  const user = await ensureUser(baseURL!, "login-unreachable", "member");
  let unreachable = true;
  await page.route("**/api/auth/**", async (route) => {
    if (unreachable) {
      await route.abort();
      return;
    }
    await route.continue({
      headers: { ...route.request().headers(), "x-real-ip": nextAddress() },
    });
  });

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("/login");
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText(/sign-in outcome unknown/i)).toBeVisible();
  await expect(page.getByText(/nothing was changed/i)).toHaveCount(0);

  // Connectivity returns; the same form retries to a real session.
  unreachable = false;
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/files");
  expect(errors).toEqual([]);
});

test("restricted storage does not break the reconciled login path", async ({
  browser,
  baseURL,
}) => {
  const user = await ensureUser(baseURL!, "login-lost-storage", "member");
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const deny = () => {
      throw new DOMException("denied", "SecurityError");
    };
    Storage.prototype.getItem = deny;
    Storage.prototype.setItem = deny;
    Storage.prototype.removeItem = deny;
    (window as unknown as Record<string, unknown>).BroadcastChannel = undefined;
  });
  const page = await context.newPage();
  const address = nextAddress();
  let dropped = false;
  await page.route("**/api/auth/login", async (route) => {
    if (!dropped) {
      dropped = true;
      const response = await route.fetch({
        headers: { ...route.request().headers(), "x-real-ip": address },
      });
      const match = /fs_session=([^;]+)/u.exec(
        response.headers()["set-cookie"] ?? "",
      );
      if (match) {
        await context.addCookies([
          {
            name: "fs_session",
            value: match[1]!,
            url: baseURL!,
            httpOnly: true,
            sameSite: "Strict",
          },
        ]);
      }
      await route.abort();
      return;
    }
    await route.continue();
  });

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${baseURL}/login`);
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/files");
  expect(errors).toEqual([]);
  await context.close();
});

test("a lost login response with a definitive different cookie session names that session truthfully and retries safely", async ({
  context,
  page,
  baseURL,
}) => {
  const existing = await ensureUser(baseURL!, "login-existing-user", "member");
  const intended = await ensureUser(baseURL!, "login-intended-user", "member");
  await page.goto("/login");
  await page.getByLabel("Username").fill(existing.username);
  await page.getByLabel("Password").fill(existing.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/files");
  await page.goto("/login");

  let abortLogin = true;
  await page.route("**/api/auth/login", async (route) => {
    if (abortLogin) {
      await route.abort("connectionreset");
      return;
    }
    await route.continue({
      headers: { ...route.request().headers(), "x-real-ip": nextAddress() },
    });
  });
  const meResponses: number[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith("/api/auth/me"))
      meResponses.push(response.status());
  });
  await page.getByLabel("Username").fill(intended.username);
  await page.getByLabel("Password").fill(intended.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(
    page.getByText(new RegExp(`still signed in as ${existing.username}`, "i")),
  ).toBeVisible();
  await expect(page.getByText(/server didn't respond/i)).toHaveCount(0);
  expect(meResponses).toContain(200);
  const cookies = await context.cookies(baseURL);
  expect(cookies.some((cookie) => cookie.name === "fs_session")).toBe(true);

  abortLogin = false;
  await page.getByLabel("Password").fill(intended.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/files");
  await expect(page.getByText(intended.username).first()).toBeVisible();
});
