import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { AuthProvider } from "@/lib/auth-context";
import { ApiKeysView } from "./ApiKeys";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The keys view reflects task state into the URL; isolate tests.
  window.history.replaceState(null, "", "/");
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

test("browser creation is two-phase: request id, then activation after the secret arrives", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && input === "/api/api-keys") {
        const body = JSON.parse(init!.body as string) as {
          request_id?: string;
        };
        posts.push({ url: input, body });
        return json(201, {
          api_key: {
            id: "k-pending",
            name: "laptop-mbp",
            secret: "fsk_TESTSECRET-not-a-real-key",
            status: "pending",
            pending_expires_at: "2026-07-31T12:10:00.000Z",
            created: true,
          },
        });
      }
      if (method === "POST" && input === "/api/api-keys/k-pending/activate") {
        posts.push({ url: input, body: null });
        return json(200, { api_key: { id: "k-pending", status: "active" } });
      }
      return memberRoutes()(input, init);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  await userEvent.click(screen.getByRole("button", { name: "New key" }));
  await userEvent.type(
    screen.getByLabelText(/Name — where will this key live\?/),
    "laptop-mbp",
  );
  await userEvent.click(screen.getByRole("button", { name: "Create key" }));
  await screen.findByText("fsk_TESTSECRET-not-a-real-key");
  // Phase 1 carried an idempotency request id…
  const createBody = posts[0]!.body as { request_id?: string };
  expect(createBody.request_id).toBeTruthy();
  // …and phase 2 fired only after the secret reached this client.
  await waitFor(() =>
    expect(
      posts.some((post) => post.url === "/api/api-keys/k-pending/activate"),
    ).toBe(true),
  );
  expect(await screen.findByText(/key active/i)).toBeTruthy();
});

test("a lost create response reconciles truthfully — never a false 'nothing changed'", async () => {
  const createBodies: Array<{ request_id?: string }> = [];
  let firstAttempt = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && input === "/api/api-keys") {
        const body = JSON.parse(init!.body as string) as {
          request_id?: string;
        };
        createBodies.push(body);
        if (firstAttempt) {
          // The server committed, but the response never arrived.
          firstAttempt = false;
          throw new TypeError("network connection lost");
        }
        // The idempotent retry reconciles: metadata only, no plaintext.
        return json(200, {
          api_key: {
            id: "k-lost",
            name: "lost-key",
            secret: null,
            status: "pending",
            pending_expires_at: "2026-07-31T12:10:00.000Z",
            created: false,
          },
        });
      }
      return memberRoutes()(input, init);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  await userEvent.click(screen.getByRole("button", { name: "New key" }));
  await userEvent.type(
    screen.getByLabelText(/Name — where will this key live\?/),
    "lost-key",
  );
  await userEvent.click(screen.getByRole("button", { name: "Create key" }));

  // Both attempts shared one request id.
  await waitFor(() => expect(createBodies.length).toBe(2));
  expect(createBodies[0]!.request_id).toBe(createBodies[1]!.request_id);
  // Truthful outcome: the key exists as pending; no secret dialog; no
  // absolute "nothing was changed" claim.
  const message = await screen.findByText(/secret was lost/i);
  expect(message.textContent).toMatch(/pending/i);
  expect(screen.queryByText(/nothing was changed/i)).toBeNull();
  expect(screen.queryByText(/SHOWN ONLY ONCE/)).toBeNull();
});

test("a fully lost create (retry also fails) reports an unknown outcome honestly", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && input === "/api/api-keys") {
        throw new TypeError("network down");
      }
      return memberRoutes()(input, init);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  await userEvent.click(screen.getByRole("button", { name: "New key" }));
  await userEvent.type(
    screen.getByLabelText(/Name — where will this key live\?/),
    "unknown-key",
  );
  await userEvent.click(screen.getByRole("button", { name: "Create key" }));
  const message = await screen.findByText(/may not have reached the server/i);
  expect(message.textContent).toMatch(/pending/i);
  expect(screen.queryByText(/nothing was changed/i)).toBeNull();
});

