import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { AuthProvider } from "@/lib/auth-context";
import { ApiKeysView } from "./ApiKeys";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const memberUser = {
  id: "u-member",
  username: "sam-ops",
  role: "member",
  active: true,
  created_at: "2026-06-30T08:00:00.000Z",
  updated_at: "2026-06-30T08:00:00.000Z",
};

const activeKey = {
  id: "k1",
  user_id: "u-member",
  name: "ingest-pipeline",
  prefix: "fsk_e5f6aaaa",
  last_four: "z9z9",
  created_at: "2026-06-12T10:00:00.000Z",
  last_used_at: "2026-07-30T10:00:00.000Z",
  revoked_at: null,
};

const revokedKey = {
  id: "k2",
  user_id: "u-member",
  name: "old-desktop",
  prefix: "fsk_j9k0bbbb",
  last_four: "x1x1",
  created_at: "2026-02-08T10:00:00.000Z",
  last_used_at: "2026-03-14T10:00:00.000Z",
  revoked_at: "2026-04-02T10:00:00.000Z",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memberRoutes(
  overrides: {
    keys?: () => Response;
    create?: () => Response;
    del?: () => Response;
  } = {},
) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (input === "/api/auth/me") {
      return json(200, {
        user: memberUser,
        legacy_service_credential: false,
        role: "member",
      });
    }
    if (input === "/api/api-keys" && method === "GET") {
      return overrides.keys
        ? overrides.keys()
        : json(200, { api_keys: [activeKey, revokedKey] });
    }
    if (input === "/api/api-keys" && method === "POST") {
      return overrides.create
        ? overrides.create()
        : json(201, {
            api_key: { id: "k3", secret: "fsk_TESTSECRET-not-a-real-key" },
          });
    }
    if (input.startsWith("/api/api-keys/") && method === "DELETE") {
      return overrides.del
        ? overrides.del()
        : new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${input}`);
  };
}

function renderKeys() {
  return render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <ApiKeysView />
    </AuthProvider>,
  );
}

test("lists key metadata only — masked prefix and tail, explicit status words", async () => {
  vi.stubGlobal("fetch", vi.fn(memberRoutes()));
  renderKeys();
  expect(
    await screen.findByRole("cell", { name: "ingest-pipeline" }),
  ).toBeTruthy();
  expect(screen.getByText("fsk_e5f6 ···· z9z9")).toBeTruthy();
  expect(screen.getAllByText("active").length).toBeGreaterThan(0);
  expect(
    screen.getByRole("cell", { name: /revoked · Apr 2, 2026/ }),
  ).toBeTruthy();
  // Revoked rows keep no revoke action.
  const revokeButtons = screen.getAllByRole("button", { name: /^Revoke/ });
  expect(revokeButtons).toHaveLength(1);
});

test("empty state explains what keys are for", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(memberRoutes({ keys: () => json(200, { api_keys: [] }) })),
  );
  renderKeys();
  expect(await screen.findByText("No API keys yet")).toBeTruthy();
  expect(screen.getByText(/fs auth set/)).toBeTruthy();
});

test("load failure names the call, states nothing changed, and Retry refetches", async () => {
  let failures = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      memberRoutes({
        keys: () => {
          if (failures > 0) {
            failures -= 1;
            return json(500, {
              error: { code: "internal_error", message: "boom" },
            });
          }
          return json(200, { api_keys: [activeKey] });
        },
      }),
    ),
  );
  renderKeys();
  expect(await screen.findByText("Couldn't load keys")).toBeTruthy();
  expect(screen.getByText(/GET \/api\/api-keys → 500/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("cell", { name: "ingest-pipeline" }),
  ).toBeTruthy();
});

test("create shows the secret exactly once behind an explicit acknowledgement", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  vi.stubGlobal("fetch", vi.fn(memberRoutes()));
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });

  await userEvent.click(screen.getByRole("button", { name: "New key" }));
  await userEvent.type(
    screen.getByLabelText(/Name — where will this key live\?/),
    "laptop-mbp",
  );
  await userEvent.click(screen.getByRole("button", { name: "Create key" }));

  expect(await screen.findByText("fsk_TESTSECRET-not-a-real-key")).toBeTruthy();
  expect(screen.getByText(/only time the full key is shown/i)).toBeTruthy();

  const done = screen.getByRole("button", {
    name: "Done",
  }) as HTMLButtonElement;
  expect(done.disabled).toBe(true);

  await userEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith("fsk_TESTSECRET-not-a-real-key");
  expect(await screen.findByText("copied ✓")).toBeTruthy();

  await userEvent.click(
    screen.getByRole("checkbox", {
      name: /I've stored this key — it won't be shown again\./,
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Done" }));

  await waitFor(() =>
    expect(screen.queryByText("fsk_TESTSECRET-not-a-real-key")).toBeNull(),
  );
});

test("closing the secret dialog without acknowledging warns first", async () => {
  vi.stubGlobal("fetch", vi.fn(memberRoutes()));
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  await userEvent.click(screen.getByRole("button", { name: "New key" }));
  await userEvent.type(
    screen.getByLabelText(/Name — where will this key live\?/),
    "laptop-mbp",
  );
  await userEvent.click(screen.getByRole("button", { name: "Create key" }));
  await screen.findByText("fsk_TESTSECRET-not-a-real-key");

  await userEvent.keyboard("{Escape}");
  expect(screen.getByText(/haven't confirmed/i)).toBeTruthy();
  expect(screen.getByText("fsk_TESTSECRET-not-a-real-key")).toBeTruthy();

  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByText("fsk_TESTSECRET-not-a-real-key")).toBeNull(),
  );
});

test("revoking asks for confirmation that names the key before deleting", async () => {
  const deletions: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith("/api/api-keys/") && init?.method === "DELETE") {
        deletions.push(input);
        return new Response(null, { status: 204 });
      }
      return memberRoutes()(input, init);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });

  await userEvent.click(screen.getByRole("button", { name: /^Revoke/ }));
  expect(
    await screen.findByRole("dialog", { name: "Revoke ingest-pipeline?" }),
  ).toBeTruthy();
  expect(screen.getByText(/exit 3/)).toBeTruthy();
  expect(deletions).toEqual([]);

  await userEvent.click(screen.getByRole("button", { name: "Revoke key" }));
  await waitFor(() => expect(deletions).toEqual(["/api/api-keys/k1"]));
});

test("admins see the owner column and the subordinate legacy token note", async () => {
  const adminUser = {
    ...memberUser,
    id: "u-admin",
    username: "ops-admin",
    role: "admin",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (input === "/api/auth/me") {
        return json(200, {
          user: adminUser,
          legacy_service_credential: false,
          role: "admin",
        });
      }
      if (input === "/api/users" && method === "GET") {
        return json(200, {
          users: [adminUser, memberUser],
        });
      }
      if (input.startsWith("/api/api-keys?user_id=u-admin")) {
        return json(200, { api_keys: [] });
      }
      if (input.startsWith("/api/api-keys?user_id=u-member")) {
        return json(200, { api_keys: [activeKey] });
      }
      throw new Error(`unexpected ${method} ${input}`);
    }),
  );
  renderKeys();
  expect(
    await screen.findByRole("cell", { name: "ingest-pipeline" }),
  ).toBeTruthy();
  expect(screen.getByText("Owner")).toBeTruthy();
  expect(screen.getByText("sam-ops")).toBeTruthy();
  expect(screen.getByText("Legacy service token")).toBeTruthy();
  expect(screen.getByText(/never shown/i)).toBeTruthy();
});

test("members see no owner column and no legacy token section", async () => {
  vi.stubGlobal("fetch", vi.fn(memberRoutes()));
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  expect(screen.queryByText("Owner")).toBeNull();
  expect(screen.queryByText("Legacy service token")).toBeNull();
});
