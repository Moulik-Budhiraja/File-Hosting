import { expect, test, type Locator, type Page } from "@playwright/test";

import { ADMIN, signInContext } from "./helpers";

// P2-5 regression: New User / New API Key field errors must be
// programmatically associated with their inputs (stable id, aria-invalid,
// aria-describedby) and focus must land on the offending field.

async function expectFieldError(
  page: Page,
  input: Locator,
  errorText: RegExp,
): Promise<void> {
  const error = page.getByText(errorText);
  await expect(error).toBeVisible();
  const errorId = await error.getAttribute("id");
  expect(errorId).toBeTruthy();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  const describedBy = await input.getAttribute("aria-describedby");
  expect(describedBy).toContain(errorId!);
  await expect(input).toBeFocused();
}

test("New API Key validation errors are associated with the name field", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/keys");
  await page.getByRole("button", { name: "New key" }).first().click();
  const input = page.getByLabel(/Name — where will this key live\?/);
  await page.getByRole("button", { name: "Create key" }).click();
  await expectFieldError(
    page,
    input,
    /Name the machine or job this key is for\./,
  );
  // Editing clears the invalid state.
  await input.fill("x");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Escape");
});

test("New User server conflicts are associated with the username field", async ({
  context,
  page,
  baseURL,
}) => {
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/users");
  await page.getByRole("button", { name: "New user" }).click();
  const input = page
    .getByRole("dialog")
    .getByLabel("Username", { exact: true });
  // A real 409 from the real backend.
  await input.fill(ADMIN.username);
  await page.getByRole("button", { name: "Create user" }).click();
  await expectFieldError(page, input, /That username is already taken\./);
  await page.keyboard.press("Escape");
});
