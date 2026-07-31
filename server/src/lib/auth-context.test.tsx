import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiFetch } from "@/lib/api";
import { AuthProvider, SESSION_MARKER_KEY, useAuth } from "@/lib/auth-context";
import { ConsoleNav } from "@/ui/ConsoleShell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  // The sign-out probe appends result notes directly to <body>.
  document.querySelectorAll("body > p").forEach((node) => node.remove());
});

function meResponse(role: "admin" | "member", username: string): Response {
  return new Response(
    JSON.stringify({
      user: {
        id: `id-${username}`,
        username,
        role,
        active: true,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
      legacy_service_credential: false,
      role,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function SignOutProbe() {
  const { user, signOut } = useAuth();
  return (
    <div>
      <p>signed in as {user.username}</p>
      <button
        type="button"
        onClick={() => {
          void signOut().then((result) => {
            const note = document.createElement("p");
            note.textContent = result.ok ? "sign-out-ok" : "sign-out-failed";
            document.body.append(note);
          });
        }}
      >
        Sign out
      </button>
    </div>
  );
}

test("failed logout keeps the authenticated state, marker, and reports failure", async () => {
  window.localStorage.setItem(SESSION_MARKER_KEY, "1");
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/me") return meResponse("admin", "ops-admin");
    if (url === "/api/auth/logout" && init?.method === "POST") {
      throw new TypeError("network down");
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onUnauthenticated = vi.fn();
  render(
    <AuthProvider onUnauthenticated={onUnauthenticated}>
      <SignOutProbe />
    </AuthProvider>,
  );

  await userEvent.click(
    await screen.findByRole("button", { name: "Sign out" }),
  );

  await screen.findByText("sign-out-failed");
  // Still authenticated: children still render, no signed-out redirect,
  // and the session marker survives for future expiry detection.
  expect(screen.getByText("signed in as ops-admin")).toBeTruthy();
  expect(onUnauthenticated).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(SESSION_MARKER_KEY)).toBe("1");
});

test("a 5xx logout is a failure, not a signed-out state", async () => {
  window.localStorage.setItem(SESSION_MARKER_KEY, "1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return meResponse("admin", "ops-admin");
      if (url === "/api/auth/logout" && init?.method === "POST") {
        return errorResponse(500, "internal_error");
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
  const onUnauthenticated = vi.fn();
  render(
    <AuthProvider onUnauthenticated={onUnauthenticated}>
      <SignOutProbe />
    </AuthProvider>,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign out" }),
  );
  await screen.findByText("sign-out-failed");
  expect(onUnauthenticated).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(SESSION_MARKER_KEY)).toBe("1");
});

test("a 204 logout succeeds, clears the marker, and reports signed-out", async () => {
  window.localStorage.setItem(SESSION_MARKER_KEY, "1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return meResponse("admin", "ops-admin");
      if (url === "/api/auth/logout" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
  const onUnauthenticated = vi.fn();
  render(
    <AuthProvider onUnauthenticated={onUnauthenticated}>
      <SignOutProbe />
    </AuthProvider>,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign out" }),
  );
  await screen.findByText("sign-out-ok");
  expect(onUnauthenticated).toHaveBeenCalledWith("signed-out");
  expect(window.localStorage.getItem(SESSION_MARKER_KEY)).toBeNull();
});

test("a 401 logout means the session is already dead — that is a success", async () => {
  window.localStorage.setItem(SESSION_MARKER_KEY, "1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return meResponse("admin", "ops-admin");
      if (url === "/api/auth/logout" && init?.method === "POST") {
        return errorResponse(401, "unauthorized");
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
  const onUnauthenticated = vi.fn();
  render(
    <AuthProvider onUnauthenticated={onUnauthenticated}>
      <SignOutProbe />
    </AuthProvider>,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign out" }),
  );
  await screen.findByText("sign-out-ok");
  expect(onUnauthenticated).toHaveBeenCalledWith("signed-out");
});

test("cross-tab storage changes to the session marker replace the identity", async () => {
  let currentRole: "admin" | "member" = "admin";
  let currentName = "ops-admin";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return meResponse(currentRole, currentName);
      throw new Error(`unexpected ${url}`);
    }),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <ConsoleNav active="files" />
    </AuthProvider>,
  );
  expect(await screen.findByRole("link", { name: "Users" })).toBeTruthy();

  // Another tab signs in as a member; the storage event must trigger an
  // identity refresh, and the admin-only nav must disappear.
  currentRole = "member";
  currentName = "jordan";
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: SESSION_MARKER_KEY, newValue: "1" }),
    );
  });
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull(),
  );
  expect(screen.getByText(/jordan/)).toBeTruthy();
});

test("window focus refreshes the identity, but not more than once per interval", async () => {
  let role: "admin" | "member" = "admin";
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/auth/me") return meResponse(role, "ops-admin");
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <ConsoleNav active="files" />
    </AuthProvider>,
  );
  await screen.findByRole("link", { name: "Users" });
  const callsAfterMount = fetchMock.mock.calls.length;

  // Immediately after mount a focus event must NOT storm the API.
  act(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(fetchMock.mock.calls.length).toBe(callsAfterMount);

  // Once the interval has passed, focus refreshes and role drift lands.
  role = "member";
  const realNow = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(realNow + 60_000);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull(),
  );
});

test("an authoritative 403 triggers an identity refresh before further admin rendering", async () => {
  let role: "admin" | "member" = "admin";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return meResponse(role, "ops-admin");
      if (url === "/api/users") return errorResponse(403, "forbidden");
      throw new Error(`unexpected ${url}`);
    }),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <ConsoleNav active="files" />
    </AuthProvider>,
  );
  await screen.findByRole("link", { name: "Users" });

  // The user was demoted out of band; the next admin call 403s.
  role = "member";
  await act(async () => {
    await apiFetch("/api/users").catch(() => undefined);
  });
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull(),
  );
});
