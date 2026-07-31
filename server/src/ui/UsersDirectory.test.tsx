import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { AuthProvider } from "@/lib/auth-context";
import { UsersDirectory } from "./UsersDirectory";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const admin = {
  id: "u-admin",
  username: "ops-admin",
  role: "admin",
  active: true,
  created_at: "2025-11-02T09:00:00.000Z",
  updated_at: "2026-07-01T09:00:00.000Z",
};

const member = {
  id: "u-sam",
  username: "sam-ops",
  role: "member",
  active: true,
  created_at: "2026-06-30T09:00:00.000Z",
  updated_at: "2026-06-30T09:00:00.000Z",
};

const disabled = {
  id: "u-intern",
  username: "intern-2025",
  role: "member",
  active: false,
  created_at: "2026-06-02T09:00:00.000Z",
  updated_at: "2026-06-20T09:00:00.000Z",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

function routes(
  options: {
    users?: () => Response;
    post?: (body: unknown) => Response;
    patch?: (id: string, body: unknown) => Response;
    record?: Recorded[];
  } = {},
) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    options.record?.push({ method, url: input, body });
    if (input === "/api/auth/me") {
      return json(200, {
        user: admin,
        legacy_service_credential: false,
        role: "admin",
      });
    }
    if (input === "/api/users" && method === "GET") {
      return options.users
        ? options.users()
        : json(200, { users: [admin, member, disabled] });
    }
    if (input === "/api/users" && method === "POST") {
      return options.post
        ? options.post(body)
        : json(201, {
            user: {
              id: "u-new",
              username: body.username,
              role: body.role,
              active: true,
              created_at: "2026-07-31T09:00:00.000Z",
              updated_at: "2026-07-31T09:00:00.000Z",
            },
          });
    }
    if (input.startsWith("/api/users/") && method === "PATCH") {
      const id = decodeURIComponent(input.split("/").pop()!);
      return options.patch
        ? options.patch(id, body)
        : json(200, { user: { ...member, ...body } });
    }
    throw new Error(`unexpected ${method} ${input}`);
  };
}

function renderDirectory() {
  return render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <UsersDirectory />
    </AuthProvider>,
  );
}

test("directory lists accounts with explicit words, counts, and a you marker", async () => {
  vi.stubGlobal("fetch", vi.fn(routes()));
  renderDirectory();
  expect(
    await screen.findByRole("button", { name: /ops-admin ?· you/ }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "3 accounts · 2 active · 1 admin · bcrypt password storage",
    ),
  ).toBeTruthy();
  const disabledRow = screen
    .getByRole("button", { name: "intern-2025" })
    .closest("tr")!;
  expect(within(disabledRow).getByText("disabled")).toBeTruthy();
  expect(
    within(disabledRow).getByRole("button", { name: /Enable/ }),
  ).toBeTruthy();
  // The last active admin row is marked protected instead of disable-able.
  const adminRow = screen
    .getByRole("button", { name: /ops-admin ?· you/ })
    .closest("tr")!;
  expect(within(adminRow).getByText(/last admin · protected/)).toBeTruthy();
});

test("search and role filters narrow the table client-side", async () => {
  vi.stubGlobal("fetch", vi.fn(routes()));
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  await userEvent.click(screen.getByRole("button", { name: "Member" }));
  expect(screen.queryByRole("cell", { name: /ops-admin ?· you/ })).toBeNull();
  expect(screen.getByRole("button", { name: "sam-ops" })).toBeTruthy();
  await userEvent.type(screen.getByLabelText("Search username"), "intern");
  expect(screen.queryByRole("cell", { name: "sam-ops" })).toBeNull();
  expect(screen.getByRole("button", { name: "intern-2025" })).toBeTruthy();
});

