// Boots the real production standalone server on a fresh throwaway data
// directory for the Playwright suite. Synthetic credentials only.
import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
// A pinned E2E_DATA_DIR (from playwright.config.ts) lets specs inspect
// the raw database; it is recreated fresh on every run either way.
const pinnedDataDir = process.env.E2E_DATA_DIR;
if (pinnedDataDir) {
  rmSync(pinnedDataDir, { recursive: true, force: true });
  mkdirSync(pinnedDataDir, { recursive: true });
}
const dataDir = pinnedDataDir ?? mkdtempSync(path.join(os.tmpdir(), "fs-e2e-"));
const logPath =
  process.env.E2E_SERVER_LOG ?? path.join(dataDir, "standalone-server.log");
const serverLog = createWriteStream(logPath, { flags: "w" });
const port = process.env.E2E_PORT ?? "3947";

export const E2E_ADMIN = {
  username: "e2e-admin",
  password: "e2e-admin-password-longer-than-12",
};

const runtimeEnv = {
  ...process.env,
  NODE_ENV: "production",
  HOSTNAME: "127.0.0.1",
  PORT: port,
  FS_TOKEN: "e2e-synthetic-service-token",
  FS_PUBLIC_URL: process.env.E2E_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  DATABASE_URL: `file:${path.join(dataDir, "files.db")}`,
  FS_STORAGE_DIR: path.join(dataDir, "objects"),
  FS_MIN_FREE_BYTES: "1024",
  FS_BOOTSTRAP_USERNAME: E2E_ADMIN.username,
  FS_BOOTSTRAP_PASSWORD: E2E_ADMIN.password,
};
const child = spawn(
  process.execPath,
  [path.join(serverRoot, ".next", "standalone", "start.js")],
  {
    stdio: ["inherit", "pipe", "pipe"],
    env: runtimeEnv,
  },
);
const workerEnv = { ...runtimeEnv };
delete workerEnv.FS_BOOTSTRAP_USERNAME;
delete workerEnv.FS_BOOTSTRAP_PASSWORD;
const worker = spawn(
  process.execPath,
  [path.join(serverRoot, ".next", "standalone", "image-derivative-worker.cjs")],
  { stdio: ["ignore", "pipe", "pipe"], env: workerEnv },
);
let stopping = false;

child.stdout?.on("data", (chunk) => {
  process.stdout.write(chunk);
  serverLog.write(chunk);
});
child.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
  serverLog.write(chunk);
});
worker.stdout?.on("data", (chunk) => {
  process.stdout.write(chunk);
  serverLog.write(chunk);
});
worker.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
  serverLog.write(chunk);
});
child.on("exit", (code) => {
  worker.kill("SIGTERM");
  serverLog.end(() => process.exit(stopping ? 0 : (code ?? 1)));
});
worker.on("exit", (code) => {
  if (code && child.exitCode === null) child.kill("SIGTERM");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    worker.kill(signal);
    child.kill(signal);
  });
}
