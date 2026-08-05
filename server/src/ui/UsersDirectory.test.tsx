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
import { formatMobileLastActive, UsersDirectory } from "./UsersDirectory";

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
  files_count: 38,
  api_keys_count: 2,
  sessions_count: 1,
  last_active_at: "2026-07-31T17:44:00.000Z",
};

const member = {
  id: "u-sam",
  username: "sam-ops",
  role: "member",
  active: true,
  created_at: "2026-06-30T09:00:00.000Z",
  updated_at: "2026-06-30T09:00:00.000Z",
  files_count: 14,
  api_keys_count: 1,
  sessions_count: 1,
  last_active_at: "2026-07-31T17:12:00.000Z",
};

const disabled = {
  id: "u-intern",
  username: "intern-2025",
  role: "member",
  active: false,
  created_at: "2026-06-02T09:00:00.000Z",
  updated_at: "2026-06-20T09:00:00.000Z",
  files_count: 0,
  api_keys_count: 0,
  sessions_count: 0,
  last_active_at: null,
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
  expect(screen.getByText("3 accounts · 2 active · 1 admin")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Files" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Keys" })).toBeTruthy();
  expect(
    screen.getByRole("columnheader", { name: "Last active" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("columnheader", { name: "Created" })
      .classList.contains("col-desktop"),
  ).toBe(true);
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
  expect(within(adminRow).getByText("protected")).toBeTruthy();
});

test("desktop detail protects the last admin while keeping role change available", async () => {
  vi.stubGlobal("fetch", vi.fn(routes()));
  renderDirectory();
  await userEvent.click(
    await screen.findByRole("button", { name: /ops-admin ?· you/ }),
  );

  const actions = await screen.findByRole("region", { name: "Admin actions" });
  expect(
    within(actions).getByText("last admin · protected — cannot disable"),
  ).toBeTruthy();
  expect(
    within(actions).queryByRole("button", { name: /Disable account/ }),
  ).toBeNull();
  expect(
    within(actions).getByRole("button", { name: "Change role…" }),
  ).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "sam-ops" }));
  const memberActions = screen.getByRole("region", { name: "Admin actions" });
  expect(
    within(memberActions).getByRole("button", { name: "Disable account…" }),
  ).toBeTruthy();
});

test("loading and error states never fabricate account statistics", async () => {
  let releaseUsers!: (response: Response) => void;
  const pendingUsers = new Promise<Response>((resolve) => {
    releaseUsers = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(routes({ users: () => pendingUsers as unknown as Response })),
  );
  renderDirectory();

  expect(await screen.findByText("Loading…")).toBeTruthy();
  expect(screen.queryByText(/accounts ·/i)).toBeNull();

  releaseUsers(
    json(500, { error: { code: "internal_error", message: "boom" } }),
  );
  expect(await screen.findByText("Couldn't load users")).toBeTruthy();
  expect(screen.queryByText(/accounts ·/i)).toBeNull();
});

test("the empty directory row spans all eight table columns", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(routes({ users: () => json(200, { users: [] }) })),
  );
  renderDirectory();

  const empty = await screen.findByText("No accounts match.");
  const cell = empty.closest("td");
  expect(cell?.getAttribute("colspan")).toBe("8");
  expect(screen.getAllByRole("columnheader")).toHaveLength(8);
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

test("a request conflict reloads the directory and safely starts a new user attempt", async () => {
  const record: Recorded[] = [];
  let posts = 0;
  let directoryLoads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        record,
        users: () => {
          directoryLoads += 1;
          return json(200, { users: [admin, member, disabled] });
        },
        post: (body) => {
          posts += 1;
          if (posts <= 2) throw new TypeError("network down");
          if (posts === 3) {
            return json(409, {
              error: {
                code: "request_id_conflict",
                message: "request_id is already bound to another user creation",
              },
            });
          }
          return json(201, {
            user: {
              id: "u-new",
              username: (body as { username: string }).username,
              role: "member",
              active: true,
              created_at: "2026-08-04T12:00:00.000Z",
              updated_at: "2026-08-04T12:00:00.000Z",
            },
          });
        },
      }),
    ),
  );
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  await userEvent.click(screen.getByRole("button", { name: "New user" }));
  const input = screen.getByLabelText("Username") as HTMLInputElement;
  await userEvent.type(input, "alice-new");
  await userEvent.click(screen.getByRole("button", { name: "Create user" }));
  await screen.findByText(/may or may not have been created/i);

  await userEvent.click(screen.getByRole("button", { name: "Create user" }));
  const conflict = await screen.findByText(
    "Another user was created. Directory reloaded — start again.",
  );
  expect(conflict.textContent).not.toMatch(/request[_ ]?id|protocol/iu);
  expect(input.getAttribute("aria-describedby")).toContain(conflict.id);
  await waitFor(() => expect(document.activeElement).toBe(input));
  await waitFor(() => expect(directoryLoads).toBe(2));

  await userEvent.type(input, "-2");
  await userEvent.click(screen.getByRole("button", { name: "Create user" }));
  await screen.findByRole("dialog", { name: /User created — alice-new-2/ });
  const sent = record.filter((entry) => entry.method === "POST");
  expect(sent).toHaveLength(4);
  expect((sent[2]!.body as { request_id: string }).request_id).toBe(
    (sent[0]!.body as { request_id: string }).request_id,
  );
  expect((sent[3]!.body as { request_id: string }).request_id).not.toBe(
    (sent[2]!.body as { request_id: string }).request_id,
  );
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

