import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { LoginForm } from "./LoginForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const user = {
  id: "u1",
  username: "ops-admin",
  role: "admin",
  active: true,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

test("successful sign-in posts credentials and reports the signed-in user", async () => {
  const fetchMock = vi.fn(async () =>
    jsonResponse(200, { user, expires_at: "2026-08-07T00:00:00.000Z" }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const onSuccess = vi.fn();
  render(<LoginForm onSuccess={onSuccess} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse batt");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(onSuccess).toHaveBeenCalledWith(
    expect.objectContaining({ username: "ops-admin", role: "admin" }),
    "2026-08-07T00:00:00.000Z",
  );
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe("/api/auth/login");
  expect(JSON.parse(init.body as string)).toEqual({
    username: "ops-admin",
    password: "correct horse batt",
  });
});

test("invalid credentials show one generic error, clear the password, keep the username", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(401, {
        error: {
          code: "invalid_credentials",
          message: "Invalid username or password",
        },
      }),
    ),
  );
  render(<LoginForm onSuccess={vi.fn()} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "wrong password!!");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(screen.getByText("Username or password is incorrect.")).toBeTruthy();
  expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe(
    "ops-admin",
  );
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
    "",
  );
});

test("throttled sign-in states the lock in words and disables the submit", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(429, {
        error: {
          code: "login_throttled",
          message: "Too many login attempts; try again later",
        },
      }),
    ),
  );
  render(<LoginForm onSuccess={vi.fn()} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "wrong password!!");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(screen.getByText("Too many attempts.")).toBeTruthy();
  expect(screen.getByText(/locked for this address/i).textContent).toMatch(
    /try again/i,
  );
  const locked = screen.getByRole("button", {
    name: "Sign in — locked",
  }) as HTMLButtonElement;
  expect(locked.disabled).toBe(true);
});

