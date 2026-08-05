import { expect, test } from "@playwright/test";

import {
  LEGACY_TOKEN,
  apiContext,
  ensureUser,
  nextAddress,
  signInContext,
} from "./helpers";

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

  // Wait for the successful empty response before opening the create dialog.
  await expect(page.getByText("No API keys")).toBeVisible();
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("lost-create-key");
  await page.getByRole("button", { name: "Create key" }).click();

  // Truthful reconcile: the key exists as pending; the secret is gone;
  // no "nothing was changed" lie, no show-once dialog.
  await expect(
    page.getByText(
      "Secret unavailable. Cancel the pending key, then create a new one.",
    ),
  ).toBeVisible();
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
  await expect(
    page.getByText(/inactive.*cancelling removes it/i),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel key" }).click();
  await expect(
    page.getByRole("cell", { name: "lost-create-key", exact: true }),
  ).toHaveCount(0);
});

for (const gateway of [
  { label: "unstructured 502", structured: false },
  { label: "structured 500", structured: true },
]) {
  test(`a committed create hidden by ${gateway.label} reuses its request id and refreshes the pending list`, async ({
    context,
    page,
    baseURL,
  }) => {
    const suffix = gateway.structured ? "structured" : "unstructured";
    const owner = await ensureUser(
      baseURL!,
      `gateway-create-${suffix}`,
      "member",
    );
    await signInContext(context, baseURL!, owner.username, owner.password);
    await page.goto("/keys");

    const requestIds: string[] = [];
    let replaced = false;
    await page.route("**/api/api-keys", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON() as { request_id: string };
      requestIds.push(body.request_id);
      if (!replaced) {
        replaced = true;
        await route.fetch();
        if (gateway.structured) {
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
        } else {
          await route.fulfill({
            status: 502,
            contentType: "text/html",
            body: "<html>Bad Gateway</html>",
          });
        }
        return;
      }
      await route.continue();
    });

    await expect(page.getByText("No API keys")).toBeVisible();
    await page.getByRole("button", { name: "New key" }).click();
    await page.getByLabel("Name", { exact: true }).fill(`gateway-${suffix}`);
    await page.getByRole("button", { name: "Create key" }).click();

    await expect(
      page.getByText(
        "Secret unavailable. Cancel the pending key, then create a new one.",
      ),
    ).toBeVisible();
    await expect.poll(() => requestIds.length).toBe(2);
    expect(requestIds[0]).toBe(requestIds[1]);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: `gateway-${suffix}`, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/pending · never authenticates/)).toBeVisible();
  });
}

test("a lost activation response reconciles idempotently and the key works exactly once activated", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "lost-activate-owner", "member");
  await signInContext(context, baseURL!, owner.username, owner.password);
  await page.setViewportSize({ width: 390, height: 844 });
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

  // Wait for the successful empty response before opening the create dialog.
  await expect(page.getByText("No API keys")).toBeVisible();
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("lost-activate-key");
  await page.getByRole("button", { name: "Create key" }).click();

  // The secret arrived with one warning at the decision point.
  await expect(
    page.getByText("Copy now. You won’t see it again."),
  ).toBeVisible();
  const secret = (await page.locator(".secret-value").innerText()).trim();
  expect(secret).toMatch(/^fsk_/);
  await page.getByRole("checkbox", { name: /I've stored this key/ }).check();
  await expect(page.getByText(/may not be active/i)).toBeVisible();

  // Mobile and keyboard dismissal cannot discard either the show-once
  // secret or its safe pending recovery id, even after acknowledgement.
  const done = page.getByRole("button", { name: "Done" });
  await expect(done).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".secret-value")).toHaveText(secret);
  await expect(page).toHaveURL(/(?:\?|&)pend=[^&]+/u);

  // Retrying reconciles against the already-committed activation.
  await page.getByRole("button", { name: /retry activation/i }).click();
  await expect(page.getByText(/key active — ready to use/i)).toBeVisible();
  await expect(done).toBeEnabled();

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

  // Close the dialog cleanly only after definitive activation.
  await done.click();
});