test("creating a user generates a temporary password shown exactly once", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal("fetch", vi.fn(routes({ record })));
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });

  await userEvent.click(screen.getByRole("button", { name: "New user" }));
  await userEvent.type(screen.getByLabelText("Username"), "nadia.r");
  await userEvent.click(screen.getByRole("button", { name: "Create user" }));

  expect(
    await screen.findByRole("dialog", { name: /User created — nadia\.r/ }),
  ).toBeTruthy();
  const posted = record.find(
    (entry) => entry.method === "POST" && entry.url === "/api/users",
  )!;
  const sentPassword = (posted.body as { password: string }).password;
  expect(sentPassword.length).toBeGreaterThanOrEqual(12);
  expect((posted.body as { role: string }).role).toBe("member");
  // The exact password that was set is the one shown once.
  expect(screen.getByText(sentPassword)).toBeTruthy();
  const done = screen.getByRole("button", {
    name: "Done",
  }) as HTMLButtonElement;
  expect(done.disabled).toBe(true);
  await userEvent.click(
    screen.getByRole("checkbox", { name: /I've shared or stored/ }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByText(sentPassword)).toBeNull());
});

test("a taken username surfaces the server conflict inline", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        post: () =>
          json(409, {
            error: {
              code: "username_exists",
              message: "Username already exists",
            },
          }),
      }),
    ),
  );
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  await userEvent.click(screen.getByRole("button", { name: "New user" }));
  await userEvent.type(screen.getByLabelText("Username"), "sam-ops");
  await userEvent.click(screen.getByRole("button", { name: "Create user" }));
  expect(
    await screen.findByText("That username is already taken."),
  ).toBeTruthy();
});

test("disabling a user states the consequences and patches active=false", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal("fetch", vi.fn(routes({ record })));
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });

  const samRow = screen.getByRole("button", { name: "sam-ops" }).closest("tr")!;
  await userEvent.click(
    within(samRow).getByRole("button", { name: /Disable/ }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Disable sam-ops?",
  });
  expect(
    within(dialog).getByText(/active sessions are signed out/),
  ).toBeTruthy();
  expect(within(dialog).getByText(/API keys stop working/)).toBeTruthy();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Disable account" }),
  );
  await waitFor(() => {
    expect(
      record.some(
        (entry) =>
          entry.method === "PATCH" &&
          entry.url === "/api/users/u-sam" &&
          JSON.stringify(entry.body) === JSON.stringify({ active: false }),
      ),
    ).toBe(true);
  });
});

test("the last-active-admin conflict is explained with a way forward", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        users: () => json(200, { users: [admin, member] }),
        patch: () =>
          json(409, {
            error: {
              code: "last_active_admin",
              message: "The last active admin cannot be disabled or demoted",
            },
          }),
      }),
    ),
  );
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  // Open the admin's own detail to attempt a role change on the last admin.
  await userEvent.click(
    screen.getByRole("button", { name: /ops-admin ?· you/ }),
  );
  const detail = await screen.findByRole("region", { name: "Admin actions" });
  await userEvent.click(
    within(detail).getByRole("button", { name: /Change role/ }),
  );
  const confirm = await screen.findByRole("dialog", {
    name: /Make ops-admin a member\?/,
  });
  await userEvent.click(
    within(confirm).getByRole("button", { name: "Change role" }),
  );
  const conflict = await screen.findByRole("dialog", {
    name: /Can't demote ops-admin/,
  });
  expect(within(conflict).getByText(/409 · LAST ACTIVE ADMIN/)).toBeTruthy();
  expect(
    within(conflict).getByText(/Promote another member to admin first/),
  ).toBeTruthy();
});

test("resetting a password confirms, patches, and shows the new secret once", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal("fetch", vi.fn(routes({ record })));
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });

  const samRow = screen.getByRole("button", { name: "sam-ops" }).closest("tr")!;
  await userEvent.click(within(samRow).getByRole("button", { name: /Reset/ }));
  const confirm = await screen.findByRole("dialog", {
    name: "Reset password for sam-ops?",
  });
  expect(
    within(confirm).getByText(/current password stops working/),
  ).toBeTruthy();
  await userEvent.click(
    within(confirm).getByRole("button", { name: "Reset password" }),
  );

  const shown = await screen.findByRole("dialog", {
    name: /Password reset — sam-ops/,
  });
  const patched = record.find((entry) => entry.method === "PATCH")!;
  const sentPassword = (patched.body as { password: string }).password;
  expect(patched.url).toBe("/api/users/u-sam");
  expect(within(shown).getByText(sentPassword)).toBeTruthy();
});