test("a lost activation response is retried idempotently from the secret dialog", async () => {
  let activateAttempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && input === "/api/api-keys") {
        return json(201, {
          api_key: {
            id: "k-act",
            name: "laptop-mbp",
            secret: "fsk_TESTSECRET-not-a-real-key",
            status: "pending",
            pending_expires_at: "2026-07-31T12:10:00.000Z",
            created: true,
          },
        });
      }
      if (method === "POST" && input === "/api/api-keys/k-act/activate") {
        activateAttempts += 1;
        if (activateAttempts === 1) throw new TypeError("connection lost");
        return json(200, { api_key: { id: "k-act", status: "active" } });
      }
      return memberRoutes()(input, init);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  await userEvent.click(screen.getByRole("button", { name: "New key" }));
  await userEvent.type(
    screen.getByLabelText(/Name — where will this key live\?/),
    "laptop-mbp",
  );
  await userEvent.click(screen.getByRole("button", { name: "Create key" }));
  await screen.findByText("fsk_TESTSECRET-not-a-real-key");
  // Truthful: the key is not active yet.
  await screen.findByText(/not active/i);
  await userEvent.click(
    screen.getByRole("button", { name: /retry activation/i }),
  );
  expect(await screen.findByText(/key active/i)).toBeTruthy();
  expect(activateAttempts).toBe(2);
});

test("pending keys list truthfully and can be cancelled", async () => {
  const pendingKey = {
    id: "k-pend",
    user_id: "u-member",
    name: "half-created",
    prefix: "fsk_pend0000",
    last_four: "p1p1",
    created_at: "2026-07-31T12:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    status: "pending",
    pending_expires_at: "2026-07-31T12:10:00.000Z",
  };
  let cancelled = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (input === "/api/api-keys" && method === "GET") {
        return json(200, {
          api_keys: cancelled ? [activeKey] : [activeKey, pendingKey],
        });
      }
      if (input === "/api/api-keys/k-pend" && method === "DELETE") {
        cancelled = true;
        return new Response(null, { status: 204 });
      }
      return memberRoutes()(input, init);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "half-created" });
  // Truthful status wording — a pending key is not an active credential.
  expect(screen.getAllByText(/pending/i).length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole("button", { name: /^Cancel/ }));
  // Confirmation dialog explains the never-active invariant.
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toMatch(/never activated/i);
  await userEvent.click(screen.getByRole("button", { name: "Cancel key" }));
  await waitFor(() =>
    expect(screen.queryByRole("cell", { name: "half-created" })).toBeNull(),
  );
});

test("key-name errors are programmatically associated with the field and refocus it", async () => {
  vi.stubGlobal("fetch", vi.fn(memberRoutes()));
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  await userEvent.click(screen.getByRole("button", { name: "New key" }));
  const input = screen.getByLabelText(
    /Name — where will this key live\?/,
  ) as HTMLInputElement;
  await userEvent.click(screen.getByRole("button", { name: "Create key" }));
  const error = await screen.findByText(
    "Name the machine or job this key is for.",
  );
  // The field itself must expose the error relationship and regain focus.
  expect(error.id).toBeTruthy();
  await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
  expect(input.getAttribute("aria-describedby")).toContain(error.id);
  await waitFor(() => expect(document.activeElement).toBe(input));
  // Editing the name clears the invalid state.
  await userEvent.type(input, "laptop-mbp");
  expect(input.getAttribute("aria-invalid")).toBeNull();
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

test("admins load one paginated aggregate request with owner identity — no N+1 fan-out", async () => {
  const adminUser = {
    ...memberUser,
    id: "u-admin",
    username: "ops-admin",
    role: "admin",
  };
  const requests: string[] = [];
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
      if (input.startsWith("/api/api-keys") && method === "GET") {
        requests.push(input);
        return json(200, {
          api_keys: [
            { ...activeKey, owner_username: "sam-ops" },
            { ...revokedKey, owner_username: "sam-ops" },
          ],
          next_cursor: null,
        });
      }
      throw new Error(`unexpected ${method} ${input}`);
    }),
  );
  renderKeys();
  expect(
    await screen.findByRole("cell", { name: "ingest-pipeline" }),
  ).toBeTruthy();
  expect(screen.getByText("Owner")).toBeTruthy();
  expect(screen.getAllByText("sam-ops").length).toBeGreaterThan(0);
  expect(screen.getByText("Legacy service token")).toBeTruthy();
  expect(screen.getByText(/never shown/i)).toBeTruthy();
  // Exactly one aggregate request; never /api/users plus per-user calls.
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("scope=all");
});