test("a definitive activation rejection is truthful, keyboard-safe, cancellable, and never authenticates", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(
    baseURL!,
    "rejected-activation-owner",
    "member",
  );
  await signInContext(context, baseURL!, owner.username, owner.password);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/api-keys/*/activate", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "activation_rejected",
          message: "Activation rejected by policy",
        },
      }),
    });
  });
  await page.goto("/keys");
  await expect(page.getByText("No API keys")).toBeVisible();
  await page.getByRole("button", { name: "New key" }).click();
  await page
    .getByLabel("Name", { exact: true })
    .fill("rejected-activation-key");
  await page.getByRole("button", { name: "Create key" }).click();

  const secret = (await page.locator(".secret-value").innerText()).trim();
  await page.getByRole("checkbox", { name: /I've stored this key/ }).check();
  await expect(page.getByText("Activation rejected by policy.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /retry activation/i }),
  ).toHaveCount(0);
  await expect(page.getByText(/may not be active/i)).toHaveCount(0);
  const anonymous = await apiContext(baseURL!);
  const denied = await anonymous.get("/api/auth/me", {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(denied.status()).toBe(401);
  await page.keyboard.press("Escape");
  await expect(page.locator(".secret-value")).toHaveText(secret);
  await page.getByRole("button", { name: "Cancel key" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/(?:\?|&)pend=/u);
  const deniedAfterCancel = await anonymous.get("/api/auth/me", {
    headers: { authorization: ["Bearer", secret].join(" ") },
  });
  expect(deniedAfterCancel.status()).toBe(401);
  await anonymous.dispose();
});

test("an already-gone rejected key 404 reconciles as cancelled", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "rejected-gone-owner", "member");
  await signInContext(context, baseURL!, owner.username, owner.password);
  await page.route("**/api/api-keys/*/activate", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "activation_rejected", message: "Activation rejected" },
      }),
    }),
  );
  await page.route("**/api/api-keys/*", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    await route.fetch();
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "not_found", message: "API key not found" },
      }),
    });
  });
  await page.goto("/keys");
  await expect(page.getByText("No API keys")).toBeVisible();
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("already-gone-key");
  await page.getByRole("button", { name: "Create key" }).click();
  const secret = (await page.locator(".secret-value").innerText()).trim();
  await page.getByRole("checkbox", { name: /I've stored this key/ }).check();
  await expect(page.getByText("Activation rejected.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel key" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const anonymous = await apiContext(baseURL!);
  expect(
    (
      await anonymous.get("/api/auth/me", {
        headers: { authorization: ["Bearer", secret].join(" ") },
      })
    ).status(),
  ).toBe(401);
  await anonymous.dispose();
});

test("a rejected-key cancellation 5xx remains mounted and retries without re-exposing or activating", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "rejected-retry-owner", "member");
  await signInContext(context, baseURL!, owner.username, owner.password);
  await page.route("**/api/api-keys/*/activate", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "activation_rejected", message: "Activation rejected" },
      }),
    }),
  );
  let deletes = 0;
  await page.route("**/api/api-keys/*", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    deletes += 1;
    if (deletes === 1) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "internal_error", message: "Synthetic failure" },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto("/keys");
  await expect(page.getByText("No API keys")).toBeVisible();
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("retry-cancel-key");
  await page.getByRole("button", { name: "Create key" }).click();
  const secret = (await page.locator(".secret-value").innerText()).trim();
  await page.getByRole("checkbox", { name: /I've stored this key/ }).check();
  await expect(page.getByText("Activation rejected.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel key" }).click();
  await expect(
    page.getByText(
      "Cancellation not confirmed. The pending key may or may not remain. Retry cancellation.",
    ),
  ).toBeVisible();
  await expect(page.locator(".secret-value")).toHaveText(secret);
  await expect(
    page.getByRole("button", { name: "Retry cancellation" }),
  ).toBeEnabled();
  const anonymous = await apiContext(baseURL!);
  expect(
    (
      await anonymous.get("/api/auth/me", {
        headers: { authorization: ["Bearer", secret].join(" ") },
      })
    ).status(),
  ).toBe(401);
  await page.getByRole("button", { name: "Retry cancellation" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(deletes).toBe(2);
  await anonymous.dispose();
});

test("begin at the active-key cap shows no secret", async ({
  context,
  page,
  baseURL,
}) => {
  const owner = await ensureUser(baseURL!, "capped-browser-owner", "member");
  const setup = await apiContext(baseURL!);
  for (let index = 0; index < 10; index += 1) {
    const created = await setup.post("/api/api-keys", {
      data: { name: `cap-${index}`, user_id: owner.id },
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
    });
    expect(created.status()).toBe(201);
  }
  await setup.dispose();

  await signInContext(context, baseURL!, owner.username, owner.password);
  await page.goto("/keys");
  await expect(
    page.getByRole("cell", { name: "cap-0", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("must-not-mint");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(
    page.getByText("A user can have at most 10 active API keys."),
  ).toBeVisible();
  await expect(page.getByText("SHOWN ONLY ONCE")).toHaveCount(0);
  await expect(page.locator(".secret-value")).toHaveCount(0);
});
