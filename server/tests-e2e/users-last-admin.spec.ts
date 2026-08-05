import { expect, test } from "@playwright/test";

import {
  ADMIN,
  LEGACY_TOKEN,
  apiContext,
  ensureUser,
  signInContext,
} from "./helpers";

async function keepOnlyFixtureAdminActive(baseURL: string) {
  const api = await apiContext(baseURL);
  const listing = await api.get("/api/users", {
    headers: { authorization: ["Bearer", LEGACY_TOKEN].join(" ") },
  });
  expect(listing.status()).toBe(200);
  const users = (
    (await listing.json()) as {
      users: Array<{
        id: string;
        username: string;
        role: "admin" | "member";
        active: boolean;
      }>;
    }
  ).users;
  for (const user of users) {
    if (
      user.role === "admin" &&
      user.active &&
      user.username !== ADMIN.username
    ) {
      const response = await api.patch(`/api/users/${user.id}`, {
        data: { active: false },
        headers: { authorization: ["Bearer", LEGACY_TOKEN].join(" ") },
      });
      expect(response.status()).toBe(200);
    }
  }
  await api.dispose();
}

test("desktop last-admin detail is protected while role conflict remains keyboard reachable", async ({
  context,
  page,
  baseURL,
}) => {
  await keepOnlyFixtureAdminActive(baseURL!);
  const member = await ensureUser(baseURL!, "detail-active-member", "member");
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.goto("/users");

  await page.getByRole("button", { name: /e2e-admin · you/ }).click();
  const actions = page.getByRole("region", { name: "Admin actions" });
  await expect(
    actions.getByText("last admin · protected — cannot disable"),
  ).toBeVisible();
  await expect(
    actions.getByRole("button", { name: "Disable account…" }),
  ).toHaveCount(0);

  const changeRole = actions.getByRole("button", { name: "Change role…" });
  await changeRole.focus();
  await expect(changeRole).toBeFocused();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", {
    name: "Make e2e-admin a member?",
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Change role" }).click();
  const conflict = page.getByRole("dialog", {
    name: "Can't demote e2e-admin",
  });
  await expect(
    conflict.getByText("e2e-admin is the last active admin."),
  ).toBeVisible();
  await conflict.getByRole("button", { name: "OK" }).click();
  await expect(changeRole).toBeFocused();

  await page
    .getByRole("button", { name: member.username, exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Admin actions" })
      .getByRole("button", { name: "Disable account…" }),
  ).toBeVisible();
});

test("mobile rows retain protected last-admin and active-member actions", async ({
  context,
  page,
  baseURL,
}) => {
  await keepOnlyFixtureAdminActive(baseURL!);
  const member = await ensureUser(baseURL!, "mobile-active-member", "member");
  await signInContext(context, baseURL!, ADMIN.username, ADMIN.password);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/users");

  const adminRow = page
    .getByRole("button", { name: /e2e-admin · you/ })
    .locator("xpath=ancestor::tr");
  await expect(adminRow).toContainText("last admin");
  await expect(adminRow).toContainText("protected");
  await expect(
    adminRow.getByRole("button", { name: /Actions for e2e-admin/ }),
  ).toHaveCount(0);

  const memberRow = page
    .getByRole("button", { name: member.username, exact: true })
    .locator("xpath=ancestor::tr");
  await memberRow
    .getByRole("button", { name: `Actions for ${member.username}` })
    .click();
  const sheet = page.getByRole("dialog", { name: member.username });
  await expect(
    sheet.getByRole("button", { name: "Disable account…" }),
  ).toBeVisible();
});