test("delivered server errors name the status and keep the form usable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(500, {
        error: {
          code: "internal_error",
          message: "An internal server error occurred",
        },
      }),
    ),
  );
  render(<LoginForm onSuccess={vi.fn()} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "some password!!!");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(screen.getByText(/couldn't sign you in \(500\)/i)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("a committed login whose response is lost verifies the session and completes sign-in", async () => {
  const fetchMock = vi.fn(async (input: string) => {
    if (input === "/api/auth/login") {
      // The POST reached the server and the session cookie was applied,
      // but the response body was lost in transit.
      throw new TypeError("network response lost");
    }
    if (input === "/api/auth/me") {
      return jsonResponse(200, {
        user,
        legacy_service_credential: false,
        role: "admin",
      });
    }
    throw new Error(`unexpected ${input}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onSuccess = vi.fn();
  render(<LoginForm onSuccess={onSuccess} />);

  await userEvent.type(screen.getByLabelText("Username"), "OPS-ADMIN");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse batt");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  // The authoritative session record confirms the intended user — the
  // login completes through the normal success path.
  expect(onSuccess).toHaveBeenCalledWith(
    expect.objectContaining({ username: "ops-admin" }),
    undefined,
  );
  expect(screen.queryByText(/nothing was changed/i)).toBeNull();
});

test("an unreachable server yields a truthful unknown outcome, never an absolute claim", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("network down");
    }),
  );
  const onSuccess = vi.fn();
  render(<LoginForm onSuccess={onSuccess} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse batt");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(onSuccess).not.toHaveBeenCalled();
  expect(
    screen.getByText(/couldn't confirm whether sign-in completed/i),
  ).toBeTruthy();
  expect(screen.queryByText(/nothing was changed/i)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("a delivered reconciliation error says the server errored, never that it didn't respond", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/auth/login") throw new TypeError("network drop");
      if (input === "/api/auth/me") {
        // The probe response WAS delivered — it was a server failure.
        return jsonResponse(500, {
          error: {
            code: "internal_error",
            message: "An internal server error occurred",
          },
        });
      }
      throw new Error(`unexpected ${input}`);
    }),
  );
  const onSuccess = vi.fn();
  render(<LoginForm onSuccess={onSuccess} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse batt");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(onSuccess).not.toHaveBeenCalled();
  // The outcome is still unknown and retry stays safe…
  expect(
    screen.getByText(/couldn't confirm whether sign-in completed/i),
  ).toBeTruthy();
  // …but the causal clause must be truthful: the server answered.
  expect(screen.getByText(/server returned an error/i)).toBeTruthy();
  expect(screen.queryByText(/server didn't respond/i)).toBeNull();
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  expect(password.value).toBe("");
  expect(document.activeElement).toBe(password);
  expect(
    (screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("a lost response with no committed session reports not signed in and offers retry", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/auth/login") throw new TypeError("network drop");
      if (input === "/api/auth/me") {
        return jsonResponse(401, {
          error: { code: "unauthorized", message: "unauthorized" },
        });
      }
      throw new Error(`unexpected ${input}`);
    }),
  );
  const onSuccess = vi.fn();
  render(<LoginForm onSuccess={onSuccess} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse batt");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(onSuccess).not.toHaveBeenCalled();
  // The authoritative probe found no session: truthful "not signed in"
  // wording, still no absolute claim about what the server did.
  expect(screen.getByText(/you're not signed in/i)).toBeTruthy();
  expect(screen.queryByText(/nothing was changed/i)).toBeNull();
});

test("a session for a different user never completes the intended sign-in", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/auth/login") throw new TypeError("network drop");
      if (input === "/api/auth/me") {
        return jsonResponse(200, {
          user: { ...user, username: "someone-else" },
          legacy_service_credential: false,
          role: "member",
        });
      }
      throw new Error(`unexpected ${input}`);
    }),
  );
  const onSuccess = vi.fn();
  render(<LoginForm onSuccess={onSuccess} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse batt");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(onSuccess).not.toHaveBeenCalled();
  expect(screen.getByText(/still signed in as someone-else/i)).toBeTruthy();
  expect(screen.queryByText(/server didn't respond/i)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("session-expired mode shows the banner and prefills the username", () => {
  render(
    <LoginForm
      onSuccess={vi.fn()}
      notice="session-expired"
      initialUsername="ops-admin"
    />,
  );
  expect(
    screen.getByText("Session expired — sign in again to continue."),
  ).toBeTruthy();
  expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe(
    "ops-admin",
  );
});

test("password-changed mode states the true reason and never claims expiry", () => {
  render(
    <LoginForm
      onSuccess={vi.fn()}
      notice="password-changed"
      initialUsername="ops-admin"
    />,
  );
  expect(
    screen.getByText(
      "Password changed — sign in again with your new password.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/session expired/i)).toBeNull();
});

test("throttled sign-in clears and refocuses the password field", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(429, {
        error: {
          code: "login_throttled",
          message: "Too many login attempts; try again later",
        },
      }),
    ),
  );
  render(<LoginForm onSuccess={vi.fn()} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "wrong password!!");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  const password = screen.getByLabelText("Password") as HTMLInputElement;
  expect(password.value).toBe("");
  expect(document.activeElement).toBe(password);
});

test("throttle warning says try again later without a fabricated countdown", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(429, {
        error: {
          code: "login_throttled",
          message: "Too many login attempts; try again later",
        },
      }),
    ),
  );
  render(<LoginForm onSuccess={vi.fn()} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "wrong password!!");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(screen.getByText(/try again later/i)).toBeTruthy();
  expect(screen.queryByText(/\d+\s*(min|s\b|second)/i)).toBeNull();
});

test("editing after a throttle keeps the truthful lock warning but re-enables retry", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(429, {
        error: {
          code: "login_throttled",
          message: "Too many login attempts; try again later",
        },
      }),
    ),
  );
  render(<LoginForm onSuccess={vi.fn()} />);

  await userEvent.type(screen.getByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "wrong password!!");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  await userEvent.type(screen.getByLabelText("Password"), "another try!!");

  // The server lock has not lifted just because the user typed — the
  // warning stays visible; only the submit becomes available again.
  expect(screen.getByText("Too many attempts.")).toBeTruthy();
  const submit = screen.getByRole("button", {
    name: "Sign in",
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
});
