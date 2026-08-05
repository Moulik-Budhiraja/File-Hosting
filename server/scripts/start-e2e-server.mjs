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

const child = spawn(
  process.execPath,
  [path.join(serverRoot, ".next", "standalone", "start.js")],
  {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: port,
      FS_TOKEN: "e2e-synthetic-service-token",
      FS_PUBLIC_URL: process.env.E2E_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
      DATABASE_URL: `file:${path.join(dataDir, "files.db")}`,
      FS_STORAGE_DIR: path.join(dataDir, "objects"),
      FS_BOOTSTRAP_USERNAME: E2E_ADMIN.username,
      FS_BOOTSTRAP_PASSWORD: E2E_ADMIN.password,
    },
  },
);

child.stdout?.on("data", (chunk) => {
  process.stdout.write(chunk);
  serverLog.write(chunk);
});
child.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
  serverLog.write(chunk);
});
child.on("exit", (code) => {
  serverLog.end(() => process.exit(code ?? 1));
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
