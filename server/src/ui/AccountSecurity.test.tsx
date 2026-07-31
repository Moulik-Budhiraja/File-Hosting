import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { AuthProvider } from "@/lib/auth-context";
import { AccountSecurity } from "./AccountSecurity";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const me = {
  user: {
    id: "u2",
    username: "jordan",
    role: "member",
    active: true,
    created_at: "2026-07-18T09:00:00.000Z",
    updated_at: "2026-07-18T09:00:00.000Z",
  },
  legacy_service_credential: false,
  role: "member",
};

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => handler(url, init)),
  );
}

function meRoute(url: string): Response | null {
  if (url === "/api/auth/me") {
    return new Response(JSON.stringify(me), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

function renderAccount() {
  return render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <AccountSecurity />
    </AuthProvider>,
  );
}

async function fillPasswords(current: string, next: string, confirm: string) {
  await userEvent.type(screen.getByLabelText("Current password"), current);
  await userEvent.type(screen.getByLabelText("New password"), next);
  await userEvent.type(screen.getByLabelText("Confirm new password"), confirm);
}

test("shows account facts and signs out through the logout endpoint", async () => {
  const calls: string[] = [];
  stubFetch((url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const known = meRoute(url);
    if (known) return known;
    if (url === "/api/auth/logout") return new Response(null, { status: 204 });
    throw new Error(`unexpected ${url}`);
  });
  renderAccount();
  expect(await screen.findByText("jordan")).toBeTruthy();
  expect(screen.getByText("member")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(calls).toContain("POST /api/auth/logout");
});

test("too-short new passwords are rejected inline without any request", async () => {
  const mutations: string[] = [];
  stubFetch((url) => {
    const known = meRoute(url);
    if (known) return known;
    mutations.push(url);
    return new Response(null, { status: 204 });
  });
  renderAccount();
  await screen.findByText("jordan");
  await fillPasswords("old password!", "short", "short");
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );
  expect(
    screen.getByText("Too short — 5 of 12 minimum characters."),
  ).toBeTruthy();
  expect(mutations).toEqual([]);
});

test("mismatched confirmation is rejected inline without any request", async () => {
  const mutations: string[] = [];
  stubFetch((url) => {
    const known = meRoute(url);
    if (known) return known;
    mutations.push(url);
    return new Response(null, { status: 204 });
  });
  renderAccount();
  await screen.findByText("jordan");
  await fillPasswords("old password!", "new password 123", "new password 124");
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );
  expect(screen.getByText("Doesn't match the new password.")).toBeTruthy();
  expect(mutations).toEqual([]);
});

test("a wrong current password shows the server rejection on the field", async () => {
  stubFetch((url) => {
    const known = meRoute(url);
    if (known) return known;
    return new Response(
      JSON.stringify({
        error: {
          code: "invalid_credentials",
          message: "Current password is invalid",
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  });
  renderAccount();
  await screen.findByText("jordan");
  await fillPasswords(
    "wrong password!",
    "new password 123",
    "new password 123",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );
  expect(await screen.findByText("Current password is invalid.")).toBeTruthy();
});

test("server errors state nothing changed and preserve the form values", async () => {
  stubFetch((url) => {
    const known = meRoute(url);
    if (known) return known;
    return new Response(
      JSON.stringify({
        error: {
          code: "internal_error",
          message: "An internal server error occurred",
        },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  });
  renderAccount();
  await screen.findByText("jordan");
  await fillPasswords("old password!!", "new password 123", "new password 123");
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );
  expect(await screen.findByText("Password not changed.")).toBeTruthy();
  expect(
    screen.getByText(/couldn't complete the request \(500\)/i),
  ).toBeTruthy();
  expect(
    (screen.getByLabelText("Current password") as HTMLInputElement).value,
  ).toBe("old password!!");
});

test("success clears the fields and announces the session consequences", async () => {
  stubFetch((url) => {
    const known = meRoute(url);
    if (known) return known;
    return new Response(null, { status: 204 });
  });
  renderAccount();
  await screen.findByText("jordan");
  await fillPasswords("old password!!", "new password 123", "new password 123");
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );
  expect(await screen.findByText("Password changed.")).toBeTruthy();
  expect(
    screen.getByText(
      /all sessions were signed out — sign in again with your new password\. api keys are unaffected\./i,
    ),
  ).toBeTruthy();
  expect(
    (screen.getByLabelText("New password") as HTMLInputElement).value,
  ).toBe("");
});
