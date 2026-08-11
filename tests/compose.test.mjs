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

test("compose packages a bounded durable derivative worker with shared storage", async () => {
  const [compose, packageJson, dockerfile, readme] = await Promise.all([
    readFile(path.join(rootDir, "compose.yaml"), "utf8"),
    readFile(path.join(rootDir, "server", "package.json"), "utf8"),
    readFile(path.join(rootDir, "server", "Dockerfile"), "utf8"),
    readFile(path.join(rootDir, "README.md"), "utf8"),
  ]);
  assert.match(compose, /^\s{2}image-derivative-worker:/mu);
  assert.match(compose, /command: \["node", "image-derivative-worker\.cjs"\]/u);
  assert.match(
    compose,
    /image-derivative-worker:[\s\S]*stop_grace_period: 90s/u,
  );
  assert.match(compose, /healthcheck:[\s\S]*--healthcheck/u);
  assert.match(compose, /mem_limit:\s*768m/u);
  assert.match(compose, /condition:\s*service_started/u);
  const workerBlock =
    /\n  image-derivative-worker:([\s\S]*?)(?=\n\S|\nnetworks:)/u.exec(
      compose,
    )?.[1];
  assert.ok(workerBlock, "worker service must be present");
  assert.match(
    workerBlock,
    /cap_drop:\s*\n\s*- ALL[\s\S]*cap_add:\s*\n\s*- SETGID\s*\n\s*- SETUID\s*\n\s*- NET_ADMIN\s*\n\s*- SYS_CHROOT\s*\n\s*- SYS_PTRACE\s*\n\s*- SYS_ADMIN/u,
    "the worker's native render children require Bubblewrap's bounded capability set",
  );
  assert.match(
    workerBlock,
    /security_opt:\s*\n\s*- apparmor=unconfined\s*\n\s*- seccomp=unconfined/u,
    "the worker's outer profiles must allow Bubblewrap namespace setup",
  );
  assert.doesNotMatch(workerBlock, /no-new-privileges/u);
  assert.match(readme, /docker compose stop[^\n]*90 seconds/u);
  assert.doesNotMatch(readme, /docker compose stop[^\n]*30 seconds/u);
  assert.match(
    compose,
    /image-derivative-worker:[\s\S]*FS_STORAGE_DIR:[\s\S]*DATABASE_URL:/u,
  );
  const parsedPackage = JSON.parse(packageJson);
  assert.equal(
    parsedPackage.scripts["worker:image-derivatives"],
    "node .next/standalone/image-derivative-worker.cjs",
  );
  assert.match(
    parsedPackage.scripts["build:worker"],
    /image-derivative-worker\.cjs/u,
  );
  assert.match(dockerfile, /\/app\/\.next\/standalone \.\//u);
  assert.doesNotMatch(
    dockerfile,
    /--chown=nextjs:nodejs \/app\/node_modules \.\/node_modules/u,
  );
  assert.doesNotMatch(dockerfile, /\/app\/src \.\/src/u);
});

test("runtime workers are tracked and packaged by standalone and Docker", async () => {
  const runtimeAssets = [
    "runtime/og-render-worker.mjs",
    "runtime/font-probe-worker.mjs",
    "runtime/pdf-page-worker.mjs",
    "runtime/docx-text-worker.mjs",
    "runtime/media-command-worker.mjs",
    "runtime/media-preflight.mp4",
    "runtime/fonts/fonts.conf",
    "runtime/fonts/Inter.ttf",
    "runtime/fonts/Inter-OFL.txt",
    "runtime/fonts/JetBrainsMono.ttf",
    "runtime/fonts/JetBrainsMono-OFL.txt",
    "runtime/fonts/NotoColorEmoji.ttf",
    "runtime/fonts/NotoEmoji-OFL.txt",
    "runtime/fonts/NotoSansArabic.ttf",
    "runtime/fonts/NotoSansCJKjp-Regular.otf",
    "runtime/fonts/Noto-OFL.txt",
    "runtime/assets/twemoji/ATTRIBUTION.md",
    "runtime/assets/twemoji/LICENSE-GRAPHICS",
    "runtime/assets/unavailable.png",
  ];
  for (const asset of runtimeAssets) {
    await access(path.join(rootDir, "server", asset));
  }

  let tracked;
  try {
    await access(path.join(rootDir, ".git"));
    tracked = new Set(
      execFileSync("git", ["ls-files", "--", "server/runtime"], {
        cwd: rootDir,
        encoding: "utf8",
      })
        .trim()
        .split("\n"),
    );
  } catch {
    tracked = new Set(runtimeAssets.map((asset) => `server/${asset}`));
  }
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
  assert.match(dockerfile, /CMD \["node", "start\.js"\]/u);
});

test("production image installs the fonts used by generated cards", async () => {
  const dockerfile = await readFile(
    path.join(rootDir, "server", "Dockerfile"),
    "utf8",
  );

  assert.match(dockerfile, /apt-get install[\s\S]*bubblewrap/u);
  assert.match(dockerfile, /apt-get install[\s\S]*fonts-noto-core/u);
  assert.match(dockerfile, /apt-get install[\s\S]*fonts-noto-cjk/u);
});

test("server CI enables and verifies the production Linux sandbox before browser tests", async () => {
  const workflow = await readFile(
    path.join(rootDir, ".github", "workflows", "server.yml"),
    "utf8",
  );
  const sandbox = workflow.indexOf(
    "- name: Enable and verify the Linux process sandbox",
  );
  const browser = workflow.indexOf(
    "- name: Production browser tests (standalone server)",
  );
  assert.ok(sandbox >= 0 && sandbox < browser);
  assert.match(workflow, /apt-get install -y bubblewrap/u);
  assert.match(
    workflow,
    /sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/u,
  );
  assert.match(workflow, /node server\/runtime\/verify-linux-sandbox\.js/u);
});

test("compose builds and runs with the same public URL transport contract", async () => {
  const [compose, dockerfile] = await Promise.all([
    readFile(path.join(rootDir, "compose.yaml"), "utf8"),
    readFile(path.join(rootDir, "server", "Dockerfile"), "utf8"),
  ]);

  assert.match(
    compose,
    /^\s+args:\n\s+FS_PUBLIC_URL: \$\{FS_PUBLIC_URL:-https:\/\/files\.moulik\.dev\}$/mu,
  );
  assert.match(
    compose,
    /^\s+environment:[\s\S]*?^\s+FS_PUBLIC_URL: \$\{FS_PUBLIC_URL:-https:\/\/files\.moulik\.dev\}$/mu,
  );
  assert.match(dockerfile, /^ARG FS_PUBLIC_URL$/mu);
  assert.match(dockerfile, /^ENV FS_PUBLIC_URL=\$FS_PUBLIC_URL$/mu);
});

test("every production launcher uses the fail-closed standalone entrypoint", async () => {
  const [dockerfile, packageJson, e2eLauncher, captureLauncher] =
    await Promise.all([
      readFile(path.join(rootDir, "server", "Dockerfile"), "utf8"),
      readFile(path.join(rootDir, "server", "package.json"), "utf8"),
      readFile(
        path.join(rootDir, "server", "scripts", "start-e2e-server.mjs"),
        "utf8",
      ),
      readFile(
        path.join(rootDir, "server", "scripts", "capture-screens.mjs"),
        "utf8",
      ),
    ]);

  assert.match(dockerfile, /CMD \["node", "start\.js"\]/u);
  assert.equal(
    JSON.parse(packageJson).scripts.start,
    "node .next/standalone/start.js",
  );
  assert.match(e2eLauncher, /"standalone", "start\.js"/u);
  assert.match(captureLauncher, /"standalone", "start\.js"/u);
  assert.doesNotMatch(e2eLauncher, /"standalone", "server\.js"/u);
  assert.doesNotMatch(captureLauncher, /"standalone", "server\.js"/u);
});

test("container CI authenticates file smoke requests with the login session", async () => {
  const workflow = await readFile(
    path.join(rootDir, ".github", "workflows", "server.yml"),
    "utf8",
  );

  assert.match(
    workflow,
    /upload="\$\(curl --fail --silent --show-error --cookie \/tmp\/fs-cookies[\s\S]*?-H 'origin: http:\/\/127\.0\.0\.1:37641'[\s\S]*?--data-binary 'compose-smoke'/u,
  );
  assert.match(workflow, /body\.name!=="compose-smoke\.txt"/u);
  assert.doesNotMatch(workflow, /\.\.\./u);
});

test("container CI prepares cold-runner bind mounts for uid 1001 before Compose", async () => {
  const workflow = await readFile(
    path.join(rootDir, ".github", "workflows", "server.yml"),
    "utf8",
  );
  const prepare = workflow.indexOf(
    "install -d -m 700 -o 1001 -g 1001 runtime/files runtime/sqlite",
  );
  const build = workflow.indexOf("docker compose build --pull");
  const up = workflow.indexOf("docker compose up --detach --wait");

  assert.notEqual(
    prepare,
    -1,
    "runtime bind mounts must be prepared explicitly",
  );
  assert.ok(prepare < build, "runtime bind mounts must exist before build");
  assert.ok(prepare < up, "runtime bind mounts must exist before compose up");
});
