import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { SESSION_IDLE_HOURS, SESSION_MAX_DAYS } from "./session-policy";

const readme = readFileSync("README.md", "utf8").replace(/\s+/gu, " ");

function dayBound(days: number): string {
  return days === 7 ? "seven-day" : `${days}-day`;
}

describe("operator session contract", () => {
  test("documents the shared idle and fixed maximum bounds", () => {
    expect(readme).toContain(
      `opaque server-side session bounded by ${SESSION_IDLE_HOURS} hours idle and a fixed ${dayBound(SESSION_MAX_DAYS)} maximum`,
    );
  });
});
