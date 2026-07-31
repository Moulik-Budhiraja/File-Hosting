import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import LoginPage from "./page";

beforeEach(() => {
  replace.mockReset();
  window.history.replaceState(null, "", "/login");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
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

async function signIn() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(200, { user, expires_at: "2026-08-07T00:00:00.000Z" }),
    ),
  );
  render(<LoginPage />);
  await userEvent.type(await screen.findByLabelText("Username"), "ops-admin");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse bat");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

test("a backslash network-path next value falls back to /files", async () => {
  window.history.replaceState(
    null,
    "",
    "/login?next=" + encodeURIComponent("/\\\\example.invalid/audit"),
  );
  await signIn();
  expect(replace).toHaveBeenCalledWith("/files");
});

test("a foreign-origin absolute next value falls back to /files", async () => {
  window.history.replaceState(
    null,
    "",
    "/login?next=" + encodeURIComponent("https://evil.example/x"),
  );
  await signIn();
  expect(replace).toHaveBeenCalledWith("/files");
});

test("a safe same-origin next path keeps its query and hash", async () => {
  window.history.replaceState(
    null,
    "",
    "/login?next=" + encodeURIComponent("/files?q=report&scope=mine#row"),
  );
  await signIn();
  expect(replace).toHaveBeenCalledWith("/files?q=report&scope=mine#row");
});

test("expired=1 with storage reads throwing still renders the login form", async () => {
  window.history.replaceState(null, "", "/login?expired=1");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  render(<LoginPage />);
  expect(await screen.findByLabelText("Username")).toBeTruthy();
  expect(
    screen.getByText("Session expired — sign in again to continue."),
  ).toBeTruthy();
});

test("expired=1 prefills the last username when storage is readable", async () => {
  window.localStorage.setItem("fs.last-username", "ops-admin");
  window.history.replaceState(null, "", "/login?expired=1");
  render(<LoginPage />);
  expect(
    ((await screen.findByLabelText("Username")) as HTMLInputElement).value,
  ).toBe("ops-admin");
});

test("changed=1 shows the truthful password-changed notice, not expiry", async () => {
  window.history.replaceState(null, "", "/login?changed=1&next=%2Faccount");
  render(<LoginPage />);
  expect(
    await screen.findByText(
      "Password changed — sign in again with your new password.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/session expired/i)).toBeNull();
});

test("sign-in success with storage writes throwing still navigates", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  await signIn();
  expect(replace).toHaveBeenCalledWith("/files");
});
