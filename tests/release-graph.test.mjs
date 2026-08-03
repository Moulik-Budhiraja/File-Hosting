import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function text(relative) {
  return readFile(path.join(root, relative), "utf8");
}

test("one canonical root release command covers every required local gate", async () => {
  const release = await text("scripts/release-check.sh");
  assert.match(release, /set -euo pipefail/u);
  for (const command of [
    "npm --prefix server ci",
    "npm --prefix server run format:check",
    "npm --prefix server run lint",
    "npm --prefix server run typecheck",
    "npm --prefix server test",
    "npm --prefix server run package:check",
    "npm --prefix server run build",
    "npm --prefix server run test:compiled",
    "npm --prefix server run test:standalone",
    "npm --prefix server run design:audit",
    "npm --prefix server audit --omit=dev --audit-level=low",
    "npm --prefix server audit --audit-level=low",
    "npm --prefix cli ci",
    "npm --prefix cli run typecheck",
    "npm --prefix cli test",
    "npm --prefix cli run build",
    "npm --prefix cli audit --omit=dev --audit-level=low",
    "npm --prefix cli audit --audit-level=low",
    "node --test tests/e2e.test.mjs tests/compose.test.mjs tests/release-graph.test.mjs",
    "node scripts/run-rich-link-probe.mjs",
    "scripts/compose-runtime-check.sh",
  ]) {
    assert.ok(release.includes(command), `canonical release command omits: ${command}`);
  }
  assert.match(release, /OG_DESIGN_REFERENCE_DIR=.*server\/test-fixtures\/og-design-v2/u);
});

test("release CI executes the canonical gate and requires Docker Compose runtime", async () => {
  const workflow = await text(".github/workflows/release.yml");
  assert.match(workflow, /runs-on: ubuntu-latest/u);
  assert.match(workflow, /REQUIRE_DOCKER: "1"/u);
  assert.match(workflow, /\.\/scripts\/release-check\.sh/u);
  assert.match(workflow, /docker compose version/u);
});

test("Compose runtime gate builds, starts, probes, and always tears down the real image", async () => {
  const runtime = await text("scripts/compose-runtime-check.sh");
  assert.match(runtime, /docker compose build/u);
  assert.match(runtime, /docker compose up -d/u);
  assert.match(runtime, /docker compose exec -T server/u);
  assert.match(runtime, /\/healthz/u);
  assert.match(runtime, /\/og\//u);
  assert.match(runtime, /trap .*docker compose down/u);
  assert.match(runtime, /REQUIRE_DOCKER/u);
});

test("non-production rich-link runner has a production guard and generates visual contexts", async () => {
  const runner = await text("scripts/run-rich-link-probe.mjs");
  assert.match(runner, /files\.moulik\.dev/u);
  assert.match(runner, /rich-link-preview-probe\.mjs/u);
  assert.match(runner, /FS_PROBE_SCREENSHOTS/u);
  assert.match(runner, /NODE_ENV: "production"/u);
  assert.match(runner, /SIGTERM/u);
  assert.match(runner, /SIGKILL/u);
});

test("canonical freeze and manifest are source-pinned without a fixture update command", async () => {
  await access(path.join(root, "server/test-fixtures/og-design-v2/DESIGN-FREEZE-2026-08-03.md"));
  const audit = await text("server/scripts/design-audit.ts");
  assert.match(audit, /PINNED_FREEZE_SHA256/u);
  assert.match(audit, /PINNED_MANIFEST_SHA256/u);
  assert.match(audit, /DESIGN-FREEZE-2026-08-03\.md/u);
  const packageJson = await text("server/package.json");
  assert.doesNotMatch(packageJson, /(?:update|refresh|approve|baseline).*fixture/iu);
});

test("design audit covers all stress states, every content-zone mutant, and real host metadata", async () => {
  const audit = await text("server/scripts/design-audit.ts");
  assert.match(audit, /stress-06-mobile-crop/u);
  assert.match(audit, /stress-07-unavailable/u);
  assert.match(audit, /stressCount: Object\.keys\(stressMetrics\)\.length/u);
  assert.match(audit, /brandRemovalMutant/u);
  assert.match(audit, /factsRemovalMutant/u);
  assert.match(audit, /brandZoneRejected: cases\.length/u);
  assert.match(audit, /factsZoneRejected: cases\.length/u);
  assert.match(audit, /mobileMetadata/u);
  assert.match(audit, /files\.moulik\.dev/u);
  assert.match(audit, /titleDomainInk/u);
  assert.match(audit, /actualMessagesProof: false/u);
  assert.doesNotMatch(audit, /stressCount: 7/u);
});

test("operator docs route release through the canonical command and state exact media containment", async () => {
  const readme = await text("README.md");
  assert.match(readme, /\.\/scripts\/release-check\.sh/u);
  assert.match(readme, /private, mode-0600 snapshot/u);
  assert.match(readme, /file,pipe/u);
  assert.doesNotMatch(readme, /source bytes only on stdin/u);
  assert.doesNotMatch(readme, /Node's permission model:[\s\S]{0,250}network .* denied/iu);
});
