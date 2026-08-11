import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = path.join(root, "server");
const next = path.join(serverRoot, "node_modules", "next", "dist", "bin", "next");
const workerEntry = path.join(
  serverRoot,
  ".next",
  "standalone",
  "image-derivative-worker.cjs",
);
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "file-hosting-rich-link-release-"),
);
const evidenceRoot = path.resolve(
  process.env.OG_RELEASE_EVIDENCE_DIR ??
    path.join(temporaryRoot, "visual-contexts"),
);
await mkdir(evidenceRoot, { recursive: true });

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => listener.close(resolve));
  return address.port;
}

const port = await unusedPort();
const origin = `http://127.0.0.1:${port}`;
assert.notEqual(new URL(origin).hostname, "files.moulik.dev", "production guard");
const token = "release-probe-synthetic-token-with-enough-entropy";
const runtimeEnvironment = {
  ...process.env,
  DATABASE_URL: `file:${path.join(temporaryRoot, "files.db")}`,
  FS_STORAGE_DIR: path.join(temporaryRoot, "objects"),
  FS_PUBLIC_URL: origin,
  FS_TOKEN: token,
  FS_MIN_FREE_BYTES: "0",
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
};
const logs = [];

function launch(command, args) {
  const child = spawn(command, args, {
    cwd: serverRoot,
    detached: process.platform !== "win32",
    env: runtimeEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => logs.push(Buffer.from(chunk)));
  return child;
}

const server = launch(process.execPath, [
  next,
  "start",
  "-H",
  "127.0.0.1",
  "-p",
  String(port),
]);
const worker = launch(process.execPath, [workerEntry]);
const children = [server, worker];
let probe;

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const outcome = await Promise.race([
    exited.then(() => "exit"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
  ]);
  if (outcome === "timeout") {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await exited;
  }
}

async function stop() {
  await Promise.all(children.map(stopChild));
}

function assertRunning() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(Buffer.concat(logs).toString("utf8"));
  }
}

async function workerHealthy() {
  const health = spawn(process.execPath, [workerEntry, "--healthcheck"], {
    cwd: serverRoot,
    env: runtimeEnvironment,
    stdio: "ignore",
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  const [code, signal] = await once(health, "exit");
  return code === 0 && signal === null;
}

try {
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline) {
    assertRunning();
    try {
      const response = await fetch(`${origin}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok && (await workerHealthy())) {
        ready = true;
        break;
      }
    } catch {
      // Production server and worker are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, Buffer.concat(logs).toString("utf8"));
  probe = spawn(
    process.execPath,
    [path.join(serverRoot, "scripts", "rich-link-preview-probe.mjs")],
    {
      cwd: serverRoot,
      env: {
        ...process.env,
        FS_PROBE_URL: origin,
        FS_PROBE_TOKEN: token,
        FS_PROBE_SCREENSHOTS: evidenceRoot,
      },
      detached: process.platform !== "win32",
      stdio: "inherit",
    },
  );
  const probeExit = once(probe, "exit");
  let probeTimer;
  const probeOutcome = await Promise.race([
    probeExit.then(([code, signal]) => ({ code, signal })),
    new Promise((resolve) => {
      probeTimer = setTimeout(() => resolve({ timeout: true }), 180_000);
    }),
  ]).finally(() => clearTimeout(probeTimer));
  if ("timeout" in probeOutcome) {
    await stopChild(probe);
    throw new Error("rich-link preview probe timed out");
  }
  assertRunning();
  assert.equal(probeOutcome.signal, null);
  assert.equal(probeOutcome.code, 0);
  process.stdout.write(
    `rich-link release probe visual contexts: ${evidenceRoot}\n`,
  );
} finally {
  if (probe) await stopChild(probe);
  await stop();
  if (!process.env.OG_RELEASE_EVIDENCE_DIR)
    await rm(temporaryRoot, { recursive: true, force: true });
}
