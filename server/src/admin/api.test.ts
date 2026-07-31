import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AdminApiError, buildFilesQuery, createAdminApi } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildFilesQuery", () => {
  it("serializes only the provided filters", () => {
    assert.equal(
      buildFilesQuery({
        q: "telemetry",
        name: "datasets/*.parquet",
        tags: ["ingest", "batch"],
        visibility: "private",
        limit: 16,
        cursor: "abc123",
      }),
      "q=telemetry&name=datasets%2F*.parquet&tag=ingest&tag=batch&visibility=private&limit=16&cursor=abc123",
    );
    assert.equal(buildFilesQuery({ limit: 25 }), "limit=25");
  });
});

describe("createAdminApi", () => {
  it("sends the bearer token and parses list responses", async () => {
    const seen: { url?: string; auth?: string | null } = {};
    const api = createAdminApi({
      fetchImpl: async (input, init) => {
        seen.url = input as string;
        seen.auth = new Headers(init?.headers).get("authorization");
        return jsonResponse(200, { items: [], next_cursor: null });
      },
      getToken: () => "secret-token",
    });
    const result = await api.listFiles({ limit: 5 });
    assert.deepEqual(result, { items: [], next_cursor: null });
    assert.equal(seen.url, "/api/files?limit=5");
    assert.equal(seen.auth, "Bearer secret-token");
  });

  it("classifies a 401 as an auth error", async () => {
    const api = createAdminApi({
      fetchImpl: async () =>
        jsonResponse(401, {
          error: {
            code: "unauthorized",
            message: "A valid bearer token is required",
          },
        }),
      getToken: () => "wrong",
    });
    await assert.rejects(api.getSystem(), (error: unknown) => {
      assert.ok(error instanceof AdminApiError);
      assert.equal(error.kind, "auth");
      return true;
    });
  });

  it("classifies missing tokens as auth errors without calling the network", async () => {
    let called = false;
    const api = createAdminApi({
      fetchImpl: async () => {
        called = true;
        return jsonResponse(200, {});
      },
      getToken: () => null,
    });
    await assert.rejects(api.getSystem(), (error: unknown) => {
      assert.ok(error instanceof AdminApiError);
      assert.equal(error.kind, "auth");
      return true;
    });
    assert.equal(called, false);
  });

  it("classifies API error payloads and network failures", async () => {
    const api = createAdminApi({
      fetchImpl: async () =>
        jsonResponse(400, {
          error: { code: "invalid_cursor", message: "Cursor is invalid" },
        }),
      getToken: () => "secret",
    });
    await assert.rejects(api.listFiles({ limit: 5 }), (error: unknown) => {
      assert.ok(error instanceof AdminApiError);
      assert.equal(error.kind, "api");
      assert.equal(error.message, "Cursor is invalid");
      return true;
    });

    const offline = createAdminApi({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      getToken: () => "secret",
    });
    await assert.rejects(offline.getSystem(), (error: unknown) => {
      assert.ok(error instanceof AdminApiError);
      assert.equal(error.kind, "disconnected");
      return true;
    });
  });

  it("performs deletes and patches against the file resource", async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    const api = createAdminApi({
      fetchImpl: async (input, init) => {
        calls.push({
          url: input as string,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        return jsonResponse(200, { id: "abc1234" });
      },
      getToken: () => "secret",
    });
    await api.deleteFile("abc1234");
    await api.updateFile("abc1234", {
      visibility: "public",
      tags: { operation: "set", values: ["a"] },
    });
    assert.deepEqual(calls[0], {
      url: "/api/files/abc1234",
      method: "DELETE",
      body: null,
    });
    assert.equal(calls[1]?.url, "/api/files/abc1234");
    assert.equal(calls[1]?.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[1]?.body ?? ""), {
      visibility: "public",
      tags: { operation: "set", values: ["a"] },
    });
  });

  it("uploads with name, tags, and visibility in the query string", async () => {
    const seen: { url?: string; method?: string } = {};
    const api = createAdminApi({
      fetchImpl: async (input, init) => {
        seen.url = input as string;
        seen.method = init?.method;
        return jsonResponse(201, { id: "abc1234" });
      },
      getToken: () => "secret",
    });
    const created = await api.uploadFile(new Blob(["hi"]), {
      name: "notes.txt",
      tags: ["a", "b"],
      visibility: "private",
    });
    assert.equal(created.id, "abc1234");
    assert.equal(seen.method, "POST");
    assert.equal(
      seen.url,
      "/api/files?name=notes.txt&tag=a&tag=b&private=true",
    );
  });

  it("fetches health without a token", async () => {
    const seen: { auth?: string | null } = {};
    const api = createAdminApi({
      fetchImpl: async (_input, init) => {
        seen.auth = new Headers(init?.headers).get("authorization");
        return jsonResponse(200, { status: "ok", free_bytes: 10 });
      },
      getToken: () => null,
    });
    const health = await api.getHealth();
    assert.equal(health.status, "ok");
    assert.equal(seen.auth, null);
  });
});
