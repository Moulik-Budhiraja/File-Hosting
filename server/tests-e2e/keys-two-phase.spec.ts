import { expect, test } from "@playwright/test";

import { apiContext, ensureUser, nextAddress, signInContext } from "./helpers";

// P2-3 regression: a committed create whose response is lost must never
// leave an ACTIVE key with an unrecoverable secret behind a "nothing was
// changed" message. The browser flow is two-phase: pending create with an
// idempotency id, then activation only after the secret arrived.

test("a pending key never authenticates until its activation completes", async ({
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "twophase-api-owner", "member");
  const api = await apiContext(baseURL!);
  const login = await api.post("/api/auth/login", {
    data: { username: owner.username, password: owner.password },
    headers: { origin: baseURL!, "x-real-ip": nextAddress() },
  });
  expect(login.status()).toBe(200);

  // Phase 1: pending create returns the show-once secret.
  const created = await api.post("/api/api-keys", {
    data: { name: "pending-probe", request_id: "e2e-pending-probe-1" },
    headers: { origin: baseURL! },
  });
  expect(created.status()).toBe(201);
  const createdBody = (await created.json()) as {
    api_key: { id: string; secret: string; status: string };
  };
  expect(createdBody.api_key.status).toBe("pending");

  // The pending secret is NOT a live credential.
  const anonymous = await apiContext(baseURL!);
  const denied = await anonymous.get("/api/auth/me", {
    headers: { authorization: `Bearer ${createdBody.api_key.secret}` },
  });
  expect(denied.status()).toBe(401);

  // A create retry reconciles without re-exposing the plaintext.
  const retried = await api.post("/api/api-keys", {
    data: { name: "pending-probe", request_id: "e2e-pending-probe-1" },
    headers: { origin: baseURL! },
  });
  expect(retried.status()).toBe(200);
  const retriedBody = (await retried.json()) as {
    api_key: { id: string; secret: string | null; created: boolean };
  };
  expect(retriedBody.api_key.created).toBe(false);
  expect(retriedBody.api_key.secret).toBeNull();
  expect(retriedBody.api_key.id).toBe(createdBody.api_key.id);

  // Phase 2 flips it live.
  const activated = await api.post(
    `/api/api-keys/${createdBody.api_key.id}/activate`,
    { headers: { origin: baseURL! } },
  );
  expect(activated.status()).toBe(200);
  const granted = await anonymous.get("/api/auth/me", {
    headers: { authorization: `Bearer ${createdBody.api_key.secret}` },
  });
  expect(granted.status()).toBe(200);
  await anonymous.dispose();
  await api.dispose();
});

test("a committed create with a lost response surfaces a truthful pending outcome, cancellable, never active", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "lost-create-owner", "member");
  await signInContext(context, baseURL!, owner.username, owner.password);
  await page.goto("/keys");

  // First create POST: forward to the real server (it commits), then
  // drop the response on the floor. The retry probe goes through.
  let dropped = false;
  await page.route("**/api/api-keys", async (route) => {
    if (route.request().method() === "POST" && !dropped) {
      dropped = true;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "New key" }).click();
  await page
    .getByLabel(/Name — where will this key live\?/)
    .fill("lost-create-key");
  await page.getByRole("button", { name: "Create key" }).click();

  // Truthful reconcile: the key exists as pending; the secret is gone;
  // no "nothing was changed" lie, no show-once dialog.
  await expect(page.getByText(/secret was lost in transit/i)).toBeVisible();
  await expect(page.getByText(/nothing was changed/i)).toHaveCount(0);
  await expect(page.getByText("SHOWN ONLY ONCE")).toHaveCount(0);

  // The server agrees: exactly one pending, never-active row.
  const api = await apiContext(baseURL!);
  const listing = await api.get("/api/api-keys", {
    headers: {
      authorization: `Bearer ${"e2e-synthetic-service-token"}`,
    },
    params: { user_id: owner.id },
  });
  const keys = (
    (await listing.json()) as {
      api_keys: Array<{ name: string; status: string; revoked_at: unknown }>;
    }
  ).api_keys.filter((key) => key.name === "lost-create-key");
  expect(keys).toHaveLength(1);
  expect(keys[0]!.status).toBe("pending");
  await api.dispose();

  // Close the create dialog; the refreshed list shows the pending row
  // truthfully, with a cancel action.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "lost-create-key", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/pending · never authenticates/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel lost-create-key" }).click();
  await expect(page.getByText(/never activated/i)).toBeVisible();
  await page.getByRole("button", { name: "Cancel key" }).click();
  await expect(
    page.getByRole("cell", { name: "lost-create-key", exact: true }),
  ).toHaveCount(0);
});

test("a lost activation response reconciles idempotently and the key works exactly once activated", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "lost-activate-owner", "member");
  await signInContext(context, baseURL!, owner.username, owner.password);
  await page.goto("/keys");

  // The activation POST reaches the server (it commits) but the
  // response is lost once.
  let droppedActivation = false;
  await page.route("**/api/api-keys/*/activate", async (route) => {
    if (!droppedActivation) {
      droppedActivation = true;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "New key" }).click();
  await page
    .getByLabel(/Name — where will this key live\?/)
    .fill("lost-activate-key");
  await page.getByRole("button", { name: "Create key" }).click();

  // The secret arrived; the dialog is truthful about activation state.
  await expect(page.getByText("SHOWN ONLY ONCE")).toBeVisible();
  const secret = (await page.locator(".secret-value").innerText()).trim();
  expect(secret).toMatch(/^fsk_/);
  await expect(page.getByText(/NOT active yet/i)).toBeVisible();

  // Retrying reconciles against the already-committed activation.
  await page.getByRole("button", { name: /retry activation/i }).click();
  await expect(page.getByText(/key active — ready to use/i)).toBeVisible();

  // The credential is live — and there is exactly one such key.
  const api = await apiContext(baseURL!);
  const me = await api.get("/api/auth/me", {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(me.status()).toBe(200);
  const listing = await api.get("/api/api-keys", {
    headers: { authorization: `Bearer ${secret}` },
  });
  const keys = (
    (await listing.json()) as {
      api_keys: Array<{ name: string; status: string }>;
    }
  ).api_keys.filter((key) => key.name === "lost-activate-key");
  expect(keys).toHaveLength(1);
  expect(keys[0]!.status).toBe("active");
  await api.dispose();

  // Close the dialog cleanly.
  await page.getByRole("checkbox", { name: /I've stored this key/ }).check();
  await page.getByRole("button", { name: "Done" }).click();
});
