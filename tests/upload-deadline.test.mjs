import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry =
  process.env.STANDALONE_ENTRY ??
  fileURLToPath(
    new URL("../server/.next/standalone/start.js", import.meta.url),
  );
const observer = fileURLToPath(
  new URL("./http-server-observer.mjs", import.meta.url),
);

async function start(t, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fs-deadline-"));
  const token = randomBytes(24).toString("hex");
  const port = 39883;
  const child = spawn(process.execPath, ["--import", observer, entry], {
    cwd: path.dirname(entry),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      FS_PUBLIC_URL: `http://127.0.0.1:${port}`,
      FS_TOKEN: token,
      DATABASE_URL: `file:${directory}/files.db`,
      FS_STORAGE_DIR: `${directory}/files`,
      FS_MIN_FREE_BYTES: "0",
      FS_BOOTSTRAP_USERNAME: "",
      FS_BOOTSTRAP_PASSWORD: "",
      KEEP_ALIVE_TIMEOUT: "",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  const snapshot = await Promise.race([
    once(child, "message").then(([message]) => message),
    exited.then(() => {
      throw new Error(`Startup failed: ${output}`);
    }),
    delay(20000, null, { ref: false }).then(() => {
      throw new Error(`Startup timed out: ${output}`);
    }),
  ]);
  const url = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${url}/healthz`)).status, 200, output);
  return { child, exited, snapshot, url, token };
}

test(
  "packaged production entrypoint removes only the request receipt deadline",
  { timeout: 30000 },
  async (t) => {
    const { snapshot } = await start(t);
    const defaults = createServer();
    const expected = Object.fromEntries(
      Object.keys(snapshot.timeouts).map((key) => [key, defaults[key]]),
    );
    expected.requestTimeout = 0;
    assert.deepEqual(snapshot.timeouts, expected);
    assert.equal(snapshot.address.address, "127.0.0.1");
    assert.equal(snapshot.address.port, 39883);
    console.log(JSON.stringify(snapshot));
  },
);

test(
  "paced upload completes beyond a shortened request deadline",
  { timeout: 30000 },
  async (t) => {
    const { url, token } = await start(t, { FS_TEST_SHORT_DEADLINE: "1" });
    const bytes = randomBytes(16384);
    const result = await new Promise((resolve, reject) => {
      const req = request(
        `${url}/api/files?name=paced.bin&visibility=private`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": bytes.length,
          },
        },
        async (res) => {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString(),
          });
        },
      );
      req.on("error", reject);
      void (async () => {
        for (
          let offset = 0;
          offset < bytes.length && !req.destroyed;
          offset += 1024
        ) {
          req.write(bytes.subarray(offset, offset + 1024));
          await delay(200);
        }
        req.end();
      })();
    });
    assert.equal(result.status, 201, result.text);
    const metadata = JSON.parse(result.text);
    assert.equal(metadata.visibility, "private");
    assert.match(metadata.id, /^[A-Za-z0-9]{7}$/);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${url}/raw/${metadata.id}`)).status, 404);
    const downloaded = Buffer.from(
      await (
        await fetch(`${url}/raw/${metadata.id}`, { headers })
      ).arrayBuffer(),
    );
    assert.deepEqual(downloaded, bytes);
    assert.equal(
      metadata.sha256,
      createHash("sha256").update(downloaded).digest("hex"),
    );
    assert.ok(
      (
        await fetch(`${url}/api/files/${metadata.id}`, {
          method: "DELETE",
          headers,
        })
      ).ok,
    );
    assert.equal(
      (await fetch(`${url}/api/files/${metadata.id}`, { headers })).status,
      404,
    );
  },
);

test(
  "packaged handler serves assets and drains an authenticated upload on SIGTERM",
  { timeout: 30000 },
  async (t) => {
    const { child, exited, snapshot, url, token } = await start(t, {
      KEEP_ALIVE_TIMEOUT: "9000",
    });
    assert.equal(snapshot.timeouts.keepAliveTimeout, 9000);
    const login = await fetch(`${url}/login`);
    assert.equal(login.status, 200);
    assert.equal(login.headers.get("x-content-type-options"), "nosniff");
    const html = await login.text();
    const assets = [
      ...html.matchAll(/(?:src|href)="([^" ]*\/_next\/static\/[^" ]+)"/g),
    ].map((match) => match[1]);
    assert.ok(assets.length > 0);
    for (const asset of new Set(assets))
      assert.equal(
        (await fetch(new URL(asset.replaceAll("&amp;", "&"), url))).status,
        200,
      );
    assert.equal((await fetch(`${url}/api/files`)).status, 401);
    const bytes = randomBytes(8192);
    const response = new Promise((resolve, reject) => {
      const req = request(
        `${url}/api/files?name=deadline-drain.bin&visibility=private`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": bytes.length,
          },
        },
        async (res) => {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          });
        },
      );
      req.on("error", reject);
      req.write(bytes.subarray(0, 4096));
      setTimeout(() => child.kill("SIGTERM"), 500);
      setTimeout(() => req.end(bytes.subarray(4096)), 1500);
    });
    const result = await response;
    assert.equal(result.status, 201);
    assert.equal(result.body.visibility, "private");
    assert.equal(
      result.body.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(await exited, [0, null]);
  },
);
