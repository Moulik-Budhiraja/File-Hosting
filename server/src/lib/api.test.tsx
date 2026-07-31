import { afterEach, expect, test, vi } from "vitest";

import { ApiError, apiFetch } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

test("apiFetch returns parsed JSON on success", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { user: { id: "u1" } })),
  );
  const body = await apiFetch<{ user: { id: string } }>("/api/auth/me");
  expect(body.user.id).toBe("u1");
});

test("apiFetch throws ApiError with server code and message", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(409, {
        error: {
          code: "last_active_admin",
          message: "The last active admin cannot be disabled or demoted",
        },
      }),
    ),
  );
  const failure = await apiFetch("/api/users/u1", {
    method: "PATCH",
    body: { active: false },
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ApiError);
  const apiError = failure as ApiError;
  expect(apiError.status).toBe(409);
  expect(apiError.code).toBe("last_active_admin");
  expect(apiError.message).toContain("last active admin");
});

test("apiFetch maps malformed error bodies to a generic internal error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("bad gateway", { status: 502 })),
  );
  const failure = await apiFetch("/api/files").then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).status).toBe(502);
  expect((failure as ApiError).code).toBe("internal_error");
});

test("apiFetch sends JSON bodies with same-origin credentials", async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  await apiFetch("/api/auth/password", {
    method: "POST",
    body: { current_password: "a", new_password: "b" },
  });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe("/api/auth/password");
  expect(init.method).toBe("POST");
  expect(init.credentials).toBe("same-origin");
  expect(init.headers).toMatchObject({ "content-type": "application/json" });
  expect(JSON.parse(init.body as string)).toEqual({
    current_password: "a",
    new_password: "b",
  });
});

test("apiFetch notifies the registered unauthorized handler on 401", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(401, {
        error: {
          code: "unauthorized",
          message: "A valid bearer token is required",
        },
      }),
    ),
  );
  const seen: string[] = [];
  const { onUnauthorized } = await import("./api");
  const release = onUnauthorized(() => seen.push("expired"));
  try {
    await apiFetch("/api/api-keys").catch(() => null);
    expect(seen).toEqual(["expired"]);
  } finally {
    release();
  }
});

test("login requests skip the unauthorized handler so bad credentials stay inline", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(401, {
        error: {
          code: "invalid_credentials",
          message: "Invalid username or password",
        },
      }),
    ),
  );
  const seen: string[] = [];
  const { onUnauthorized } = await import("./api");
  const release = onUnauthorized(() => seen.push("expired"));
  try {
    await apiFetch("/api/auth/login", {
      method: "POST",
      body: { username: "x", password: "y" },
      skipUnauthorizedHandler: true,
    }).catch(() => null);
    expect(seen).toEqual([]);
  } finally {
    release();
  }
});
