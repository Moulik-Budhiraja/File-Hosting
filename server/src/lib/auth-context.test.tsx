import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiFetch } from "@/lib/api";
import { AuthProvider, SESSION_MARKER_KEY, useAuth } from "@/lib/auth-context";
import {
  publishSessionChange,
  SESSION_VERSION_KEY,
} from "@/lib/session-signal";
import { ConsoleNav } from "@/ui/ConsoleShell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
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

test("a cross-tab session-version storage write replaces the identity immediately", async () => {
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

  // Another tab publishes a changed session version (different account
  // signed in). No focus, no marker event — the version signal alone must
  // refresh, even though the last read was recent.
  currentRole = "member";
  currentName = "casey";
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: SESSION_VERSION_KEY,
        newValue: "fresh-version-from-tab-b",
      }),
    );
  });
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull(),
  );
  expect(screen.getByText(/casey/)).toBeTruthy();
});

test("a BroadcastChannel session publish replaces the identity without storage", async () => {
  let currentRole: "admin" | "member" = "admin";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return meResponse(currentRole, "ops-admin");
      throw new Error(`unexpected ${url}`);
    }),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <ConsoleNav active="files" />
    </AuthProvider>,
  );
  expect(await screen.findByRole("link", { name: "Users" })).toBeTruthy();

  currentRole = "member";
  // Simulates the real login/logout path in another same-origin context.
  act(() => {
    publishSessionChange();
  });
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull(),
  );
});

test("a failed background refresh keeps the rendered identity with a stale notice", async () => {
  let failing = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") {
        if (failing) return errorResponse(500, "internal_error");
        return meResponse("admin", "ops-admin");
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <ConsoleNav active="files" />
    </AuthProvider>,
  );
  expect(await screen.findByRole("link", { name: "Users" })).toBeTruthy();

  // A background refresh 5xx must NOT tear down the working UI…
  failing = true;
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: SESSION_VERSION_KEY,
        newValue: "v2",
      }),
    );
  });
  await screen.findByText(/couldn't be refreshed/i);
  expect(screen.getByRole("link", { name: "Users" })).toBeTruthy();
  expect(screen.queryByText(/couldn't load your session/i)).toBeNull();

  // …and a successful retry clears the stale notice.
  failing = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.queryByText(/couldn't be refreshed/i)).toBeNull(),
  );
  expect(screen.getByRole("link", { name: "Users" })).toBeTruthy();
});

test("an initial load failure still shows the full recoverable fallback", async () => {
  let failing = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") {
        if (failing) return errorResponse(500, "internal_error");
        return meResponse("admin", "ops-admin");
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <ConsoleNav active="files" />
    </AuthProvider>,
  );
  await screen.findByText(/couldn't load your session/i);
  failing = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("link", { name: "Users" })).toBeTruthy();
});

test("bounded background polling catches cookie drift without any events", async () => {
  let role: "admin" | "member" = "admin";
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/auth/me" || url === "/api/auth/me?probe=1")
      return meResponse(role, "ops-admin");
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  // Fake only the interval clock so RTL's own waiting keeps working.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    render(
      <AuthProvider onUnauthenticated={vi.fn()}>
        <ConsoleNav active="files" />
      </AuthProvider>,
    );
    await screen.findByRole("link", { name: "Users" });
    const callsAfterMount = fetchMock.mock.calls.length;

    // The session was replaced outside any coordinated app flow (cookie
    // change only). No focus, storage, or broadcast events fire — the
    // low-frequency poll is the safety net.
    role = "member";
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Users" })).toBeNull(),
    );
    // Bounded: one poll fired in that window, not a storm.
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount + 1);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/auth/me?probe=1");
  } finally {
    vi.useRealTimers();
  }
});

