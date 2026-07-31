import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { AuthProvider, useAuth } from "@/lib/auth-context";
import { AdminGate, ConsoleNav } from "./ConsoleShell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

function WhoAmI() {
  const { user } = useAuth();
  return <p>signed in as {user.username}</p>;
}

test("AuthProvider loads the session and renders children with the user", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => meResponse("member", "jordan")),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <WhoAmI />
    </AuthProvider>,
  );
  expect(await screen.findByText("signed in as jordan")).toBeTruthy();
});

test("AuthProvider reports unauthenticated sessions instead of rendering", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "unauthorized",
              message: "A valid bearer token is required",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    ),
  );
  const onUnauthenticated = vi.fn();
  render(
    <AuthProvider onUnauthenticated={onUnauthenticated}>
      <WhoAmI />
    </AuthProvider>,
  );
  await waitFor(() => expect(onUnauthenticated).toHaveBeenCalled());
  expect(screen.queryByText(/signed in as/)).toBeNull();
});

test("members never see the Users nav item; admins do", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => meResponse("member", "jordan")),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <ConsoleNav active="files" />
    </AuthProvider>,
  );
  await screen.findByRole("link", { name: "Files" });
  expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
  cleanup();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => meResponse("admin", "ops-admin")),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <ConsoleNav active="files" />
    </AuthProvider>,
  );
  expect(await screen.findByRole("link", { name: "Users" })).toBeTruthy();
});

test("AdminGate shows a truthful permission-denied state to members", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => meResponse("member", "jordan")),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <AdminGate>
        <p>directory</p>
      </AdminGate>
    </AuthProvider>,
  );
  expect(await screen.findByText("403 · NOT ALLOWED")).toBeTruthy();
  expect(
    screen.getByText("User management requires an admin account."),
  ).toBeTruthy();
  expect(screen.getByText(/signed in as jordan \(member\)/i)).toBeTruthy();
  expect(screen.queryByText("directory")).toBeNull();
});

test("AdminGate renders admin content for admins", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => meResponse("admin", "ops-admin")),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <AdminGate>
        <p>directory</p>
      </AdminGate>
    </AuthProvider>,
  );
  expect(await screen.findByText("directory")).toBeTruthy();
});
