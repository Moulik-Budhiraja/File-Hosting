import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("compose forwards bootstrap credentials into the server container", async () => {
  const compose = await readFile(path.join(rootDir, "compose.yaml"), "utf8");

  assert.match(
    compose,
    /^\s+FS_BOOTSTRAP_USERNAME: \$\{FS_BOOTSTRAP_USERNAME:-\}$/mu,
  );
  assert.match(
    compose,
    /^\s+FS_BOOTSTRAP_PASSWORD: \$\{FS_BOOTSTRAP_PASSWORD:-\}$/mu,
  );
});

test("runtime workers are tracked and packaged by standalone and Docker", async () => {
  const runtimeAssets = [
    "runtime/og-render-worker.mjs",
    "runtime/pdf-page-worker.mjs",
    "runtime/docx-text-worker.mjs",
    "runtime/fonts/fonts.conf",
    "runtime/fonts/Inter.ttf",
    "runtime/fonts/Inter-OFL.txt",
    "runtime/fonts/JetBrainsMono.ttf",
    "runtime/fonts/JetBrainsMono-OFL.txt",
    "runtime/fonts/NotoColorEmoji.ttf",
    "runtime/fonts/NotoEmoji-OFL.txt",
    "runtime/assets/twemoji/1f4e1.svg",
    "runtime/assets/twemoji/1f600.svg",
    "runtime/assets/twemoji/1f680.svg",
    "runtime/assets/twemoji/ATTRIBUTION.md",
    "runtime/assets/twemoji/LICENSE-GRAPHICS",
    "runtime/assets/unavailable.png",
  ];
  for (const asset of runtimeAssets) {
    await access(path.join(rootDir, "server", asset));
  }

  const tracked = new Set(
    execFileSync("git", ["ls-files", "--", "server/runtime"], {
      cwd: rootDir,
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
  );
  for (const asset of runtimeAssets) {
    assert.equal(tracked.has(`server/${asset}`), true, `${asset} is untracked`);
  }

  const nextConfig = await readFile(
    path.join(rootDir, "server", "next.config.js"),
    "utf8",
  );
  assert.match(nextConfig, /"\.\/runtime\/\*\*\/\*"/u);

  const dockerfile = await readFile(
    path.join(rootDir, "server", "Dockerfile"),
    "utf8",
  );
  assert.match(dockerfile, /RUN npm run assert:runtime/u);
  assert.match(dockerfile, /CMD \["npm", "run", "start:verified"\]/u);
});

test("production image installs the fonts used by generated cards", async () => {
  const dockerfile = await readFile(
    path.join(rootDir, "server", "Dockerfile"),
    "utf8",
  );

  assert.match(dockerfile, /apk add --no-cache[^\n]*bubblewrap/u);
  assert.match(dockerfile, /apk add --no-cache[^\n]*font-noto/u);
  assert.match(dockerfile, /apk add --no-cache[^\n]*font-noto-cjk/u);
});
