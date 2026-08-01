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
  expect(
    screen.getByText(/signs out every session.*API keys keep working/i),
  ).toBeTruthy();
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
  const error = await screen.findByText("Current password is invalid.");
  const current = screen.getByLabelText("Current password");
  expect(current.getAttribute("aria-invalid")).toBe("true");
  expect(current.getAttribute("aria-describedby")).toBe(error.id);
  // Wrong credentials never masquerade as a dead session.
  expect(screen.queryByText(/sign in again/i)).toBeNull();
  expect(screen.queryByRole("link", { name: /go to sign in/i })).toBeNull();
});

test("a dead-session 401 asks for re-authentication instead of blaming the current password", async () => {
  stubFetch((url, init) => {
    const known = meRoute(url);
    if (known) return known;
    if (url === "/api/auth/password" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          error: {
            code: "unauthorized",
            message: "A valid bearer token is required",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
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

  expect(
    await screen.findByText("Session ended — password not changed."),
  ).toBeTruthy();
  expect(
    screen.getByText(/sign in again to change your password/i),
  ).toBeTruthy();
  const link = screen.getByRole("link", { name: /go to sign in/i });
  expect(link.getAttribute("href")).toBe("/login?next=%2Faccount");
  // The credential was not judged — the field carries no false blame.
  expect(screen.queryByText("Current password is invalid.")).toBeNull();
  const current = screen.getByLabelText("Current password") as HTMLInputElement;
  expect(current.getAttribute("aria-invalid")).toBeNull();
  expect(current.getAttribute("aria-describedby")).toBeNull();
  // A dead-session page keeps no typed credentials around.
  expect(current.value).toBe("");
  expect(
    (screen.getByLabelText("New password") as HTMLInputElement).value,
  ).toBe("");
  // Only the genuine lost-response transition moves focus.
  expect(document.activeElement).not.toBe(link);
});

test("a delivered server error says the change was not applied, never that the response was lost", async () => {
  stubFetch((url, init) => {
    const known = meRoute(url);
    if (known) return known;
    if (url === "/api/auth/password" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          error: {
            code: "internal_error",
            message: "The server could not complete the request",
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
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

  expect(await screen.findByText("Password not changed.")).toBeTruthy();
  expect(
    screen.getByText(/the server returned an error and did not apply/i),
  ).toBeTruthy();
  // The response arrived — no lost-response or unknown-outcome guidance.
  expect(screen.queryByText(/response was lost/i)).toBeNull();
  expect(screen.queryByText(/outcome unknown/i)).toBeNull();
  expect(screen.queryByText(/may have changed/i)).toBeNull();
  expect(screen.queryByRole("link", { name: /go to sign in/i })).toBeNull();
  // The failure belongs to the server, not the current-password field…
  const current = screen.getByLabelText("Current password") as HTMLInputElement;
  expect(current.getAttribute("aria-invalid")).toBeNull();
  // …and the typed credentials stay so retrying is one click.
  expect(current.value).toBe("old password!!");
  expect(
    (
      screen.getByRole("button", {
        name: "Change password",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test("a delivered non-credential 400 never marks the current-password field", async () => {
  stubFetch((url, init) => {
    const known = meRoute(url);
    if (known) return known;
    if (url === "/api/auth/password" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_request",
            message: "The request could not be processed",
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

  expect(await screen.findByText("Password not changed.")).toBeTruthy();
  expect(screen.queryByText("The request could not be processed.")).toBeNull();
  const current = screen.getByLabelText("Current password");
  expect(current.getAttribute("aria-invalid")).toBeNull();
  expect(current.getAttribute("aria-describedby")).toBeNull();
});

test("an unavailable password-change response reports an unknown outcome with safe recovery", async () => {
  stubFetch((url) => {
    const known = meRoute(url);
    if (known) return known;
    throw new TypeError("response delivery was lost");
  });
  renderAccount();
  await screen.findByText("jordan");
  await fillPasswords("old password!!", "new password 123", "new password 123");
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );

  expect(
    await screen.findByText("Password change outcome unknown."),
  ).toBeTruthy();
  expect(
    screen.getByText(
      /may have changed and every browser session may have been signed out/i,
    ),
  ).toBeTruthy();
  const recovery = screen.getByRole("link", { name: /go to sign in/i });
  expect(recovery.getAttribute("href")).toBe("/login?next=%2Faccount");
  expect(screen.queryByText(/password not changed/i)).toBeNull();
  expect(screen.queryByText(/current password still works/i)).toBeNull();
  expect(
    (screen.getByLabelText("Current password") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (screen.getByLabelText("New password") as HTMLInputElement).value,
  ).toBe("");
  // Keyboard position lands on the recovery action, not the document body.
  await waitFor(() => expect(document.activeElement).toBe(recovery));
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

test("editing a rejected current password clears the stale field judgment", async () => {
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
  await screen.findByText("Current password is invalid.");

  const current = screen.getByLabelText("Current password");
  await userEvent.clear(current);
  await userEvent.type(current, "corrected password!");

  expect(screen.queryByText("Current password is invalid.")).toBeNull();
  expect(current.getAttribute("aria-invalid")).toBeNull();
  expect(current.getAttribute("aria-describedby")).toBeNull();
});

test("editing either new-password value clears a stale mismatch judgment", async () => {
  stubFetch((url) => {
    const known = meRoute(url);
    if (known) return known;
    return new Response(null, { status: 204 });
  });
  renderAccount();
  await screen.findByText("jordan");
  await fillPasswords("old password!", "new password 123", "new password 124");
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );
  await screen.findByText("Doesn't match the new password.");

  const next = screen.getByLabelText("New password");
  const confirmation = screen.getByLabelText("Confirm new password");
  await userEvent.clear(next);
  await userEvent.type(next, "new password 124");

  expect(screen.queryByText("Doesn't match the new password.")).toBeNull();
  expect(confirmation.getAttribute("aria-invalid")).toBeNull();
  expect(confirmation.getAttribute("aria-describedby")).toBeNull();
});

test("an unstructured gateway 502 is conservative because an origin commit may be hidden", async () => {
  stubFetch((url, init) => {
    const known = meRoute(url);
    if (known) return known;
    if (url === "/api/auth/password" && init?.method === "POST") {
      return new Response("<html>Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    }
    throw new Error(`unexpected ${url}`);
  });
  renderAccount();
  await screen.findByText("jordan");
  await fillPasswords("old password!!", "new password 123", "new password 123");
  await userEvent.click(
    screen.getByRole("button", { name: "Change password" }),
  );

  expect(
    await screen.findByText("Password change outcome unknown."),
  ).toBeTruthy();
  expect(screen.queryByText("Password not changed.")).toBeNull();
  const recovery = screen.getByRole("link", { name: /go to sign in/i });
  await waitFor(() => expect(document.activeElement).toBe(recovery));
  expect(
    (screen.getByLabelText("Current password") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (screen.getByLabelText("New password") as HTMLInputElement).value,
  ).toBe("");
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
