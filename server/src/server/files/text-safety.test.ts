import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";

import { sanitizeExcerptLine } from "./text-safety";

describe("bounded excerpt sanitization", () => {
  it("preserves structural punctuation and indentation while removing actual locators", () => {
    const source = [
      "            with open(path, 'rb') as handle:",
      "services:",
      "version: 3",
      "color: #fff;",
      'const x: string = "a";',
      "fetch https://secret.example/token then continue",
      "contact user@example.com safely",
      "SENSITIVE—https://secret.example/a",
      "# Deploy [runbook](https://secret.example/path) now",
    ];
    assert.deepEqual(
      source.map((line) => sanitizeExcerptLine(line, 320)),
      [
        "            with open(path, 'rb') as handle:",
        "services:",
        "version: 3",
        "color: #fff;",
        'const x: string = "a";',
        "fetch then continue",
        "contact safely",
        "SENSITIVE—",
        "# Deploy [runbook] now",
      ],
    );
  });

  it("clamps adversarial lines before locator analysis with a live linear latency bound", () => {
    for (const value of ["A".repeat(262_144), "a.".repeat(131_072)]) {
      const started = performance.now();
      const output = sanitizeExcerptLine(value, 320);
      const elapsed = performance.now() - started;
      assert.ok(Buffer.byteLength(output) <= 320);
      assert.ok(elapsed < 75, `sanitization took ${elapsed.toFixed(1)} ms`);
    }
  });
});
