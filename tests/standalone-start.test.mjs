import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const standaloneStart = path.join(
  rootDir,
  "server",
  ".next",
  "standalone",
  "start.js",
);

test("standalone rejects an invalid public URL before the service starts", async () => {
  const publicUrl =
    "https://startup-user:startup-password@example.test/path?startup-secret=value";
  const child = spawn(process.execPath, [standaloneStart], {
    cwd: path.dirname(standaloneStart),
    env: {
      ...process.env,
      FS_PUBLIC_URL: publicUrl,
      FS_TOKEN: "standalone-startup-probe-token",
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      PORT: "39881",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const [code, signal] = await once(child, "exit");
  const output = Buffer.concat([...stdout, ...stderr]).toString("utf8");

  assert.notEqual(code, 0);
  assert.equal(signal, null);
  assert.match(
    output,
    /FS_PUBLIC_URL must be a canonical HTTP or HTTPS origin/u,
  );
  assert.doesNotMatch(output, /startup-password|startup-secret|startup-user/u);
  assert.doesNotMatch(output, /Ready in|Local:/u);
});
