import { afterEach, expect, test, vi } from "vitest";

import { newRequestId } from "./request-id";

afterEach(() => {
  vi.unstubAllGlobals();
});

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

test("falls back to getRandomValues with unique RFC 4122 v4 request ids", () => {
  const original = globalThis.crypto;
  vi.stubGlobal("crypto", {
    getRandomValues: original.getRandomValues.bind(original),
  });

  const ids = Array.from({ length: 128 }, () => newRequestId());

  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(UUID_V4);
});

test("fails definitively when no browser CSPRNG is available", () => {
  vi.stubGlobal("crypto", {});

  expect(() => newRequestId()).toThrow(
    "Secure request IDs are unavailable. Use HTTPS or a supported browser.",
  );
});
