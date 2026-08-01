import { expect, test } from "@playwright/test";

import {
  ADMIN,
  apiContext,
  LEGACY_TOKEN,
  signInContext,
  uploadFile,
} from "./helpers";

// File visibility is a desired-state mutation: after an ambiguous
// transport failure the UI re-fetches the authoritative record and either
// reports reconciled success or a truthful unknown — never "nothing was
// changed".

test("a committed visibility change with a lost response reconciles; a pre-commit failure says unknown", async ({
  context,
  page,
  baseURL,
}) => {
  const uploaded = await uploadFile(
    baseURL!,
    LEGACY_TOKEN,
    "ambig-visibility.txt",
    "private",
  );
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/files?q=ambig-visibility");

  // Phase 1: pre-commit failure — PATCH aborted before the server, and
  // the verification GET still reports the old state.
  let mode: "abort" | "commit-drop" | "continue" = "abort";
  await page.route(`**/api/files/${uploaded.id}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    if (mode === "abort") {
      await route.abort();
      return;
    }
    if (mode === "commit-drop") {
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: /ambig-visibility\.txt/ }).click();
  await page.getByRole("button", { name: "Change visibility…" }).click();
  const editor = page.getByRole("dialog", { name: /Who can open this file\?/ });
  await editor.getByRole("radio", { name: /protected/ }).click();
  await editor.getByRole("button", { name: "Save" }).click();

  await expect(
    editor.getByText(/may or may not have been saved/i),
  ).toBeVisible();
  await expect(page.getByText(/nothing was changed/i)).toHaveCount(0);

  // Phase 2: the retry commits but the response is lost; the
  // authoritative record shows the desired state → reconciled success.
  mode = "commit-drop";
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await expect(
    page.getByText(/visibility confirmed after reconnect/i),
  ).toBeVisible();
  await expect(page.getByText(/nothing was changed/i)).toHaveCount(0);

  // Server truth: the visibility really changed.
  const api = await apiContext(baseURL!);
  const record = await api.get(`/api/files/${uploaded.id}`, {
    headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
  });
  expect(((await record.json()) as { visibility: string }).visibility).toBe(
    "protected",
  );
  await api.dispose();
});

test("a stale selected-file id restored from the URL is dropped from the query", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/files?sel=defunct-file-id");
  // The list loads, nothing is selected, and the stale sel value is
  // removed from the URL without loops or a wrong selection.
  await expect(page.getByText(/rows loaded/)).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("sel"))
    .toBeNull();
  await expect(
    page.getByRole("region", { name: /object record/i }),
  ).toHaveCount(0);
});