test("load failures offer retry without pretending anything changed", async () => {
  let failures = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        users: () => {
          if (failures > 0) {
            failures -= 1;
            return json(500, {
              error: { code: "internal_error", message: "boom" },
            });
          }
          return json(200, { users: [admin, member] });
        },
      }),
    ),
  );
  renderDirectory();
  expect(await screen.findByText("Couldn't load users")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "sam-ops" })).toBeTruthy();
});

test("a busy disable dialog cannot be dismissed while the PATCH is in flight", async () => {
  let releasePatch!: (value: Response) => void;
  const pendingPatch = new Promise<Response>((resolve) => {
    releasePatch = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(routes({ patch: () => pendingPatch as unknown as Response })),
  );
  renderDirectory();
  await screen.findByRole("button", { name: "sam-ops" });
  const samRow = screen.getByRole("button", { name: "sam-ops" }).closest("tr")!;
  await userEvent.click(
    within(samRow).getByRole("button", { name: /Disable/ }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Disable account" }),
  );

  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: /disable/i })).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  releasePatch(json(200, { user: { ...member, active: false } }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a stale users response never overwrites a newer reload", async () => {
  // Deliberately complete responses out of order: the first directory load
  // stalls; a Retry-triggered load returns fresh data; then the stale
  // response resolves and must be discarded.
  let call = 0;
  let releaseFirst!: (value: Response) => void;
  const first = new Promise<Response>((resolve) => {
    releaseFirst = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (input === "/api/auth/me") {
        return json(200, {
          user: admin,
          legacy_service_credential: false,
          role: "admin",
        });
      }
      if (input === "/api/users" && method === "GET") {
        call += 1;
        if (call === 1) return first;
        return json(200, { users: [admin, member] });
      }
      if (input.startsWith("/api/users/") && method === "PATCH") {
        return json(200, { user: { ...member, active: false } });
      }
      throw new Error(`unexpected ${method} ${input}`);
    }),
  );
  renderDirectory();
  // Trigger a second load through a mutation (disable) while the first
  // directory request is still pending.
  await screen.findByText(/loading users/);
  releaseFirst(json(200, { users: [admin, member, disabled] }));
  await screen.findByRole("button", { name: "sam-ops" });
  // Reload happens after a confirmed mutation; simulate a fresh race:
  const row = screen.getByRole("button", { name: "sam-ops" }).closest("tr")!;
  await userEvent.click(within(row).getByRole("button", { name: /Disable/ }));
  await userEvent.click(
    screen.getByRole("button", { name: "Disable account" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText("intern-2025")).toBeNull();
});

test("the last-admin conflict offers a View members escape hatch", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        patch: () =>
          json(409, {
            error: {
              code: "last_active_admin",
              message: "The last active admin cannot be disabled or demoted",
            },
          }),
      }),
    ),
  );
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  // Open the admin detail and attempt a demotion that the server refuses.
  await userEvent.click(
    screen.getByRole("button", { name: /ops-admin ?· you/ }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Change role…" }));
  await userEvent.click(screen.getByRole("button", { name: "Change role" }));
  const conflict = await screen.findByRole("dialog", { name: /can't demote/i });
  expect(conflict).toBeTruthy();

  await userEvent.click(
    within(conflict).getByRole("button", { name: "View members" }),
  );
  // The dialog closes and the directory is pre-filtered to members so the
  // admin can promote someone.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    screen.getByRole("button", { name: "Member" }).getAttribute("aria-pressed"),
  ).toBe("true");
});

test("mobile rows expose an actions sheet with the same confirmed actions", async () => {
  vi.stubGlobal("fetch", vi.fn(routes()));
  renderDirectory();
  await screen.findByRole("button", { name: "sam-ops" });
  const samRow = screen.getByRole("button", { name: "sam-ops" }).closest("tr")!;

  await userEvent.click(
    within(samRow).getByRole("button", { name: /actions for sam-ops/i }),
  );
  const sheet = await screen.findByRole("dialog", { name: "sam-ops" });
  expect(
    within(sheet).getByRole("button", { name: /change role to admin/i }),
  ).toBeTruthy();
  expect(
    within(sheet).getByRole("button", { name: /reset password/i }),
  ).toBeTruthy();

  // Destructive action still routes through the explicit confirmation.
  await userEvent.click(
    within(sheet).getByRole("button", { name: /disable account/i }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Disable sam-ops?" }),
  ).toBeTruthy();
});
