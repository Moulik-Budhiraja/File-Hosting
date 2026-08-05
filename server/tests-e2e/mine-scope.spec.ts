import { expect, test } from "@playwright/test";

import {
  createApiKeyFor,
  ensureUser,
  signInContext,
  uploadFile,
} from "./helpers";

// P2-3 regression: "Mine" must be a server-side scope applied before
// pagination — one owned file buried behind 50+ newer files owned by
// someone else must still be found.

test("Mine finds an owned file buried behind a full page of others' files", async ({
  context,
  page,
  baseURL,
}) => {
  const mineOwner = await ensureUser(baseURL!, "mine-owner", "member");
  const noiseOwner = await ensureUser(baseURL!, "mine-noise", "member");
  const mineBearer = await createApiKeyFor(baseURL!, mineOwner.id, "mine-key");
  const noiseBearer = await createApiKeyFor(
    baseURL!,
    noiseOwner.id,
    "noise-key",
  );
  // The owned file first (oldest), then 55 newer noise files.
  await uploadFile(baseURL!, mineBearer, "mine-needle.txt", "public");
  for (let index = 0; index < 55; index += 1) {
    await uploadFile(baseURL!, noiseBearer, `noise-${index}.txt`, "public");
  }

  await signInContext(
    context,
    baseURL!,
    mineOwner.username,
    mineOwner.password,
  );
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/files?")) requests.push(request.url());
  });
  await page.goto("/files");

  // Members default to Mine; the needle is on page one of the scoped
  // listing even though 55 newer unowned files exist.
  await expect(
    page.getByRole("button", { name: "Mine", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: /mine-needle\.txt/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /noise-0\.txt/ })).toHaveCount(
    0,
  );
  expect(requests.some((url) => url.includes("owner=me"))).toBe(true);
  // Truthful pagination: no phantom next page for the one-file scope.
  await expect(page.getByRole("button", { name: "next →" })).toBeDisabled();

  // Everyone shows the noise and enables real pagination.
  await page.getByRole("button", { name: "Everyone" }).click();
  await expect(
    page.getByRole("button", { name: /noise-54\.txt/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "next →" })).toBeEnabled();
});
