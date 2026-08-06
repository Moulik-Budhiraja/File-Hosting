import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { AuthProvider } from "@/lib/auth-context";
import MorePage from "./page";

const user = (role: "admin" | "member") => ({
  id: `u-${role}`,
  username: role,
  role,
  active: true,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
});

function renderPage(role: "admin" | "member") {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: user(role),
            role,
            legacy_service_credential: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
  return render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <MorePage />
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("members only see mobile destinations they can open", async () => {
  renderPage("member");
  const more = await screen.findByRole("navigation", {
    name: "More console pages",
  });
  expect(within(more).getByRole("link", { name: "Account" })).toBeTruthy();
  expect(within(more).queryByRole("link", { name: "Users" })).toBeNull();
  expect(within(more).queryByRole("link", { name: "API Keys" })).toBeNull();
});

test("admins see every mobile console destination", async () => {
  renderPage("admin");
  const more = await screen.findByRole("navigation", {
    name: "More console pages",
  });
  expect(within(more).getByRole("link", { name: "Users" })).toBeTruthy();
  expect(within(more).getByRole("link", { name: "API Keys" })).toBeTruthy();
  expect(within(more).getByRole("link", { name: "Account" })).toBeTruthy();
});