test("the admin aggregate view pages through next cursors server-side", async () => {
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
      if (input.startsWith("/api/api-keys") && method === "GET") {
        const url = new URL(input, "http://localhost");
        if (url.searchParams.get("cursor") === "cursor-2") {
          return json(200, {
            api_keys: [{ ...revokedKey, owner_username: "later-owner" }],
            next_cursor: null,
          });
        }
        return json(200, {
          api_keys: [{ ...activeKey, owner_username: "sam-ops" }],
          next_cursor: "cursor-2",
        });
      }
      throw new Error(`unexpected ${method} ${input}`);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  const next = screen.getByRole("button", { name: /next/ });
  await userEvent.click(next);
  expect(await screen.findByRole("cell", { name: "old-desktop" })).toBeTruthy();
  expect(screen.getByText("later-owner")).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "ingest-pipeline" })).toBeNull();
  // And back.
  await userEvent.click(screen.getByRole("button", { name: /prev/ }));
  expect(
    await screen.findByRole("cell", { name: "ingest-pipeline" }),
  ).toBeTruthy();
});

test("admin aggregate search is sent to the server debounced, not filtered per page", async () => {
  const adminUser = {
    ...memberUser,
    id: "u-admin",
    username: "ops-admin",
    role: "admin",
  };
  const requests: string[] = [];
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
      if (input.startsWith("/api/api-keys") && method === "GET") {
        requests.push(input);
        const url = new URL(input, "http://localhost");
        if (url.searchParams.get("q") === "buried") {
          // The match lives beyond the loaded page; only the server can
          // find it.
          return json(200, {
            api_keys: [
              {
                ...activeKey,
                id: "k-buried",
                name: "buried-page2-key",
                owner_username: "far-owner",
              },
            ],
            next_cursor: null,
          });
        }
        return json(200, {
          api_keys: [{ ...activeKey, owner_username: "sam-ops" }],
          next_cursor: "cursor-2",
        });
      }
      throw new Error(`unexpected ${method} ${input}`);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });

  await userEvent.type(screen.getByLabelText(/search/i), "buried");
  expect(
    await screen.findByRole("cell", { name: "buried-page2-key" }),
  ).toBeTruthy();
  expect(screen.getByText("far-owner")).toBeTruthy();
  // Debounce: one initial request plus one search request — never one per
  // keystroke.
  expect(requests).toHaveLength(2);
  const searchUrl = new URL(requests[1]!, "http://localhost");
  expect(searchUrl.searchParams.get("q")).toBe("buried");
  expect(searchUrl.searchParams.get("scope")).toBe("all");
});

test("a stale slow search response never overwrites the newest query", async () => {
  const adminUser = {
    ...memberUser,
    id: "u-admin",
    username: "ops-admin",
    role: "admin",
  };
  let releaseStale!: () => void;
  const stale = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
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
      if (input.startsWith("/api/api-keys") && method === "GET") {
        const url = new URL(input, "http://localhost");
        const q = url.searchParams.get("q");
        if (q === "alpha") {
          await stale;
          return json(200, {
            api_keys: [
              { ...activeKey, id: "k-stale", name: "stale-alpha-key" },
            ].map((key) => ({ ...key, owner_username: "sam-ops" })),
            next_cursor: null,
          });
        }
        if (q === "alpha-two") {
          return json(200, {
            api_keys: [{ ...activeKey, id: "k-new", name: "newest-key" }].map(
              (key) => ({ ...key, owner_username: "sam-ops" }),
            ),
            next_cursor: null,
          });
        }
        return json(200, {
          api_keys: [{ ...activeKey, owner_username: "sam-ops" }],
          next_cursor: null,
        });
      }
      throw new Error(`unexpected ${method} ${input}`);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });

  const input = screen.getByLabelText(/search/i);
  await userEvent.type(input, "alpha");
  // Wait until the slow "alpha" request is in flight, then supersede it.
  await waitFor(() =>
    expect(
      (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
        (call) => String(call[0]).includes("q=alpha"),
      ),
    ).toBe(true),
  );
  await userEvent.type(input, "-two");
  expect(await screen.findByRole("cell", { name: "newest-key" })).toBeTruthy();
  releaseStale();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("cell", { name: "stale-alpha-key" })).toBeNull();
  expect(screen.getByRole("cell", { name: "newest-key" })).toBeTruthy();
});

