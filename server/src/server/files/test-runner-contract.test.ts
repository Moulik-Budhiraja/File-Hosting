import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const runnerPath = path.resolve(process.cwd(), "scripts/run-server-tests.mjs");
const ogTestPath = path.resolve(
  process.cwd(),
  "src/server/files/og-v2.test.ts",
);

describe("native-heavy release fixture isolation", () => {
  it("runs bcrypt auth and Sharp derivative fixtures in separate processes", async () => {
    const runner = await readFile(runnerPath, "utf8");
    assert.match(runner, /"auth\.test\.ts"/u);
    assert.match(runner, /"image-derivatives\.test\.ts"/u);
    assert.match(runner, /"files\.test\.ts"/u);
    assert.match(runner, /"responsive-pdf\.test\.ts"/u);
    assert.match(runner, /files: \["src\/server\/auth\/auth\.test\.ts"\]/u);
    assert.match(runner, /files: \["src\/server\/files\/files\.test\.ts"\]/u);
    assert.match(
      runner,
      /files: \["src\/server\/files\/image-derivatives\.test\.ts"\]/u,
    );
  });

  it("serializes the six production font probes inside their existing deadline", async () => {
    const source = await readFile(ogTestPath, "utf8");
    const start = source.indexOf(
      'it("loads bundled Inter and JetBrains Mono in the production OG worker"',
    );
    const end = source.indexOf(
      'it("renders bundled Latin, CJK, and Arabic fonts',
      start,
    );
    assert.ok(start >= 0 && end > start);
    const fixture = source.slice(start, end);
    assert.doesNotMatch(fixture, /Promise\.all/u);
    assert.match(fixture, /for \(const \[family, text\] of probes\)/u);
  });
});
