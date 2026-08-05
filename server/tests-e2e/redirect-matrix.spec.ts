import { expect, test, type Page } from "@playwright/test";

import { ensureUser, nextAddress } from "./helpers";

// P1-2 regression: the post-login `next` redirect must never leave the
// configured origin. The exhaustive bypass matrix lives in the
// next-path unit tests; this exercises the real browser URL parser on the
// representative attack shapes.

async function loginThrough(
  page: Page,
  baseURL: string,
  next: string,
  username: string,
  password: string,
): Promise<void> {
  // Unique synthetic client address per attempt so the backend's address
  // throttle never couples the matrix cases.
  const address = nextAddress();
  await page.route("**/api/auth/login", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-real-ip": address },
    }),
  );
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 10_000,
  });
}

test("hostile next values fall back to /files; safe ones keep query and hash", async ({
  browser,
  baseURL,
}) => {
  const user = await ensureUser(baseURL!, "redirect-member", "member");
  const cases: Array<{ next: string; expected: string }> = [
    { next: "/\\\\example.invalid/audit", expected: "/files" },
    { next: "//evil.example/x", expected: "/files" },
    { next: "https://evil.example/files", expected: "/files" },
    { next: "/%5C%5Cexample.invalid/audit", expected: "/files" },
    { next: "/keys?owner=me#row", expected: "/keys?owner=me#row" },
  ];
  for (const { next, expected } of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginThrough(page, baseURL!, next, user.username, user.password);
    const url = new URL(page.url());
    expect(url.origin, `origin for next=${next}`).toBe(
      new URL(baseURL!).origin,
    );
    expect(
      `${url.pathname}${url.search}${url.hash}`,
      `target for next=${next}`,
    ).toBe(expected);
    await context.close();
  }
});
