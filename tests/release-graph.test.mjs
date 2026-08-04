import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

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
  const [workflow, releaseCheck, processTree, sandboxModule, sandboxVerifier] =
    await Promise.all([
      text(".github/workflows/release.yml"),
      text("scripts/release-check.sh"),
      text("server/src/server/files/process-tree.ts"),
      text("server/runtime/linux-sandbox.js"),
      text("server/runtime/verify-linux-sandbox.js"),
    ]);
  assert.match(workflow, /runs-on: ubuntu-latest/u);
  assert.match(
    workflow,
    /- uses: actions\/checkout@[a-f0-9]+(?: # v\d+)?\n\s+with:\n\s+ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u,
    "release CI must execute the immutable PR head rather than GitHub's synthetic merge ref",
  );
  assert.match(workflow, /REQUIRE_DOCKER: "1"/u);
  assert.match(workflow, /\.\/scripts\/release-check\.sh/u);
  const canonicalRelease = workflow.match(
    /- name: Run canonical release gate\n([\s\S]*?)(?=\n\s+- name:)/u,
  )?.[1];
  const uploadDiagnostics = workflow.match(
    /- name: Upload design failure diagnostics\n([\s\S]*?)(?=\n\s+- name:)/u,
  )?.[1];
  const failRejectedRelease = workflow.match(
    /- name: Fail a rejected canonical release\n([\s\S]*)$/u,
  )?.[1];
  assert.ok(canonicalRelease);
  assert.ok(uploadDiagnostics);
  assert.ok(failRejectedRelease);
  assert.match(canonicalRelease, /id: canonical_release/u);
  assert.match(canonicalRelease, /continue-on-error: true/u);
  assert.ok(
    workflow.indexOf("- name: Run canonical release gate") <
      workflow.indexOf("- name: Upload design failure diagnostics") &&
      workflow.indexOf("- name: Upload design failure diagnostics") <
        workflow.indexOf("- name: Fail a rejected canonical release"),
    "diagnostic upload and explicit rejection must follow the canonical gate",
  );
  assert.match(
    uploadDiagnostics,
    /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u,
  );
  assert.match(
    uploadDiagnostics,
    /if: \$\{\{ always\(\) && steps\.canonical_release\.outcome == 'failure' \}\}/u,
  );
  const designAuditDirectory = releaseCheck.match(
    /file-hosting-design-audit-release/u,
  )?.[0];
  assert.ok(designAuditDirectory);
  assert.match(
    uploadDiagnostics,
    new RegExp(`/tmp/${designAuditDirectory}/diagnostic-`, "u"),
  );
  assert.match(
    failRejectedRelease,
    /if: \$\{\{ always\(\) && steps\.canonical_release\.outcome == 'failure' \}\}/u,
  );
  assert.match(failRejectedRelease, /run: exit 1/u);
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
  assert.ok(
    sandboxProbe,
    "release job must contain the Linux sandbox probe step",
  );
  assert.match(
    processTree,
    /import \{ linuxSandboxArguments \} from "\.\.\/\.\.\/\.\.\/runtime\/linux-sandbox\.js";/u,
    "production must consume the shared Linux sandbox argument builder",
  );
  assert.match(
    processTree,
    /linuxSandboxArguments\(\s*process\.cwd\(\),\s*options\.cwd \?\? process\.cwd\(\),\s*process\.execPath,\s*\)/u,
    "production must pass its actual child working directory to the shared builder",
  );
  assert.match(
    sandboxProbe,
    /node server\/runtime\/verify-linux-sandbox\.js/u,
    "CI must execute the shared production sandbox verifier",
  );
  assert.match(
    sandboxVerifier,
    /import \{ linuxSandboxArguments \} from "\.\/linux-sandbox\.js";/u,
    "CI verifier must import the same sandbox argument builder as production",
  );
  assert.match(
    sandboxVerifier,
    /spawnSync\(\s*"\/usr\/bin\/bwrap",\s*\[\s*\.\.\.linuxSandboxArguments\(\s*process\.cwd\(\),\s*process\.cwd\(\),\s*process\.execPath,?\s*\),\s*"--",\s*process\.execPath,\s*"-e",\s*"process\.exit\(0\)",?\s*\]/u,
    "CI must execute the shared production arguments without reconstructing them",
  );
  for (const exactMount of [
    '["--ro-bind", "/usr", "/usr"]',
    '["--ro-bind", "/lib", "/lib"]',
    '["--ro-bind", "/lib64", "/lib64"]',
    '["--ro-bind", "/opt", "/opt"]',
    '["--bind", "/tmp", "/tmp"]',
  ]) {
    assert.ok(
      sandboxModule.includes(exactMount),
      `shared sandbox builder must retain ${exactMount}`,
    );
  }
  assert.doesNotMatch(
    sandboxProbe,
    /--(?:ro-bind|bind|dev|proc|chdir|unshare-all|new-session|die-with-parent)/u,
    "CI must not duplicate production sandbox flags",
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

test("Linux sandbox keeps nested app roots read-only and pins worker temp paths", async () => {
  const [{ linuxSandboxArguments }, previewRenderers, rasterWorker] =
    await Promise.all([
      import(
        pathToFileURL(path.join(root, "server/runtime/linux-sandbox.js")).href
      ),
      text("server/src/server/files/preview-renderers.ts"),
      text("server/src/server/files/raster-worker.ts"),
    ]);
  const nestedRoot = "/tmp/file-hosting-standalone/app";
  const arguments_ = linuxSandboxArguments(
    nestedRoot,
    nestedRoot,
    process.execPath,
  );
  const temporaryBind = arguments_.findIndex(
    (value, index) =>
      value === "--bind" &&
      arguments_[index + 1] === "/tmp" &&
      arguments_[index + 2] === "/tmp",
  );
  const rootBind = arguments_.findIndex(
    (value, index) =>
      value === "--ro-bind" &&
      arguments_[index + 1] === nestedRoot &&
      arguments_[index + 2] === nestedRoot,
  );
  assert.ok(temporaryBind >= 0 && rootBind > temporaryBind);
  assert.match(previewRenderers, /workerTemporaryRoot\(\)/u);
  assert.match(previewRenderers, /TMPDIR: "\/tmp"/u);
  assert.match(rasterWorker, /TMPDIR: "\/tmp"/u);
});

test("text rasterization expands for measured ink overhang without moving global glyphs", async () => {
  const worker = await text("server/runtime/og-render-worker.mjs");
  for (const contract of [
    /canonicalizeTextColor/u,
    /const premultiplied = Math\.round/u,
    /inkLeft/u,
    /inkRight/u,
    /extraLeft/u,
    /extraRight/u,
    /const drawX = baseDrawX \+ extraLeft/u,
    /const imageX = baseImageX - extraLeft/u,
  ]) {
    assert.match(worker, contract);
  }
});

test("PDF raster worker canonicalizes transparent edge colors before white compositing", async () => {
  const worker = await text("server/runtime/pdf-page-worker.mjs");
  assert.match(worker, /context\.getImageData/u);
  assert.match(worker, /const premultiplied = Math\.round/u);
  assert.match(worker, /premultiplied \+ 255 - alpha/u);
  assert.match(worker, /image\.data\[offset \+ 3\] = 255/u);
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

test("facts-bearing image inputs are immutable tracked bytes rather than platform encodes", async () => {
  const fixtures = [
    [
      "server/test-fixtures/og-design-inputs-v2/source-01-image-landscape.jpg",
      24_325,
      "ab6ba96e46a1367fc36757df43ca5e447eba651e2d4d9c186921de5c14efd02d",
    ],
    [
      "server/test-fixtures/og-design-inputs-v2/source-01-image-landscape-mutation.jpg",
      23_434,
      "28983842de8c3945c2cbe0ceeb1713aea36775ea42b031bd23a3d8b85793c6ca",
    ],
    [
      "server/test-fixtures/og-design-inputs-v2/source-02-image-portrait.png",
      51_357,
      "404b086471792815896989ea70fe422f2bab76714af5b5bbcd65c311548cd90b",
    ],
    [
      "server/test-fixtures/og-design-inputs-v2/source-02-image-portrait-mutation.png",
      51_328,
      "1300e303fb18c6625690f96ac1c117599dcc607a0a9e48b1e008468a1d7e5955",
    ],
    [
      "server/test-fixtures/og-design-inputs-v2/source-05-pdf.pdf",
      1_375,
      "af6c56f0e3062d7600ac715008ae04b27d0bd0fae7d4f0cc7a66b56cfc2eae7e",
    ],
    [
      "server/test-fixtures/og-design-inputs-v2/source-05-pdf-mutation.pdf",
      1_375,
      "0f2e4694d4b22828d2c63b72757e27b8e4b72308dbb7a0c3c44939faf7b6df0c",
    ],
  ];
  for (const [relative, size, digest] of fixtures) {
    const bytes = await readFile(path.join(root, relative));
    assert.equal(bytes.length, size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  }
  const audit = await text("server/scripts/design-audit.ts");
  assert.match(audit, /source-01-image-landscape\.jpg/u);
  assert.match(audit, /source-01-image-landscape-mutation\.jpg/u);
  assert.match(audit, /source-02-image-portrait\.png/u);
  assert.match(audit, /source-02-image-portrait-mutation\.png/u);
  assert.doesNotMatch(
    audit,
    /const (?:landscape|portrait) = await independentRaster\(|sharp\(landscape\)\.jpeg|PDFDocument|pdfFixture/u,
    "the source byte size rendered in approved facts must not depend on host libvips",
  );
});

test("RSS gate streams its disk fixture without charging setup allocation to the runtime envelope", async () => {
  const rssGate = await text("server/src/server/files/og-rss.test.ts");
  assert.match(rssGate, /const RSS_FILL_CHUNK_BYTES = 64 \* 1024;/u);
  assert.match(rssGate, /await handle\.writeFile\(chunk/u);
  assert.match(rssGate, /sourceHash\.update\(chunk/u);
  assert.doesNotMatch(
    rssGate,
    /Buffer\.concat\(\[\s*generated\.stdout/u,
    "the transitive RSS measurement must not retain a full-size setup buffer in its parent",
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
  const diagnosticsGuard = audit.match(
    /if \(result\.reasons\.length > 0\) \{([\s\S]*?)\n    \}\n    assert\.deepEqual\(\n      result\.reasons,\n      \[\],/u,
  )?.[1];
  assert.ok(
    diagnosticsGuard,
    "failure diagnostics must remain reason-guarded before the unchanged rejection assertion",
  );
  assert.match(diagnosticsGuard, /`diagnostic-\$\{item\.id\}\.png`/u);
  assert.match(diagnosticsGuard, /`diagnostic-\$\{item\.id\}\.json`/u);
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
  const [config, attribution, standalone, renderWorker, rgbPng] =
    await Promise.all([
      text("server/next.config.js"),
      text("server/runtime/assets/twemoji/ATTRIBUTION.md"),
      text("server/scripts/standalone-og-e2e.mjs"),
      text("server/runtime/og-render-worker.mjs"),
      text("server/runtime/rgb-png.js"),
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
  assert.equal(
    Number(primaryTimeout[1]),
    2,
    "Linux sharp work must retain the proven cold-start budget below the outer 2.5 second wall",
  );
  assert.match(
    rgbPng,
    /deflateSync\(scanlines, \{ level: 1 \}\)/u,
    "bounded Linux scanlines must use fast deterministic compression",
  );
  assert.match(
    renderWorker,
    /if \(process\.platform === "linux"\)[\s\S]*\.raw\(\)[\s\S]*encodeRgbPng\(rgb, width, height\)[\s\S]*writeSync\(1, png\)/u,
    "Linux must use one bounded sharp stage and the RGB-only PNG encoder",
  );
  assert.doesNotMatch(
    renderWorker.match(
      /if \(process\.platform === "linux"\)([\s\S]*?)\n\s*\} else \{/u,
    )?.[1] ?? "",
    /validateOpaquePng/u,
    "Linux must not claim a tautological postcondition check",
  );
  assert.match(
    renderWorker,
    /else \{[\s\S]*validateOpaquePng\(encoded, width, height\)[\s\S]*writeSync\(1, encoded\)/u,
    "already-approved non-Linux opaque bytes must be independently validated",
  );
});

test("RGB PNG encoder is executable, lossless, opaque, and corruption-detecting", async () => {
  const moduleUrl = pathToFileURL(
    path.join(root, "server/runtime/rgb-png.js"),
  ).href;
  const { encodeRgbPng, validateOpaquePng } = await import(moduleUrl);
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0]);
  const png = encodeRgbPng(pixels, 2, 1);
  assert.equal(validateOpaquePng(png, 2, 1), true);

  const idat = [];
  let offset = 8;
  let firstIdatDataOffset = -1;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      firstIdatDataOffset = offset + 8;
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const filtered = inflateSync(Buffer.concat(idat));
  assert.equal(filtered[0], 1);
  const decoded = Buffer.alloc(pixels.length);
  for (let index = 0; index < decoded.length; index += 1) {
    decoded[index] =
      (filtered[index + 1] + (index >= 3 ? decoded[index - 3] : 0)) & 0xff;
  }
  assert.deepEqual(decoded, pixels);

  const representative = Buffer.alloc(1200 * 630 * 3);
  for (let y = 0; y < 630; y += 1) {
    for (let x = 0; x < 1200; x += 1) {
      const offset = (y * 1200 + x) * 3;
      representative[offset] = (x + Math.floor(y / 8)) & 0xff;
      representative[offset + 1] = (Math.floor(x / 3) + y) & 0xff;
      representative[offset + 2] =
        (Math.floor(x / 8) + Math.floor(y / 3)) & 0xff;
    }
  }
  assert.ok(
    encodeRgbPng(representative, 1200, 630).length < 500_000,
    "bounded Sub filtering must keep image-backed OG cards cacheable",
  );

  const corrupted = Buffer.from(png);
  corrupted[firstIdatDataOffset] ^= 1;
  assert.equal(validateOpaquePng(corrupted, 2, 1), false);
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
