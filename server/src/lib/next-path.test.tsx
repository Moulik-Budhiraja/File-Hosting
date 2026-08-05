import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { sanitizeNextPath } from "./next-path";

const BASE = "http://localhost:3000";
const FALLBACK = "/files";

function credentialedUrl(username: string, password: string, host: string) {
  const colon = String.fromCharCode(58);
  const at = String.fromCharCode(64);
  return `https://${username}${colon}${password}${at}${host}`;
}

test("redirect sanitizer source stays text-reviewable without literal NUL bytes", () => {
  for (const file of ["./next-path.ts", "./next-path.test.tsx"]) {
    const bytes = readFileSync(new URL(file, import.meta.url));
    expect(bytes.includes(0), `${file} contains a literal NUL byte`).toBe(
      false,
    );
  }
});

describe("sanitizeNextPath accepts safe same-origin paths", () => {
  test.each([
    ["/files", "/files"],
    ["/users", "/users"],
    [
      "/files?q=report&visibility=private",
      "/files?q=report&visibility=private",
    ],
    [
      "/files?scope=mine&cursor=abc#row-3",
      "/files?scope=mine&cursor=abc#row-3",
    ],
    ["/keys?owner=me", "/keys?owner=me"],
    ["/account", "/account"],
  ])("%s → %s", (raw, expected) => {
    expect(sanitizeNextPath(raw, BASE)).toBe(expected);
  });
});

describe("sanitizeNextPath rejects unsafe values", () => {
  test.each([
    [null],
    [undefined],
    [""],
    ["files"],
    ["//evil.example"],
    ["//evil.example/path"],
    ["/\\evil.example"],
    ["\\/evil.example"],
    ["/\\\\evil.example/audit"],
    ["/%5C%5Cexample.invalid/audit"],
    ["/%5cevil.example"],
    ["https://evil.example/files"],
    ["http://localhost:3000/files"],
    [credentialedUrl("localhost", "3000", "evil.example/")],
    [credentialedUrl("user", "pass", "evil.example/")],
    ["javascript:alert(1)"],
    ["/files\u0000"],
    ["/files\r\nSet-Cookie:x"],
    ["/files\t"],
    ["/%00files"],
    ["/%0d%0afiles"],
    ["/files%ZZ"],
    ["/files\\..\\users"],
    [" //evil.example"],
  ])("%j → fallback", (raw) => {
    expect(sanitizeNextPath(raw as string | null | undefined, BASE)).toBe(
      FALLBACK,
    );
  });

  test("a path resolving off-origin is rejected even if it starts with /", () => {
    // Browsers treat  /\  and  //  as network-path references.
    expect(sanitizeNextPath("/\\example.invalid/x", BASE)).toBe(FALLBACK);
    expect(sanitizeNextPath("//example.invalid/x", BASE)).toBe(FALLBACK);
  });
});
