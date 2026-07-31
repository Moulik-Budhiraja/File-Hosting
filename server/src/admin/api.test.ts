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

  it("serializes the archive filter when set", () => {
    assert.equal(
      buildFilesQuery({ archive: "tar.gz", limit: 16 }),
      "archive=tar.gz&limit=16",
    );
    assert.equal(
      buildFilesQuery({ archive: "none", limit: 16 }),
      "archive=none&limit=16",
    );
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

  it("uploads with metadata in x-fs-* headers and a metadata-free URL", async () => {
    const seen: { url?: string; method?: string; headers?: Headers } = {};
    const api = createAdminApi({
      fetchImpl: async (input, init) => {
        seen.url = input as string;
        seen.method = init?.method;
        seen.headers = new Headers(init?.headers);
        return jsonResponse(201, { id: "abc1234" });
      },
      getToken: () => "secret",
    });
    const created = await api.uploadFile(new Blob(["hi"]), {
      name: "café notes.txt",
      tags: ["a", "télé b"],
      visibility: "private",
      archive: "tar.gz",
    });
    assert.equal(created.id, "abc1234");
    assert.equal(seen.method, "POST");
    // Filenames and tags must never appear in the request URL (access logs).
    assert.equal(seen.url, "/api/files");
    assert.equal(
      seen.headers?.get("x-fs-name"),
      encodeURIComponent("café notes.txt"),
    );
    assert.equal(
      seen.headers?.get("x-fs-tags"),
      ["a", encodeURIComponent("télé b")].join(","),
    );
    assert.equal(seen.headers?.get("x-fs-private"), "true");
    assert.equal(seen.headers?.get("x-fs-archive"), "tar.gz");
  });

  it("omits the private and archive headers for public non-archive uploads", async () => {
    const seen: { headers?: Headers } = {};
    const api = createAdminApi({
      fetchImpl: async (_input, init) => {
        seen.headers = new Headers(init?.headers);
        return jsonResponse(201, { id: "abc1234" });
      },
      getToken: () => "secret",
    });
    await api.uploadFile(new Blob(["hi"]), {
      name: "plain.txt",
      tags: [],
      visibility: "public",
    });
    assert.equal(seen.headers?.get("x-fs-private"), null);
    assert.equal(seen.headers?.get("x-fs-archive"), null);
    assert.equal(seen.headers?.get("x-fs-tags"), null);
  });

  it("omits the range header for zero-byte text previews", async () => {
    const seen: { range?: string | null } = {};
    const api = createAdminApi({
      fetchImpl: async (_input, init) => {
        seen.range = new Headers(init?.headers).get("range");
        return new Response("", { status: 200 });
      },
      getToken: () => "secret",
    });
    const text = await api.fetchRawText("abc1234", 0);
    assert.equal(text, "");
    assert.equal(seen.range, null);
  });

  it("passes an abort signal through raw fetches", async () => {
    const seen: { signals: (AbortSignal | null | undefined)[] } = {
      signals: [],
    };
    const api = createAdminApi({
      fetchImpl: async (_input, init) => {
        seen.signals.push(init?.signal);
        return new Response("body", { status: 200 });
      },
      getToken: () => "secret",
    });
    const controller = new AbortController();
    await api.fetchRawText("abc1234", 16, { signal: controller.signal });
    await api.fetchRawBlob("abc1234", { signal: controller.signal });
    assert.deepEqual(seen.signals, [controller.signal, controller.signal]);
  });

  // Finding 2: an aborted request is a client decision, not a connectivity
  // failure — the abort must surface unchanged so callers can treat it as
  // ordinary cancellation instead of rendering "Could not reach the server".
  it("rethrows abort errors unchanged instead of classifying them as disconnected", async () => {
    const abortError = new DOMException(
      "The user aborted a request.",
      "AbortError",
    );
    const api = createAdminApi({
      fetchImpl: async () => {
        throw abortError;
      },
      getToken: () => "secret",
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      api.fetchRawStream("abc1234", { signal: controller.signal }),
      (error: unknown) => {
        assert.equal(error, abortError);
        return true;
      },
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
