import { describe, expect, test } from "vitest";

import {
  MAX_PASSWORD_UTF8_BYTES,
  MIN_PASSWORD_CODE_POINTS,
  checkPassword,
  utf8ByteLength,
} from "./password-policy";

test("policy constants match the backend contract exactly", () => {
  expect(MIN_PASSWORD_CODE_POINTS).toBe(12);
  expect(MAX_PASSWORD_UTF8_BYTES).toBe(72);
});

test("utf8ByteLength counts multi-byte characters", () => {
  expect(utf8ByteLength("abc")).toBe(3);
  expect(utf8ByteLength("é")).toBe(2);
  expect(utf8ByteLength("🔑")).toBe(4);
});

describe("checkPassword", () => {
  test("accepts a 12-code-point ASCII password", () => {
    expect(checkPassword("abcdefghijkl")).toEqual({ ok: true });
  });

  test("accepts 12 emoji within 72 bytes", () => {
    // 12 code points, 48 bytes.
    expect(checkPassword("🔑".repeat(12))).toEqual({ ok: true });
  });

  test("rejects 11 code points as too short with counts", () => {
    expect(checkPassword("abcdefghijk")).toEqual({
      ok: false,
      reason: "too-short",
      codePoints: 11,
    });
  });

  test("counts code points, not UTF-16 units, when checking length", () => {
    // 11 astral code points are 22 UTF-16 units but still too short.
    const eleven = "🔑".repeat(11);
    expect(eleven.length).toBe(22);
    expect(checkPassword(eleven)).toEqual({
      ok: false,
      reason: "too-short",
      codePoints: 11,
    });
  });

  test("rejects 20 emoji as over 72 UTF-8 bytes with counts", () => {
    // 20 code points but 80 bytes — the exact Sol P2-6 case.
    expect(checkPassword("🔑".repeat(20))).toEqual({
      ok: false,
      reason: "too-long",
      bytes: 80,
    });
  });

  test("accepts exactly 72 bytes and rejects 73", () => {
    expect(checkPassword("a".repeat(72))).toEqual({ ok: true });
    expect(checkPassword("a".repeat(73))).toEqual({
      ok: false,
      reason: "too-long",
      bytes: 73,
    });
  });
});
