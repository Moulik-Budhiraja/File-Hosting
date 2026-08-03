import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ffmpegPath from "ffmpeg-static";
import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";
import { ZipFile } from "yazl";

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const requestedRoot = process.env.OG_E2E_DIR;
const e2eRoot = requestedRoot
  ? path.resolve(requestedRoot)
  : await mkdtemp(path.join(os.tmpdir(), "file-hosting-standalone-"));
const mode = process.env.OG_E2E_MODE === "compiled" ? "compiled" : "standalone";
const appRoot = path.join(e2eRoot, "app");
const dataRoot = path.join(e2eRoot, "data");

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function docx(text) {
  const archive = new ZipFile();
  archive.addBuffer(
    Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
    "word/document.xml",
  );
  archive.end();
  const chunks = [];
  for await (const chunk of archive.outputStream)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function pdf() {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 315]);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: 600,
    height: 315,
    color: rgb(0.85, 0.2, 0.1),
  });
  page.drawText("STANDALONE PDF BYTES", { x: 40, y: 150, size: 28 });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function video() {
  assert.ok(ffmpegPath);
  const output = path.join(e2eRoot, "fixture.mp4");
  const result = spawnSync(
    ffmpegPath,
    [
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=96x54:d=0.3",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      output,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return await import("node:fs/promises").then(({ readFile }) =>
    readFile(output),
  );
}

if (mode === "standalone") {
  await rm(appRoot, { recursive: true, force: true });
  await mkdir(appRoot, { recursive: true });
  await cp(path.join(serverRoot, ".next", "standalone"), appRoot, {
    recursive: true,
  });
  await mkdir(path.join(appRoot, ".next"), { recursive: true });
  await cp(
    path.join(serverRoot, ".next", "static"),
    path.join(appRoot, ".next", "static"),
    { recursive: true },
  );
}
await rm(dataRoot, { recursive: true, force: true });
await mkdir(dataRoot, { recursive: true });

const launchRoot = mode === "standalone" ? appRoot : serverRoot;
const launchEntry =
  mode === "standalone"
    ? "server.js"
    : path.join(".next", "standalone", "server.js");
const port = await availablePort();
const token = "synthetic-standalone-token-with-enough-entropy";
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [launchEntry], {
  cwd: launchRoot,
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    FS_TOKEN: token,
    FS_PUBLIC_URL: origin,
    FS_STORAGE_DIR: path.join(dataRoot, "objects"),
    FS_MIN_FREE_BYTES: "0",
    DATABASE_URL: `file:${path.join(dataRoot, "files.db")}`,
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk) => {
  logs += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  logs += chunk.toString();
});

async function waitUntilReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`standalone did not become ready\n${logs}`);
}

async function upload(name, mime, bytes) {
  const response = await fetch(
    `${origin}/api/files?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": mime,
        "content-length": String(bytes.length),
      },
      body: bytes,
    },
  );
  const responseBody = await response.text();
  assert.equal(response.status, 201, responseBody);
  return JSON.parse(responseBody);
}

async function cardFor(name, mime, bytes) {
  const metadata = await upload(name, mime, bytes);
  assert.match(metadata.id, /^[0-9A-Za-z]{7,16}$/u);
  const pageResponse = await fetch(`${origin}/${metadata.id}`);
  assert.equal(pageResponse.status, 200);
  const cardResponse = await fetch(`${origin}/og/${metadata.id}.png`);
  assert.equal(cardResponse.status, 200, logs);
  assert.equal(cardResponse.headers.get("content-type"), "image/png");
  const card = Buffer.from(await cardResponse.arrayBuffer());
  const image = await sharp(card).metadata();
  assert.deepEqual(
    {
      width: image.width,
      height: image.height,
      format: image.format,
      hasAlpha: image.hasAlpha,
    },
    {
      width: 1200,
      height: 630,
      format: "png",
      hasAlpha: false,
    },
  );
  return card;
}

try {
  await waitUntilReady();
  const alpha = await cardFor(
    "notes.md",
    "text/markdown",
    Buffer.from("# Same heading\nAlpha body"),
  );
  const beta = await cardFor(
    "notes.md",
    "text/markdown",
    Buffer.from("# Same heading\nBravo body"),
  );
  assert.notDeepEqual(alpha, beta);
  await cardFor(
    "pixels.png",
    "image/png",
    await sharp({
      create: { width: 80, height: 60, channels: 3, background: "#d04020" },
    })
      .png()
      .toBuffer(),
  );
  await cardFor("report.pdf", "application/pdf", await pdf());
  await cardFor(
    "report.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    await docx("Standalone document bytes"),
  );
  await cardFor("clip.mp4", "video/mp4", await video());
  await writeFile(
    path.join(e2eRoot, "result.json"),
    JSON.stringify({ ok: true, mode, origin, cases: 6 }, null, 2),
  );
  process.stdout.write(`${mode} OG E2E passed: 6 cases at ${e2eRoot}\n`);
} finally {
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
  if (!requestedRoot) await rm(e2eRoot, { recursive: true, force: true });
}