test("username errors are programmatically associated with the field and refocus it", async () => {
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
  const input = screen.getByLabelText("Username") as HTMLInputElement;
  await userEvent.type(input, "sam-ops");
  await userEvent.click(screen.getByRole("button", { name: "Create user" }));
  const error = await screen.findByText("That username is already taken.");
  // Screen readers must find the error from the field itself, and focus
  // must return to the field owning the conflict.
  expect(error.id).toBeTruthy();
  await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
  expect(input.getAttribute("aria-describedby")).toContain(error.id);
  await waitFor(() => expect(document.activeElement).toBe(input));
  // Editing the username clears the invalid state.
  await userEvent.type(input, "-2");
  expect(input.getAttribute("aria-invalid")).toBeNull();
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
    within(dialog).getByText(
      "Sessions and API keys stop immediately. Files stay. Re-enable any time.",
    ),
  ).toBeTruthy();
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
  expect(screen.getByText("Account disabled.")).toBeTruthy();
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
  expect(within(conflict).getByText("409")).toBeTruthy();
  expect(
    within(conflict).getByText("Promote another admin first."),
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
    within(confirm).getByText(
      "Current password and sessions end. New password shown once.",
    ),
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

test("a lost create response reconciles via the request id and shows the retained candidate password", async () => {
  const record: Recorded[] = [];
  let posts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        record,
        post: (body) => {
          posts += 1;
          if (posts === 1) {
            // The request reaches the server (it commits) but the
            // response is lost in transit.
            throw new TypeError("network response lost");
          }
          return json(200, {
            user: {
              id: "u-new",
              username: (body as { username: string }).username,
              role: "member",
              active: true,
              created_at: "2026-07-31T09:00:00.000Z",
              updated_at: "2026-07-31T09:00:00.000Z",
            },
            created: false,
          });
        },
      }),
    ),
  );
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  await userEvent.click(screen.getByRole("button", { name: "New user" }));
  await userEvent.type(screen.getByLabelText("Username"), "nadia.r");
  await userEvent.click(screen.getByRole("button", { name: "Create user" }));

  // The retry reconciled: the show-once dialog appears with the SAME
  // candidate password the client retained.
  expect(
    await screen.findByRole("dialog", { name: /User created — nadia\.r/ }),
  ).toBeTruthy();
  const sent = record.filter(
    (entry) => entry.method === "POST" && entry.url === "/api/users",
  );
  expect(sent.length).toBe(2);
  const first = sent[0]!.body as { request_id: string; password: string };
  const second = sent[1]!.body as { request_id: string; password: string };
  expect(first.request_id).toBeTruthy();
  expect(second.request_id).toBe(first.request_id);
  expect(second.password).toBe(first.password);
  expect(screen.getByText(first.password)).toBeTruthy();
});