test("member search filters the complete list client-side without false empties", async () => {
  vi.stubGlobal("fetch", vi.fn(memberRoutes()));
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  await userEvent.type(screen.getByLabelText(/search/i), "old-desk");
  expect(await screen.findByRole("cell", { name: "old-desktop" })).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "ingest-pipeline" })).toBeNull();
  // The member list is complete (unpaginated), so this empty claim is
  // truthful.
  await userEvent.clear(screen.getByLabelText(/search/i));
  await userEvent.type(screen.getByLabelText(/search/i), "no-such-key");
  expect(
    await screen.findByText("no keys match the current filters"),
  ).toBeTruthy();
});

test("admin scope initializes from and writes to the URL, sanitized", async () => {
  window.history.replaceState(null, "", "/keys?scope=mine");
  const adminUser = {
    ...memberUser,
    id: "u-admin",
    username: "ops-admin",
    role: "admin",
  };
  const requests: string[] = [];
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
      if (input.startsWith("/api/api-keys") && method === "GET") {
        requests.push(input);
        const url = new URL(input, "http://localhost");
        if (url.searchParams.get("scope") === "all") {
          return json(200, {
            api_keys: [{ ...activeKey, owner_username: "sam-ops" }],
            next_cursor: null,
          });
        }
        return json(200, { api_keys: [activeKey] });
      }
      throw new Error(`unexpected ${method} ${input}`);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  // Restored Mine scope: the personal endpoint, not the aggregate.
  expect(
    screen.getByRole("button", { name: "Mine" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(requests[0]).not.toContain("scope=all");
  // Switching back to All users drops the param (default) and refetches.
  await userEvent.click(screen.getByRole("button", { name: "All users" }));
  await waitFor(() =>
    expect(window.location.search).not.toContain("scope=mine"),
  );
  await waitFor(() =>
    expect(requests.some((url) => url.includes("scope=all"))).toBe(true),
  );
});

test("a selected key restores its confirm dialog from the URL; stale ids degrade", async () => {
  window.history.replaceState(null, "", "/keys?sel=k1");
  vi.stubGlobal("fetch", vi.fn(memberRoutes()));
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  // The revoke confirmation for the selected key reopens after reauth.
  expect(
    await screen.findByRole("dialog", { name: "Revoke ingest-pipeline?" }),
  ).toBeTruthy();
  // Closing it clears the selection from the URL.
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(window.location.search).not.toContain("sel="));

  // A stale id degrades silently: no dialog, param dropped.
  cleanup();
  window.history.replaceState(null, "", "/keys?sel=no-such-key");
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(window.location.search).not.toContain("sel="));
});

test("an interrupted show-once pending flow restores a truthful reconcile dialog", async () => {
  window.history.replaceState(null, "", "/keys?pend=k-pend");
  const pendingKey = {
    id: "k-pend",
    user_id: "u-member",
    name: "half-created",
    prefix: "fsk_pend0000",
    last_four: "p1p1",
    created_at: "2026-07-31T12:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    status: "pending",
    pending_expires_at: "2026-07-31T12:10:00.000Z",
  };
  const activations: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (input === "/api/api-keys" && method === "GET") {
        return json(200, { api_keys: [activeKey, pendingKey] });
      }
      if (input === "/api/api-keys/k-pend/activate" && method === "POST") {
        activations.push(input);
        return json(200, { api_key: { id: "k-pend", status: "active" } });
      }
      return memberRoutes()(input, init);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "half-created" });
  const dialog = await screen.findByRole("dialog", {
    name: /Pending key half-created/,
  });
  // Truthful: the secret is NOT recoverable; cancel and activate offered.
  expect(dialog.textContent).toMatch(/cannot be shown again/i);
  expect(screen.getByRole("button", { name: "Cancel key" })).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: /Activate — I stored it/ }),
  );
  await waitFor(() => expect(activations).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(window.location.search).not.toContain("pend="));

  // A stale pending id degrades silently.
  cleanup();
  window.history.replaceState(null, "", "/keys?pend=gone-key");
  vi.stubGlobal("fetch", vi.fn(memberRoutes()));
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(window.location.search).not.toContain("pend="));
});

