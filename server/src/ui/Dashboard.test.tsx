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
import { LiveOperations, SystemStatus } from "./Dashboard";

const admin = {
  id: "u-admin",
  username: "ops-admin",
  role: "admin",
  active: true,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

const system = {
  version: "1.8.2",
  node: "v22.18.0",
  uptime_seconds: 98640,
  storage: {
    free_bytes: 87.4 * 1024 ** 3,
    object_bytes: 412.6 * 1024 ** 3,
    object_count: 18204,
    public_count: 6210,
    protected_count: 72,
    private_count: 11922,
    temp_part_count: 0,
  },
  database: { db_bytes: 156.2 * 1024 ** 2 },
  transfers: [
    {
      direction: "upload",
      name: "backups/cluster-2026-07-31.tar.zst",
      bytes: 1.24 * 1024 ** 3,
      total_bytes: 1.81 * 1024 ** 3,
      started_at: "2026-07-31T09:40:00.000Z",
    },
  ],
  config: {
    max_upload_bytes: 2 * 1024 ** 3,
    min_free_bytes: 64 * 1024 ** 3,
    public_url: "https://files.example.test",
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderDashboard(
  child: React.ReactNode,
  systemResponse: unknown = system,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/auth/me") {
        return json({
          user: admin,
          role: "admin",
          legacy_service_credential: false,
        });
      }
      if (input === "/api/system") {
        if (systemResponse === null) throw new TypeError("offline");
        return json(systemResponse);
      }
      if (input.startsWith("/api/files?")) {
        return json({
          items: [
            {
              id: "recent01",
              name: "media/keynote-2026-recording.mp4",
              size: 902 * 1024 ** 2,
              mime_type: "video/mp4",
              sha256: "ab".repeat(32),
              visibility: "public",
              owner_id: "u-admin",
              tags: [],
              preview_url: "/recent01",
              raw_url: "/raw/recent01",
              archive: null,
              created_at: "2026-07-31T09:38:51.000Z",
              updated_at: "2026-07-31T09:38:51.000Z",
            },
          ],
          next_cursor: null,
        });
      }
      throw new Error(`unexpected ${input}`);
    }),
  );
  return render(
    <AuthProvider onUnauthenticated={vi.fn()}>{child}</AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("live operations renders real capacity, transfers, warnings, and recent files", async () => {
  renderDashboard(<LiveOperations />);
  expect(await screen.findByText("412.6 GB")).toBeTruthy();
  expect(screen.getByText("87.4 GB")).toBeTruthy();
  expect(screen.getByText("18,204")).toBeTruthy();
  const transfers = screen.getByRole("region", { name: "Active transfers" });
  expect(within(transfers).getByText(/backups\/cluster/)).toBeTruthy();
  expect(within(transfers).getByText("69%")).toBeTruthy();
  expect(screen.getByText("Free space nearing reserve floor")).toBeTruthy();
  expect(screen.getByRole("link", { name: /media\/keynote/ })).toBeTruthy();
  expect(screen.queryByText(/no history kept/i)).toBeNull();
  expect(screen.queryByText(/api\/system/i)).toBeNull();
});

test("live operations keeps last data but marks it frozen after refresh failure", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/auth/me")
        return json({
          user: admin,
          role: "admin",
          legacy_service_credential: false,
        });
      if (input === "/api/system") {
        calls += 1;
        if (calls === 1) return json(system);
        throw new TypeError("offline");
      }
      if (input.startsWith("/api/files?"))
        return json({ items: [], next_cursor: null });
      throw new Error(`unexpected ${input}`);
    }),
  );
  render(
    <AuthProvider onUnauthenticated={vi.fn()}>
      <LiveOperations refreshMs={20} />
    </AuthProvider>,
  );
  expect(await screen.findByText("412.6 GB")).toBeTruthy();
  await waitFor(
    () => expect(screen.getByRole("status").textContent).toMatch(/frozen/i),
    { timeout: 1000 },
  );
  expect(screen.getByText("412.6 GB")).toBeTruthy();
  expect(screen.queryByText("69%")).toBeNull();
});

test("system status exposes runtime values, protected totals, and read-only limits", async () => {
  renderDashboard(<SystemStatus />);
  expect(await screen.findByText("System Health & Configuration")).toBeTruthy();
  expect(screen.getByText("config read-only")).toBeTruthy();
  expect(screen.getByText("v22.18.0")).toBeTruthy();
  expect(screen.getByText(/72 protected/)).toBeTruthy();
  expect(screen.getByText("2.0 GB per object")).toBeTruthy();
  expect(screen.getByText("64.0 GB kept free")).toBeTruthy();
  expect(screen.queryByText(/Docker/i)).toBeNull();
  expect(screen.queryByText(/CLI/i)).toBeNull();
});

test("system status has a recoverable initial error", async () => {
  renderDashboard(<SystemStatus />, null);
  expect(await screen.findByText("Couldn’t load system status")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
});
