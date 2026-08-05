import path from "node:path";

import { expect, test } from "@playwright/test";
import { createClient } from "@libsql/client";

import {
  ADMIN,
  LEGACY_TOKEN,
  apiContext,
  ensureUser,
  nextAddress,
} from "./helpers";

test("a disabled account with valid credentials gets the approved recovery", async ({
  page,
  baseURL,
}) => {
  const user = await ensureUser(baseURL!, "disabled-login-state", "member");
  const api = await apiContext(baseURL!);
  try {
    const disabled = await api.patch(`/api/users/${user.id}`, {
      data: { active: false },
      headers: { authorization: ["Bear", "er ", LEGACY_TOKEN].join("") },
    });
    expect(disabled.status()).toBe(200);
  } finally {
    await api.dispose();
  }

  const address = nextAddress();
  await page.route("**/api/auth/login", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-real-ip": address },
    }),
  );
  await page.goto("/login");
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("This account is disabled.")).toBeVisible();
  await expect(page.getByText("Contact an administrator.")).toBeVisible();
  await expect(page.getByText(/incorrect/i)).toHaveCount(0);
});

test("an expired temporary password gets terse recovery", async ({
  page,
  baseURL,
}) => {
  const api = await apiContext(baseURL!);
  const login = await api.post("/api/auth/login", {
    data: ADMIN,
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(login.status()).toBe(200);
  const username = "expired-temporary-login";
  const password = "expired-temporary-password-12+";
  const created = await api.post("/api/users", {
    data: { username, password, role: "member" },
    headers: { origin: baseURL! },
  });
  expect(created.status()).toBe(201);
  const userId = ((await created.json()) as { user: { id: string } }).user.id;
  await api.dispose();

  const dataDir = process.env.E2E_DATA_DIR;
  if (!dataDir) throw new Error("E2E_DATA_DIR is required");
  const database = createClient({
    url: `file:${path.join(dataDir, "files.db")}`,
  });
  try {
    await database.execute({
      sql: "UPDATE users SET temporary_password_expires_at = ? WHERE id = ?",
      args: ["2000-01-01T00:00:00.000Z", userId],
    });
  } finally {
    database.close();
  }

  await page.route("**/api/auth/login", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-real-ip": nextAddress() },
    }),
  );
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Temporary password expired.")).toBeVisible();
  await expect(
    page.getByText("Ask an administrator for a new one."),
  ).toBeVisible();
  await expect(page.getByText(/incorrect/i)).toHaveCount(0);
});

test("throttling exposes the server retry window and disables sign-in", async ({
  page,
  baseURL,
}) => {
  const user = await ensureUser(baseURL!, "throttled-login-state", "member");
  const address = nextAddress();
  const api = await apiContext(baseURL!);
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await api.post("/api/auth/login", {
        data: { username: user.username, password: "wrong-password-long" },
        headers: { origin: baseURL!, "x-real-ip": address },
      });
    }
  } finally {
    await api.dispose();
  }

  await page.route("**/api/auth/login", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-real-ip": address },
    }),
  );
  await page.goto("/login");
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill("wrong-password-long");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Too many attempts.")).toBeVisible();
  await expect(page.getByText(/Try again in \d+ min \d+ s\./u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
});
