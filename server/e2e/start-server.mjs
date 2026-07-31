// Dev/E2E-only launcher. Runs the real standalone production build against a
// throwaway SQLite database and object store. Never used in production; the
// fixture token is a test-only value, not a real credential.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(serverDir, ".e2e-runtime");
const standalone = path.join(serverDir, ".next", "standalone");

export const E2E_PORT = Number(process.env.FS_E2E_PORT ?? 4610);
export const E2E_TOKEN = process.env.FS_E2E_TOKEN ?? "e2e-dashboard-fixture-token";
const BASE = `http://127.0.0.1:${E2E_PORT}`;

function assembleStandalone() {
  if (!existsSync(standalone)) {
    throw new Error("Run `npm run build` before the E2E suite");
  }
  cpSync(path.join(serverDir, "public"), path.join(standalone, "public"), {
    recursive: true,
  });
  cpSync(
    path.join(serverDir, ".next", "static"),
    path.join(standalone, ".next", "static"),
    { recursive: true },
  );
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return;
    } catch {
      // Server not accepting connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Server did not become healthy in time");
}

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(path.join(runtimeDir, "objects"), { recursive: true });
assembleStandalone();

const child = spawn("node", [path.join(standalone, "server.js")], {
  cwd: standalone,
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(E2E_PORT),
    HOSTNAME: "127.0.0.1",
    FS_TOKEN: E2E_TOKEN,
    DATABASE_URL: `file:${path.join(runtimeDir, "files.db")}`,
    FS_STORAGE_DIR: path.join(runtimeDir, "objects"),
    FS_PUBLIC_URL: BASE,
    FS_MAX_UPLOAD_BYTES: String(2 * 1024 * 1024 * 1024),
    FS_MIN_FREE_BYTES: String(1024 * 1024 * 1024),
  },
  stdio: "inherit",
});

// Seeding happens in the specs' beforeAll (e2e/seed.mjs) so that the health
// check passing cannot race a partially-seeded database.
await waitForHealth();
console.log(`[e2e] server ready on ${BASE}`);

const stop = () => {
  child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
