import { defineConfig } from "@playwright/test";

const port = Number(process.env.FS_E2E_PORT ?? 4610);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    colorScheme: "dark",
  },
  webServer: {
    command: "node e2e/start-server.mjs",
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    timeout: 120_000,
  },
});