test("an unreachable create reports an ambiguous outcome and reuses the request id on manual retry", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        record,
        post: () => {
          throw new TypeError("network down");
        },
      }),
    ),
  );
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  await userEvent.click(screen.getByRole("button", { name: "New user" }));
  await userEvent.type(screen.getByLabelText("Username"), "nadia.r");
  await userEvent.click(screen.getByRole("button", { name: "Create user" }));

  // Truthful ambiguity — never an absolute "nothing was changed" claim.
  expect(
    await screen.findByText(/may or may not have been created/i),
  ).toBeTruthy();
  expect(screen.queryByText(/nothing was changed/i)).toBeNull();

  // A manual retry reuses the same request id and candidate password so
  // reconciliation stays possible.
  await userEvent.click(screen.getByRole("button", { name: "Create user" }));
  await screen.findAllByText(/may or may not have been created/i);
  const sent = record.filter((entry) => entry.method === "POST");
  expect(sent.length).toBe(4);
  const ids = new Set(
    sent.map((entry) => (entry.body as { request_id: string }).request_id),
  );
  const passwords = new Set(
    sent.map((entry) => (entry.body as { password: string }).password),
  );
  expect(ids.size).toBe(1);
  expect(passwords.size).toBe(1);
});

test("a lost reset response reconciles idempotently and shows the original candidate password", async () => {
  const record: Recorded[] = [];
  let patches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        record,
        patch: (id, body) => {
          patches += 1;
          if (patches === 1) throw new TypeError("network response lost");
          // The replay applies nothing and reports so.
          expect((body as { request_id: string }).request_id).toBeTruthy();
          return json(200, {
            user: { ...member, updated_at: "2026-07-31T10:00:00.000Z" },
            password_applied: false,
          });
        },
      }),
    ),
  );
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  const samRow = screen.getByRole("button", { name: "sam-ops" }).closest("tr")!;
  await userEvent.click(within(samRow).getByRole("button", { name: /Reset/ }));
  await userEvent.click(screen.getByRole("button", { name: "Reset password" }));

  const shown = await screen.findByRole("dialog", {
    name: /Password reset — sam-ops/,
  });
  const sent = record.filter((entry) => entry.method === "PATCH");
  expect(sent.length).toBe(2);
  const first = sent[0]!.body as { request_id: string; password: string };
  const second = sent[1]!.body as { request_id: string; password: string };
  expect(second.request_id).toBe(first.request_id);
  expect(second.password).toBe(first.password);
  // The shown one-time credential is the one that actually committed.
  expect(within(shown).getByText(first.password)).toBeTruthy();
});

test("an unreachable reset reports an ambiguous outcome and keeps the retry idempotent", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        record,
        patch: () => {
          throw new TypeError("network down");
        },
      }),
    ),
  );
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  const samRow = screen.getByRole("button", { name: "sam-ops" }).closest("tr")!;
  await userEvent.click(within(samRow).getByRole("button", { name: /Reset/ }));
  await userEvent.click(screen.getByRole("button", { name: "Reset password" }));

  expect(
    await screen.findByText(/password may or may not have changed/i),
  ).toBeTruthy();
  expect(screen.queryByText(/nothing was changed/i)).toBeNull();

  // Retrying from the same dialog reuses the same request id + candidate.
  await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await screen.findAllByText(/password may or may not have changed/i);
  const sent = record.filter((entry) => entry.method === "PATCH");
  expect(sent.length).toBe(4);
  expect(
    new Set(
      sent.map((entry) => (entry.body as { request_id: string }).request_id),
    ).size,
  ).toBe(1);
  expect(
    new Set(sent.map((entry) => (entry.body as { password: string }).password))
      .size,
  ).toBe(1);
});

test("a committed disable whose response is lost reconciles against the authoritative record", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        record,
        // The PATCH commits server-side; only the response is lost.
        patch: () => {
          throw new TypeError("network response lost");
        },
        users: () =>
          json(200, {
            users: [
              admin,
              record.some((entry) => entry.method === "PATCH")
                ? { ...member, active: false }
                : member,
              disabled,
            ],
          }),
      }),
    ),
  );
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  const samRow = screen.getByRole("button", { name: "sam-ops" }).closest("tr")!;
  await userEvent.click(
    within(samRow).getByRole("button", { name: /Disable/ }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Disable account" }),
  );
  // The desired state is present on the server: reconciled success, the
  // dialog closes, and no false "nothing was changed" claim appears.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("Account disabled.")).toBeTruthy();
  expect(screen.queryByText(/nothing was changed/i)).toBeNull();
});

