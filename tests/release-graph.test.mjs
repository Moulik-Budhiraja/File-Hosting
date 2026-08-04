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
    assert.ok(
      release.includes(command),
      `canonical release command omits: ${command}`,
    );
  }
  assert.match(
    release,
    /OG_DESIGN_REFERENCE_DIR=.*server\/test-fixtures\/og-design-v2/u,
  );
});

test("release CI executes the canonical gate and requires Docker Compose runtime", async () => {
  const [workflow, processTree] = await Promise.all([
    text(".github/workflows/release.yml"),
    text("server/src/server/files/process-tree.ts"),
  ]);
  assert.match(workflow, /runs-on: ubuntu-latest/u);
  assert.match(workflow, /REQUIRE_DOCKER: "1"/u);
  assert.match(workflow, /\.\/scripts\/release-check\.sh/u);
  assert.match(workflow, /docker compose version/u);
  assert.match(
    workflow,
    /apt-get install -y[^\n]*bubblewrap/u,
    "production standalone CI must install the required Linux process sandbox",
  );
  assert.match(
    workflow,
    /sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/u,
    "Ubuntu 24.04 CI must allow Bubblewrap to create its isolated user namespace",
  );
  const releaseJob = workflow.match(
    /jobs:\n  release:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|$)/u,
  )?.[1];
  assert.ok(releaseJob, "release workflow must contain jobs.release");
  const sandboxProbe = releaseJob.match(
    /- name: Enable and verify the Linux process sandbox\n\s+run: \|\n([\s\S]*?)(?=\n\s+- name:)/u,
  )?.[1];
  assert.ok(sandboxProbe, "release job must contain the Linux sandbox probe step");
  const productionSandbox = processTree.match(
    /const sandboxRootArguments = \[([\s\S]*?)\n\s*\];([\s\S]*?)const spawnCommand/u,
  )?.[0];
  assert.ok(productionSandbox, "production sandbox arguments must remain inspectable");
  const requiredTokens = new Set(
    [...productionSandbox.matchAll(/"(--[^"]+|\/[^"]+)"/gu)].map(
      ([, token]) => token,
    ),
  );
  for (const token of requiredTokens) {
    assert.ok(
      sandboxProbe.includes(token),
      `Linux sandbox probe must contain production token: ${token}`,
    );
  }
  if (productionSandbox.includes("process.cwd()")) {
    assert.ok(
      sandboxProbe.includes('"$PWD"'),
      "Linux sandbox probe must map production process.cwd() paths to the CI workspace",
    );
  }
  assert.ok(
    sandboxProbe.includes("-- /usr/bin/true"),
    "Linux sandbox probe must execute a harmless command inside the namespace",
  );
  const sandboxSmoke = releaseJob.indexOf(
    "- name: Enable and verify the Linux process sandbox",
  );
  const canonicalGate = releaseJob.indexOf(
    "- name: Run canonical release gate",
  );
  assert.ok(
    sandboxSmoke >= 0 && canonicalGate > sandboxSmoke,
    "the Linux sandbox smoke step must run in jobs.release before the canonical gate",
  );
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
  await access(
    path.join(
      root,
      "server/test-fixtures/og-design-v2/DESIGN-FREEZE-2026-08-03.md",
    ),
  );
  const audit = await text("server/scripts/design-audit.ts");
  assert.match(audit, /PINNED_FREEZE_SHA256/u);
  assert.match(audit, /PINNED_MANIFEST_SHA256/u);
  assert.match(audit, /DESIGN-FREEZE-2026-08-03\.md/u);
  const packageJson = await text("server/package.json");
  assert.doesNotMatch(
    packageJson,
    /(?:update|refresh|approve|baseline).*fixture/iu,
  );
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

test("resource-sensitive preview surface contains no dead helpers, guards, protocols, or assets", async () => {
  const combined = (
    await Promise.all([
      text("server/src/server/files/source-state.ts"),
      text("server/src/server/files/preview.ts"),
      text("server/src/server/files/raster-worker.ts"),
      text("server/src/server/files/preview-renderers.ts"),
    ])
  ).join("\n");
  assert.doesNotMatch(
    combined,
    /sourceMatchesFile|isMissingSourceError|extractFirstMarkdownHeading|isPreviewBusy|deriveRasterThumbnailInWorker|"thumbnail"|if \(!packagedFf(?:mpeg|probe)\)/u,
  );
  for (const asset of ["1f4e1.svg", "1f600.svg", "1f680.svg"]) {
    await assert.rejects(
      access(path.join(root, "server/runtime/assets/twemoji", asset)),
      /ENOENT/u,
    );
  }
});

test("standalone traces exact Twemoji licensing and excludes TypeScript", async () => {
  const [config, attribution, standalone, renderWorker] = await Promise.all([
    text("server/next.config.js"),
    text("server/runtime/assets/twemoji/ATTRIBUTION.md"),
    text("server/scripts/standalone-og-e2e.mjs"),
    text("server/runtime/og-render-worker.mjs"),
  ]);
  assert.match(config, /@twemoji\/svg\/\{license\*,readme\.md\}/u);
  assert.match(
    config,
    /outputFileTracingExcludes[\s\S]*next-server[\s\S]*\*\*\/node_modules\/typescript\/\*\*\/\*/u,
  );
  assert.match(attribution, /@twemoji\/svg 15\.0\.0/u);
  assert.match(attribution, /v15\.0\.0/u);
  for (const required of [
    "@twemoji/svg/license",
    "@twemoji/svg/readme.md",
    "@napi-rs/canvas",
    "sharp",
  ]) {
    assert.ok(
      standalone.includes(required),
      `${required} is not package-verified`,
    );
  }
  assert.match(standalone, /node_modules["'],\s*["']typescript/u);
  assert.match(
    renderWorker,
    /const MAX_OUTPUT_PIXELS = OUTPUT_WIDTH \* OUTPUT_HEIGHT;/u,
    "worker must cap raw output allocation to the fixed OG pixel envelope",
  );
  assert.match(
    renderWorker,
    /width \* height > MAX_OUTPUT_PIXELS/u,
    "worker must reject oversized raw output before allocating it",
  );
  const primaryTimeout = renderWorker.match(
    /const PRIMARY_RENDER_SECONDS = ([\d.]+);/u,
  );
  assert.ok(primaryTimeout, "worker must publish its sharp stage timeout");
  assert.ok(
    Number(primaryTimeout[1]) < 2.5,
    "worker sharp work must fit below the outer 2.5 second wall deadline",
  );
  assert.match(
    renderWorker,
    /function validateOpaquePng[\s\S]*color type[\s\S]*=== 2/u,
    "worker must validate dimensions and RGB color type from emitted PNG bytes",
  );
  assert.match(
    renderWorker,
    /if \(process\.platform === "linux"\)[\s\S]*\.raw\(\)[\s\S]*encodeRgbPng\(rgb, width, height\)[\s\S]*validateOpaquePng\(png, width, height\)[\s\S]*writeSync\(1, png\)/u,
    "Linux must use one bounded sharp stage and a validated RGB-only PNG encoder",
  );
  assert.match(
    renderWorker,
    /else \{[\s\S]*validateOpaquePng\(encoded, width, height\)[\s\S]*writeSync\(1, encoded\)/u,
    "already-approved non-Linux opaque bytes must pass through unchanged",
  );
});

test("automated design evidence identifies the Node gate without model attestation", async () => {
  const audit = await text("server/scripts/design-audit.ts");
  assert.match(audit, /automatedDesignGate:\s*"node\/tsx"/u);
  assert.doesNotMatch(audit, /modelProvider|gpt-5\.6-sol|openai-codex/iu);
});

test("operator docs route release through the canonical command and state exact media containment", async () => {
  const readme = await text("README.md");
  assert.match(readme, /\.\/scripts\/release-check\.sh/u);
  assert.match(readme, /private, mode-0600 snapshot/u);
  assert.match(readme, /file,pipe/u);
  assert.doesNotMatch(readme, /source bytes only on stdin/u);
  assert.doesNotMatch(
    readme,
    /Node's permission model:[\s\S]{0,250}network .* denied/iu,
  );
});
