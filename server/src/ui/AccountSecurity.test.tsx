import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

function renderAccount(onPasswordChanged = vi.fn()) {
  return {
    onPasswordChanged,
    ...render(
      <AuthProvider onUnauthenticated={vi.fn()}>
        <AccountSecurity onPasswordChanged={onPasswordChanged} />
      </AuthProvider>,
    ),
  };
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

test("success clears the fields and routes to the truthful password-changed login state", async () => {
  stubFetch((url) => {
    const known = meRoute(url);
    if (known) return known;
    return new Response(null, { status: 204 });
  });
  const { onPasswordChanged } = renderAccount();
  await screen.findByText("jordan");
  await fillPasswords("old password!!", "new password 123", "new password 123");
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );
  await waitFor(() => expect(onPasswordChanged).toHaveBeenCalled());
  expect(
    (screen.getByLabelText("New password") as HTMLInputElement).value,
  ).toBe("");
  // The deliberate change is never mislabeled as a session expiry.
  expect(screen.queryByText(/session expired/i)).toBeNull();
});

test("a new password over 72 UTF-8 bytes is rejected on the new field without any request", async () => {
  const mutations: string[] = [];
  stubFetch((url) => {
    const known = meRoute(url);
    if (known) return known;
    mutations.push(url);
    return new Response(null, { status: 204 });
  });
  renderAccount();
  await screen.findByText("jordan");
  const emoji20 = "🔑".repeat(20); // 20 code points, 80 UTF-8 bytes
  await userEvent.type(screen.getByLabelText("Current password"), "old pass!");
  await userEvent.click(screen.getByLabelText("New password"));
  await userEvent.paste(emoji20);
  await userEvent.click(screen.getByLabelText("Confirm new password"));
  await userEvent.paste(emoji20);
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );
  expect(
    screen.getByText(/too long — 80 of 72 maximum utf-8 bytes/i),
  ).toBeTruthy();
  const newField = screen.getByLabelText("New password");
  expect(newField.getAttribute("aria-invalid")).toBe("true");
  expect(
    screen.getByLabelText("Current password").getAttribute("aria-invalid"),
  ).toBeNull();
  expect(mutations).toEqual([]);
});

test("a server invalid_password rejection maps to the new-password field", async () => {
  stubFetch((url, init) => {
    const known = meRoute(url);
    if (known) return known;
    if (url === "/api/auth/password" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_password",
            message:
              "Password must be at least 12 characters and no more than 72 UTF-8 bytes",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected ${url}`);
  });
  renderAccount();
  await screen.findByText("jordan");
  await fillPasswords("old password!!", "new password 123", "new password 123");
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );
  await screen.findByText(/must be at least 12 characters/i);
  expect(
    screen.getByLabelText("New password").getAttribute("aria-invalid"),
  ).toBe("true");
  expect(
    screen.getByLabelText("Current password").getAttribute("aria-invalid"),
  ).toBeNull();
});

test("a failed sign-out keeps the session and shows an actionable error", async () => {
  stubFetch((url, init) => {
    const known = meRoute(url);
    if (known) return known;
    if (url === "/api/auth/logout" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          error: { code: "internal_error", message: "boom" },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected ${url}`);
  });
  renderAccount();
  await screen.findByText("jordan");
  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(
    await screen.findByText(/couldn't sign out — you are still signed in/i),
  ).toBeTruthy();
  // Still authenticated: the account facts remain visible for retry.
  expect(screen.getByText("jordan")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
});