test("an unverifiable status change says the outcome is unknown and offers retry", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        // Pre-commit failure: the PATCH dies and the record still shows
        // the old state.
        patch: () => {
          throw new TypeError("network down");
        },
      }),
    ),
  );
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  const samRow = screen.getByRole("button", { name: "sam-ops" }).closest("tr")!;
  await userEvent.click(
    within(samRow).getByRole("button", { name: /Disable/ }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Disable account" }),
  );

  expect(await screen.findByText(/may or may not have applied/i)).toBeTruthy();
  expect(screen.queryByText(/nothing was changed/i)).toBeNull();
  // The dialog stays open with an enabled retry.
  expect(
    (
      screen.getByRole("button", {
        name: "Disable account",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test("load failures report status and offer retry", async () => {
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
  expect(screen.queryByText(/GET \/api\/users/)).toBeNull();
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
  await screen.findByText("Loading…");
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

test("mobile activity formatting matches approved today, yesterday, and date semantics", () => {
  const now = new Date("2026-08-04T12:00:00");
  expect(formatMobileLastActive("2026-08-04T09:41:00", now)).toBe("09:41");
  expect(formatMobileLastActive("2026-08-03T17:00:00", now)).toBe("yesterday");
  expect(formatMobileLastActive("2026-06-20T17:00:00", now)).toBe("Jun 20");
  expect(formatMobileLastActive(null, now)).toBe("never");
});

test("mobile rows retain last-active and last-admin protection semantics", async () => {
  vi.stubGlobal("fetch", vi.fn(routes()));
  renderDirectory();
  const adminRow = (
    await screen.findByRole("button", { name: /ops-admin ?· you/ })
  ).closest("tr")!;
  expect(adminRow.textContent).toContain("admin · active · last admin ·");
  expect(adminRow.textContent).toContain("protected");
  expect(adminRow.textContent).not.toContain("38 files");
  expect(
    within(adminRow).queryByRole("button", { name: /actions for ops-admin/i }),
  ).toBeNull();

  const memberRow = screen
    .getByRole("button", { name: "sam-ops" })
    .closest("tr")!;
  expect(memberRow.textContent).toContain("member · active ·");
  expect(memberRow.textContent).not.toContain("14 files");
  expect(
    within(memberRow).getByRole("button", { name: /actions for sam-ops/i }),
  ).toBeTruthy();
});

test("new user fails definitively without a browser CSPRNG and never sends a request", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal("crypto", {});
  vi.stubGlobal("fetch", vi.fn(routes({ record })));
  renderDirectory();
  await screen.findByRole("button", { name: /ops-admin ?· you/ });
  await userEvent.click(screen.getByRole("button", { name: "New user" }));
  await userEvent.type(screen.getByLabelText("Username"), "no-csprng-user");
  await userEvent.click(screen.getByRole("button", { name: "Create user" }));

  expect(
    await screen.findByText(
      "Secure request IDs are unavailable. Use HTTPS or a supported browser.",
    ),
  ).toBeTruthy();
  expect(record.filter((entry) => entry.method === "POST")).toHaveLength(0);
  expect(
    (screen.getByRole("button", { name: "Create user" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(screen.queryByText(/may or may not/i)).toBeNull();
});

test("password reset fails definitively without a browser CSPRNG and stays retryable", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal("crypto", {});
  vi.stubGlobal("fetch", vi.fn(routes({ record })));
  renderDirectory();
  await screen.findByRole("button", { name: "sam-ops" });
  const row = screen.getByRole("button", { name: "sam-ops" }).closest("tr")!;
  await userEvent.click(within(row).getByRole("button", { name: /Reset/ }));
  await userEvent.click(screen.getByRole("button", { name: "Reset password" }));

  expect(
    await screen.findByText(
      "Secure request IDs are unavailable. Use HTTPS or a supported browser.",
    ),
  ).toBeTruthy();
  expect(record.filter((entry) => entry.method === "PATCH")).toHaveLength(0);
  expect(
    (
      screen.getByRole("button", {
        name: "Reset password",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(screen.queryByText(/may or may not/i)).toBeNull();
});
