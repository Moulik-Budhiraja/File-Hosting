import { defineConfig } from "@playwright/test";

// Production browser tests run against the real standalone build
// (`npm run build` first). Ports/paths are portable: override with
// E2E_PORT if 3947 is taken.
const PORT = Number(process.env.E2E_PORT ?? 3947);

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
    env: { E2E_PORT: String(PORT) },
  },
});