test("the show-once flow persists only the safe pending id — never the secret", async () => {
  let failActivation = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && input === "/api/api-keys") {
        return json(201, {
          api_key: {
            id: "k-safe",
            name: "laptop-mbp",
            secret: "fsk_TESTSECRET-not-a-real-key",
            status: "pending",
            pending_expires_at: "2026-07-31T12:10:00.000Z",
            created: true,
          },
        });
      }
      if (method === "POST" && input === "/api/api-keys/k-safe/activate") {
        if (failActivation) throw new TypeError("connection lost");
        return json(200, { api_key: { id: "k-safe", status: "active" } });
      }
      return memberRoutes()(input, init);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  await userEvent.click(screen.getByRole("button", { name: "New key" }));
  await userEvent.type(
    screen.getByLabelText(/Name — where will this key live\?/),
    "laptop-mbp",
  );
  await userEvent.click(screen.getByRole("button", { name: "Create key" }));
  await screen.findByText("fsk_TESTSECRET-not-a-real-key");
  await screen.findByText(/NOT active/i);
  // While the show-once dialog is open pre-activation, the URL carries
  // only the opaque key id — never secret material.
  await waitFor(() => expect(window.location.search).toContain("pend=k-safe"));
  expect(window.location.search).not.toContain("fsk_");
  expect(window.location.search).not.toContain("TESTSECRET");
  // Once activation completes, the pending marker is gone.
  failActivation = false;
  await userEvent.click(
    screen.getByRole("button", { name: /retry activation/i }),
  );
  await screen.findByText(/key active/i);
  await waitFor(() => expect(window.location.search).not.toContain("pend="));
});

test("aggregate search, cursor, and history initialize from and write to the URL", async () => {
  window.history.replaceState(null, "", "/keys?q=pipe&cursor=kc2&prev=~");
  const adminUser = {
    ...memberUser,
    id: "u-admin",
    username: "ops-admin",
    role: "admin",
  };
  const requests: string[] = [];
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
      if (input.startsWith("/api/api-keys") && method === "GET") {
        requests.push(input);
        const url = new URL(input, "http://localhost");
        if (url.searchParams.get("cursor") === "kc2") {
          return json(200, {
            api_keys: [
              {
                ...activeKey,
                id: "k-deep",
                name: "deep-pipe-key",
                owner_username: "far-owner",
              },
            ],
            next_cursor: null,
          });
        }
        return json(200, {
          api_keys: [{ ...activeKey, owner_username: "sam-ops" }],
          next_cursor: "kc2",
        });
      }
      throw new Error(`unexpected ${method} ${input}`);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "deep-pipe-key" });
  const first = new URL(requests[0]!, "http://localhost");
  expect(first.searchParams.get("q")).toBe("pipe");
  expect(first.searchParams.get("cursor")).toBe("kc2");
  expect((screen.getByLabelText(/search/i) as HTMLInputElement).value).toBe(
    "pipe",
  );
  // Backward navigation survives restoration.
  const prev = screen.getByRole("button", { name: /prev/ });
  expect((prev as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(prev);
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  await waitFor(() => expect(window.location.search).not.toContain("cursor="));
  window.history.replaceState(null, "", "/keys");
});

test("an invalid restored key cursor degrades to the first page without loops", async () => {
  window.history.replaceState(null, "", "/keys?cursor=stale");
  const adminUser = {
    ...memberUser,
    id: "u-admin",
    username: "ops-admin",
    role: "admin",
  };
  const requests: string[] = [];
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
      if (input.startsWith("/api/api-keys") && method === "GET") {
        requests.push(input);
        const url = new URL(input, "http://localhost");
        if (url.searchParams.get("cursor")) {
          return json(400, {
            error: { code: "invalid_cursor", message: "Cursor is invalid" },
          });
        }
        return json(200, {
          api_keys: [{ ...activeKey, owner_username: "sam-ops" }],
          next_cursor: null,
        });
      }
      throw new Error(`unexpected ${method} ${input}`);
    }),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  expect(requests.length).toBe(2);
  expect(window.location.search).not.toContain("cursor=");
  window.history.replaceState(null, "", "/keys");
});

test("members see no owner column and no legacy token section", async () => {
  vi.stubGlobal("fetch", vi.fn(memberRoutes()));
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  expect(screen.queryByText("Owner")).toBeNull();
  expect(screen.queryByText("Legacy service token")).toBeNull();
});

test("a busy revoke dialog cannot be dismissed while the DELETE is in flight", async () => {
  let releaseDelete!: (value: Response) => void;
  const pendingDelete = new Promise<Response>((resolve) => {
    releaseDelete = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(memberRoutes({ del: () => pendingDelete as unknown as Response })),
  );
  renderKeys();
  await screen.findByRole("cell", { name: "ingest-pipeline" });
  await userEvent.click(screen.getByRole("button", { name: /^Revoke/ }));
  await userEvent.click(screen.getByRole("button", { name: "Revoke key" }));

  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: /revoke/i })).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  releaseDelete(new Response(null, { status: 204 }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
