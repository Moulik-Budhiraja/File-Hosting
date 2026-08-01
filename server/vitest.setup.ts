// CI must be warning-clean: any unexpected console.error/console.warn
// during a UI test (React act(...) violations, key warnings, stray
// component errors) fails that test instead of scrolling past.
import { afterEach, beforeEach, vi } from "vitest";

// React's act() support flag — async identity updates flush inside
// React's supported act() boundary instead of warning about the
// environment.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let consoleFailures: string[] = [];

function record(kind: string, args: unknown[]): void {
  consoleFailures.push(
    `console.${kind}: ${args
      .map((value) => (typeof value === "string" ? value : String(value)))
      .join(" ")}`,
  );
}

beforeEach(() => {
  consoleFailures = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    record("error", args);
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    record("warn", args);
  });
});

afterEach(() => {
  const failures = consoleFailures;
  consoleFailures = [];
  // AuthProvider's per-tab identity boundary is intentionally durable across
  // component remounts. Tests are independent browser sessions, so do not let
  // one test's synthetic identity own the next test's seeded task URL.
  window.sessionStorage.clear();
  if (failures.length > 0) {
    throw new Error(
      `Unexpected console output during test:\n${failures.join("\n")}`,
    );
  }
});
