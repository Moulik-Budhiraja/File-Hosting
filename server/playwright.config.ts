import os from "node:os";
import path from "node:path";

import { defineConfig } from "@playwright/test";

// Production browser tests run against the real standalone build
// (`npm run build` first). Ports/paths are portable: override with
// E2E_PORT if 3947 is taken.
const PORT = Number(process.env.E2E_PORT ?? 3947);

// The server's throwaway data directory is pinned so specs can assert
// negative facts against the raw database (e.g. no plaintext credential
// was ever persisted).
const DATA_DIR =
  process.env.E2E_DATA_DIR ?? path.join(os.tmpdir(), `fs-e2e-data-${PORT}`);
const SERVER_LOG =
  process.env.E2E_SERVER_LOG ?? path.join(DATA_DIR, "standalone-server.log");
process.env.E2E_DATA_DIR = DATA_DIR;
process.env.E2E_SERVER_LOG = SERVER_LOG;

export default defineConfig({
  testDir: "./tests-e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command: "node scripts/start-e2e-server.mjs",
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      E2E_PORT: String(PORT),
      E2E_DATA_DIR: DATA_DIR,
      E2E_SERVER_LOG: SERVER_LOG,
    },
  },
});
