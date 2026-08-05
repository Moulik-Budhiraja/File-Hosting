import { describe, expect, test } from "vitest";

import { checkPassword } from "./password-policy";
import { TEMP_PASSWORD_ENTROPY_BITS, generateTempPassword } from "./password";

describe("generateTempPassword", () => {
  test("targets at least 128 bits of entropy", () => {
    expect(TEMP_PASSWORD_ENTROPY_BITS).toBeGreaterThanOrEqual(128);
  });

  test("always satisfies the shared password policy (12 cp / 72 bytes)", () => {
    for (let i = 0; i < 200; i += 1) {
      const password = generateTempPassword();
      expect(checkPassword(password)).toEqual({ ok: true });
      expect(new TextEncoder().encode(password).length).toBeLessThanOrEqual(72);
    }
  });

  test("uses a power-of-two alphabet so byte masking cannot introduce modulo bias", () => {
    const password = generateTempPassword();
    // 64-symbol URL-safe alphabet, 6 bits per character.
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(password.length).toBeGreaterThanOrEqual(Math.ceil(128 / 6));
  });

  test("produces distinct values across calls", () => {
    const seen = new Set(
      Array.from({ length: 100 }, () => generateTempPassword()),
    );
    expect(seen.size).toBe(100);
  });

  test("emits every alphabet symbol class across many samples (uniformity smoke)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i += 1) {
      for (const char of generateTempPassword()) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
    // With 300×22+ uniform draws over 64 symbols every symbol should appear.
    expect(counts.size).toBe(64);
  });
});