test("a visible tab reports idle expiry when its non-sliding probe expires", async () => {
  window.localStorage.setItem(SESSION_MARKER_KEY, "1");
  let probes = 0;
  const onUnauthenticated = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return meResponse("admin", "ops-admin");
      if (url === "/api/auth/me?probe=1") {
        probes += 1;
        return errorResponse(401, "unauthorized");
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    render(
      <AuthProvider onUnauthenticated={onUnauthenticated}>
        <ConsoleNav active="files" />
      </AuthProvider>,
    );
    await screen.findByRole("link", { name: "Users" });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(61_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onUnauthenticated).toHaveBeenCalledWith("session-expired");
    expect(probes).toBe(1);
  } finally {
    vi.useRealTimers();
  }
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

// A probe holding user-scoped local state (a stand-in for list rows,
// open details, and show-once secret dialogs). It must be REMOUNTED —
// state discarded — whenever the signed-in identity changes.
function UserScopedStateProbe() {
  const { user, role } = useAuth();
  const [held, setHeld] = useState("fresh");
  return (
    <div>
      <p>
        viewer {user.username} · {role}
      </p>
      <p>held {held}</p>
      <button type="button" onClick={() => setHeld("prior-user-private-data")}>
        hold
      </button>
    </div>
  );
}

test("a same-role account replacement discards user-scoped child state", async () => {
  let currentName = "member-a";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return meResponse("member", currentName);
      throw new Error(`unexpected ${url}`);
    }),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <UserScopedStateProbe />
    </AuthProvider>,
  );
  await screen.findByText("viewer member-a · member");
  await userEvent.click(screen.getByRole("button", { name: "hold" }));
  expect(screen.getByText("held prior-user-private-data")).toBeTruthy();

  // Another tab signs in as a DIFFERENT member — same role.
  currentName = "member-b";
  act(() => {
    publishSessionChange();
  });
  await screen.findByText("viewer member-b · member");
  // The prior user's held state is gone; the subtree restarted fresh.
  expect(screen.queryByText("held prior-user-private-data")).toBeNull();
  expect(screen.getByText("held fresh")).toBeTruthy();
});

function UrlTaskProbe() {
  const { user } = useAuth();
  const [initialSearch] = useState(() => window.location.search);
  return <p>{`${user.username} task ${initialSearch || "clean"}`}</p>;
}

test("a replacement identity sees a clean URL before its subtree initializes", async () => {
  let currentName = "url-member-a";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return meResponse("member", currentName);
      throw new Error(`unexpected ${url}`);
    }),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <UrlTaskProbe />
    </AuthProvider>,
  );
  await screen.findByText("url-member-a task clean");

  window.history.replaceState(
    null,
    "",
    "/files?q=private-name&visibility=private&scope=mine&cursor=old-cursor&prev=old-prev&sel=old-selection&pend=old-pending&keep=route-state",
  );
  currentName = "url-member-b";
  act(() => publishSessionChange());

  await screen.findByText("url-member-b task ?keep=route-state");
  expect(window.location.search).toBe("?keep=route-state");
});

test("the same identity preserves task URL restoration across a provider remount", async () => {
  window.history.replaceState(null, "", "/files");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return meResponse("member", "reauth-member");
      throw new Error(`unexpected ${url}`);
    }),
  );
  const first = render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <UrlTaskProbe />
    </AuthProvider>,
  );
  await screen.findByText("reauth-member task clean");
  window.history.replaceState(
    null,
    "",
    "/files?q=same-user-task&visibility=private&scope=mine&cursor=same-cursor&prev=same-prev&sel=same-selection",
  );
  first.unmount();

  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <UrlTaskProbe />
    </AuthProvider>,
  );
  await screen.findByText(
    "reauth-member task ?q=same-user-task&visibility=private&scope=mine&cursor=same-cursor&prev=same-prev&sel=same-selection",
  );
});

test("a role change for the same account also discards user-scoped child state", async () => {
  let currentRole: "admin" | "member" = "admin";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return meResponse(currentRole, "ops-admin");
      throw new Error(`unexpected ${url}`);
    }),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <UserScopedStateProbe />
    </AuthProvider>,
  );
  await screen.findByText("viewer ops-admin · admin");
  await userEvent.click(screen.getByRole("button", { name: "hold" }));
  expect(screen.getByText("held prior-user-private-data")).toBeTruthy();
  window.history.replaceState(
    null,
    "",
    "/files?q=admin-task&visibility=private&scope=everyone&cursor=admin-cursor&prev=admin-prev&sel=admin-selection&pend=admin-pending",
  );

  // Demotion out of band: rows loaded under admin privilege must not
  // survive into the member rendering.
  currentRole = "member";
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: SESSION_MARKER_KEY, newValue: "1" }),
    );
  });
  await screen.findByText("viewer ops-admin · member");
  expect(screen.queryByText("held prior-user-private-data")).toBeNull();
  expect(screen.getByText("held fresh")).toBeTruthy();
  expect(window.location.search).toBe("");
});
