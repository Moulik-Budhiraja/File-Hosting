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
import { FilesBrowser } from "./FilesBrowser";

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

function file(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "aB3dE9k",
    name: "telemetry-batch-0412.parquet",
    size: 640 * 1024 * 1024,
    mime_type: "application/parquet",
    sha256: "ab".repeat(32),
    visibility: "private",
    owner_id: "u-sam",
    tags: ["datasets"],
    preview_url: "http://localhost:3000/aB3dE9k",
    raw_url: "http://localhost:3000/raw/aB3dE9k",
    archive: null,
    created_at: "2026-07-31T07:11:00.000Z",
    updated_at: "2026-07-31T07:11:00.000Z",
    ...overrides,
  };
}

const publicFile = file({
  id: "pUbL1c0",
  name: "onboarding-runbook.md",
  size: 48 * 1024,
  mime_type: "text/markdown",
  visibility: "public",
  owner_id: "u-admin",
});

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
    viewer?: typeof admin;
    files?: (url: URL) => Response;
    record?: Recorded[];
  } = {},
) {
  const viewer = options.viewer ?? admin;
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    options.record?.push({
      method,
      url: input,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    if (input === "/api/auth/me") {
      return json(200, {
        user: viewer,
        legacy_service_credential: false,
        role: viewer.role,
      });
    }
    if (input === "/api/users" && viewer.role === "admin") {
      return json(200, { users: [admin, member] });
    }
    if (input.startsWith("/api/files?") || input === "/api/files") {
      if (method === "GET") {
        const url = new URL(input, "http://localhost");
        return options.files
          ? options.files(url)
          : json(200, { items: [file(), publicFile], next_cursor: null });
      }
      if (method === "POST") {
        return json(201, file({ id: "n3wF1le", name: "upload.bin" }));
      }
    }
    if (input.startsWith("/api/files/") && method === "PATCH") {
      return json(200, file({ visibility: "protected" }));
    }
    if (input.startsWith("/api/files/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${input}`);
  };
}

function renderFiles() {
  return render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <FilesBrowser />
    </AuthProvider>,
  );
}

test("lists files with visibility words and resolved owners for admins", async () => {
  vi.stubGlobal("fetch", vi.fn(routes()));
  renderFiles();
  expect(
    await screen.findByRole("button", {
      name: /telemetry-batch-0412\.parquet/,
    }),
  ).toBeTruthy();
  const row = screen
    .getByRole("button", { name: /telemetry-batch-0412\.parquet/ })
    .closest("tr")!;
  expect(within(row).getByText("private")).toBeTruthy();
  expect(within(row).getByText("sam-ops")).toBeTruthy();
  expect(within(row).getByText("640 MB")).toBeTruthy();
});

test("visibility filter refetches with the visibility parameter", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal("fetch", vi.fn(routes({ record })));
  renderFiles();
  await screen.findByRole("button", { name: /telemetry-batch-0412\.parquet/ });
  await userEvent.click(screen.getByRole("button", { name: "Private" }));
  await waitFor(() => {
    expect(
      record.some(
        (entry) =>
          entry.method === "GET" &&
          entry.url.startsWith("/api/files?") &&
          entry.url.includes("visibility=private"),
      ),
    ).toBe(true);
  });
});

test("upload posts the file with the chosen visibility explained in plain language", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal("fetch", vi.fn(routes({ record })));
  renderFiles();
  await screen.findByRole("button", { name: /telemetry-batch-0412\.parquet/ });

  await userEvent.click(screen.getByRole("button", { name: "Upload" }));
  const dialog = await screen.findByRole("dialog", { name: "Upload file" });
  const input = within(dialog).getByLabelText("File") as HTMLInputElement;
  await userEvent.upload(
    input,
    new File(["synthetic-bytes"], "upload.bin", {
      type: "application/octet-stream",
    }),
  );
  expect(
    within(dialog).getByText(
      "Only you and admins. Everyone else gets the same 404 as a missing file.",
    ),
  ).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("radio", { name: /private/ }));
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Upload file" }),
  );
  await waitFor(() => {
    const posted = record.find((entry) => entry.method === "POST");
    expect(posted).toBeTruthy();
    expect(posted!.url).toContain("name=upload.bin");
    expect(posted!.url).toContain("visibility=private");
  });
});

test("the inspector shows the access record and saves visibility changes", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal("fetch", vi.fn(routes({ record })));
  renderFiles();
  await userEvent.click(
    await screen.findByRole("button", {
      name: /telemetry-batch-0412\.parquet/,
    }),
  );
  const inspector = await screen.findByRole("region", {
    name: /object record · access/i,
  });
  expect(within(inspector).getByText("sam-ops")).toBeTruthy();
  expect(within(inspector).getAllByText("private").length).toBeGreaterThan(0);

  await userEvent.click(
    within(inspector).getByRole("button", { name: /Change…/ }),
  );
  const editor = await screen.findByRole("dialog", {
    name: /Who can open this file\?/,
  });
  await userEvent.click(
    within(editor).getByRole("radio", { name: /protected/ }),
  );
  await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    const patched = record.find((entry) => entry.method === "PATCH");
    expect(patched).toBeTruthy();
    expect(patched!.url).toBe("/api/files/aB3dE9k");
    expect(patched!.body).toEqual({ visibility: "protected" });
  });
});

test("members cannot change or delete files they do not own", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        viewer: member,
        files: () =>
          json(200, { items: [publicFile, file()], next_cursor: null }),
      }),
    ),
  );
  renderFiles();
  // Someone else's public file: inspect but no manage controls.
  await userEvent.click(
    await screen.findByRole("button", { name: /onboarding-runbook\.md/ }),
  );
  const inspector = await screen.findByRole("region", {
    name: /object record · access/i,
  });
  expect(
    within(inspector).queryByRole("button", { name: /Change…/ }),
  ).toBeNull();
  expect(
    within(inspector).queryByRole("button", { name: /Delete/ }),
  ).toBeNull();
  expect(
    within(inspector).getByText(/managed by its owner and admins/i),
  ).toBeTruthy();
});

test("deleting a managed file requires confirmation and reports the result", async () => {
  const record: Recorded[] = [];
  vi.stubGlobal("fetch", vi.fn(routes({ record })));
  renderFiles();
  await userEvent.click(
    await screen.findByRole("button", {
      name: /telemetry-batch-0412\.parquet/,
    }),
  );
  const inspector = await screen.findByRole("region", {
    name: /object record · access/i,
  });
  await userEvent.click(
    within(inspector).getByRole("button", { name: /Delete…/ }),
  );
  const confirm = await screen.findByRole("dialog", {
    name: /Delete telemetry-batch-0412\.parquet\?/,
  });
  expect(record.filter((entry) => entry.method === "DELETE")).toHaveLength(0);
  await userEvent.click(
    within(confirm).getByRole("button", { name: "Delete file" }),
  );
  await waitFor(() => {
    expect(
      record.some(
        (entry) =>
          entry.method === "DELETE" && entry.url === "/api/files/aB3dE9k",
      ),
    ).toBe(true);
  });
});

test("load failures state the failing call and offer retry", async () => {
  let failures = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      routes({
        files: () => {
          if (failures > 0) {
            failures -= 1;
            return json(500, {
              error: { code: "internal_error", message: "boom" },
            });
          }
          return json(200, { items: [publicFile], next_cursor: null });
        },
      }),
    ),
  );
  renderFiles();
  expect(await screen.findByText("Couldn't load files")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", { name: /onboarding-runbook\.md/ }),
  ).toBeTruthy();
});
