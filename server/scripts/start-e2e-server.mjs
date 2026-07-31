// Boots the real production standalone server on a fresh throwaway data
// directory for the Playwright suite. Synthetic credentials only.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const dataDir = mkdtempSync(path.join(os.tmpdir(), "fs-e2e-"));
const port = process.env.E2E_PORT ?? "3947";

export const E2E_ADMIN = { username: "e2e-admin", password: "e2e-admin-password-longer-than-12" };

const child = spawn(
  process.execPath,
  [path.join(serverRoot, ".next", "standalone", "server.js")],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: port,
      FS_TOKEN: "e2e-synthetic-service-token",
      FS_PUBLIC_URL: `http://127.0.0.1:${port}`,
      DATABASE_URL: `file:${path.join(dataDir, "files.db")}`,
      FS_STORAGE_DIR: path.join(dataDir, "objects"),
      FS_BOOTSTRAP_USERNAME: E2E_ADMIN.username,
      FS_BOOTSTRAP_PASSWORD: E2E_ADMIN.password,
    },
  },
);

child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
