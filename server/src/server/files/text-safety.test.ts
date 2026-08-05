import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";

import { sanitizeExcerptLine, sanitizeLocatorFreeText } from "./text-safety";

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

  it("preserves ordinary identifiers and safe filenames while stripping true locators", () => {
    const preserved = [
      "name: file-hosting",
      "file_path = os.environ['FS_STORAGE_DIR']",
      "http_client = requests.Session()",
      "ftp_server.connect()",
      "libfoo.so is loaded at runtime",
      "See file-hosting.md and release-v2.1.0.tar.gz",
    ];
    assert.deepEqual(
      preserved.map((line) => sanitizeExcerptLine(line, 320)),
      preserved,
    );

    const scrubbed = [
      "fetch https://secret.example/token now",
      "mirror ftp://secret.example/archive",
      "open file:///etc/private.conf later",
      "mail admin@secret.example.com safely",
      "visit 192.168.1.5:8080/admin now",
      "read /etc/secret/config.yaml next",
      "request https://secret.example/path?token=secret&key=value now",
    ];
    for (const line of scrubbed) {
      const output = sanitizeExcerptLine(line, 320);
      assert.doesNotMatch(
        output,
        /secret\.example|admin@|192\.168|\/etc\/|token=|key=/u,
      );
    }
  });

  it("removes colon-only, query-only, and fragment-only locators without stripping syntax", () => {
    const source = [
      "resolve urn:private-token safely",
      "connect ssh:internal-host now",
      "decode data:text/plain,secret later",
      "open ?token then #internal",
    ];
    for (const line of source) {
      const output = sanitizeExcerptLine(line, 320);
      assert.doesNotMatch(output, /urn:|ssh:|data:|\?token|#internal/u);
    }
    assert.equal(
      sanitizeLocatorFreeText("urn:private-token", 120, "File"),
      "File",
    );
    assert.equal(sanitizeLocatorFreeText("#internal", 120, "File"), "File");
    assert.equal(sanitizeExcerptLine("services:", 320), "services:");
    assert.equal(sanitizeExcerptLine("color: #fff;", 320), "color: #fff;");
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
