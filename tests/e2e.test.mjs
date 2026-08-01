import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gzipSync } from "node:zlib";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testsDir, "..");
const serverDir = path.join(rootDir, "server");
const cliEntry = path.join(rootDir, "cli", "dist", "index.js");
const nextEntry = path.join(serverDir, "node_modules", "next", "dist", "bin", "next");

const token = "e2e-shared-secret";
const bootstrapUsername = "e2e.admin";
const bootstrapPassword = "e2e admin password from fixture";
const oneGiB = 1024 ** 3;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function singleFileTar(pathname, contents) {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  const text = (value, offset, length) => header.write(value, offset, length, "ascii");
  const octal = (value, offset, length) => text(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  text(pathname, 0, 100);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(body.length, 124, 12);
  octal(Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  text("0", 156, 1);
  text("ustar\0", 257, 6);
  text("00", 263, 2);
  text("e2e", 265, 3);
  text("e2e", 297, 3);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  text(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function unusedPort() {
  const socket = net.createServer();
  socket.unref();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function runProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? rootDir,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 30_000);
  timeout.unref();
  if (options.input === undefined) child.stdin.end();
  else child.stdin.end(options.input);

  const [code, signal] = await once(child, "exit");
  clearTimeout(timeout);
  return {
    code,
    signal,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
  };
}

function processDiagnostic(result) {
  return [
    `exit=${String(result.code)} signal=${String(result.signal)}`,
    `stdout=${JSON.stringify(result.stdout.toString("utf8"))}`,
    `stderr=${JSON.stringify(result.stderr.toString("utf8"))}`,
  ].join("\n");
}

function assertExit(result, expected, context) {
  assert.equal(result.code, expected, `${context}\n${processDiagnostic(result)}`);
  assert.equal(result.signal, null, `${context} was killed\n${processDiagnostic(result)}`);
}

function parseJson(result, context) {
  assertExit(result, 0, context);
  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch (error) {
    assert.fail(`${context} returned invalid JSON: ${String(error)}\n${processDiagnostic(result)}`);
  }
}

async function waitForServer(server, baseUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Next server exited before becoming healthy\n${server.logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Next server\n${server.logs()}`);
}

async function startServer({ port, databasePath, storageDir, bootstrap = false }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, [nextEntry, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: serverDir,
    env: {
      ...process.env,
      DATABASE_URL: `file:${databasePath}`,
      FS_MAX_UPLOAD_BYTES: String(2 * oneGiB),
      FS_MIN_FREE_BYTES: "0",
      FS_PUBLIC_URL: baseUrl,
      FS_STORAGE_DIR: storageDir,
      FS_TOKEN: token,
      ...(bootstrap
        ? {
            FS_BOOTSTRAP_USERNAME: bootstrapUsername,
            FS_BOOTSTRAP_PASSWORD: bootstrapPassword,
          }
        : {}),
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const server = {
    child,
    baseUrl,
    logs: () => `server stdout:\n${Buffer.concat(stdout).toString("utf8")}\nserver stderr:\n${Buffer.concat(stderr).toString("utf8")}`,
  };
  await waitForServer(server, baseUrl);
  return server;
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  const outcome = await Promise.race([exited.then(() => "exited"), delay(5_000).then(() => "timeout")]);
  if (outcome === "timeout") {
    server.child.kill("SIGKILL");
    await exited;
  }
}

test("built server and CLI work together end to end", { timeout: 180_000 }, async (t) => {
  await access(cliEntry, fsConstants.R_OK);
  await access(nextEntry, fsConstants.R_OK);
  await access(path.join(serverDir, ".next", "BUILD_ID"), fsConstants.R_OK);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "fs-e2e-"));
  const fixtureDir = path.join(temporaryRoot, "fixtures");
  const downloadDir = path.join(temporaryRoot, "downloads");
  const databasePath = path.join(temporaryRoot, "files.db");
  const storageDir = path.join(temporaryRoot, "objects");
  await Promise.all([mkdir(fixtureDir), mkdir(downloadDir)]);

  const port = await unusedPort();
  let server;
  let baseUrl = `http://127.0.0.1:${port}`;

  const cli = (args, options = {}) => runProcess(process.execPath, [cliEntry, ...args], {
    cwd: options.cwd ?? fixtureDir,
    input: options.input,
    timeout: options.timeout,
    env: {
      ...process.env,
      FS_TOKEN: options.token ?? token,
      FS_URL: options.url ?? baseUrl,
      NO_COLOR: "1",
    },
  });

  const request = (route, options = {}, authenticated = true) => {
    const headers = new Headers(options.headers);
    if (authenticated) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${baseUrl}${route}`, { ...options, headers });
  };

  const uploadJson = async (args, options) => {
    const result = await cli([...args, "--json"], options);
    const body = parseJson(result, `fs ${args.join(" ")}`);
    assert(Array.isArray(body), `upload output should be an array: ${processDiagnostic(result)}`);
    assert(body.length > 0, "upload should return at least one object");
    return body;
  };

  t.after(async () => {
    await stopServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  server = await startServer({ port, databasePath, storageDir, bootstrap: true });
  baseUrl = server.baseUrl;

  await t.test("health endpoint reports usable storage", async () => {
    const response = await request("/healthz", {}, false);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.free_bytes, "number");
    assert(body.free_bytes > 0);
  });

  await t.test("bootstrap login, custom API key, protected visibility, and revocation work", async () => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ username: bootstrapUsername, password: bootstrapPassword }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert(cookie, "login should set the session cookie");

    const created = await fetch(`${baseUrl}/api/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: baseUrl },
      body: JSON.stringify({ name: "e2e-cli" }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const apiKey = createdBody.api_key.secret;
    assert.match(apiKey, /^fsk_[A-Za-z0-9_-]{43}$/);

    const protectedPath = path.join(fixtureDir, "protected-e2e.txt");
    await writeFile(protectedPath, "authenticated only");
    const [uploaded] = await uploadJson([protectedPath, "--protected"], {
      token: apiKey,
    });
    assert.equal(uploaded.visibility, "protected");
    assert.equal((await request(`/raw/${uploaded.id}`, {}, false)).status, 404);
    assert.equal((await fetch(`${baseUrl}/raw/${uploaded.id}`, { headers: { authorization: `Bearer ${apiKey}` } })).status, 200);

    const revoked = await fetch(`${baseUrl}/api/api-keys/${createdBody.api_key.id}`, {
      method: "DELETE",
      headers: { cookie, origin: baseUrl },
    });
    assert.equal(revoked.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/files`, { headers: { authorization: `Bearer ${apiKey}` } })).status, 401);
  });

  let persistenceId;
  let persistenceBytes;
  await t.test("shorthand and explicit uploads preserve binary and empty data", async () => {
    persistenceBytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x41, 0x00, 0x7f]);
    const binaryPath = path.join(fixtureDir, "binary.dat");
    const emptyPath = path.join(fixtureDir, "empty.txt");
    await Promise.all([writeFile(binaryPath, persistenceBytes), writeFile(emptyPath, Buffer.alloc(0))]);

    const shorthand = await uploadJson([binaryPath, "--tag", "binary"]);
    const explicit = await uploadJson(["up", emptyPath, "--tag", "empty"]);
    assert.equal(shorthand.length, 1);
    assert.equal(explicit.length, 1);
    persistenceId = shorthand[0].id;
    assert.match(persistenceId, /^[A-Za-z0-9]{7}$/);
    assert.equal(shorthand[0].sha256, sha256(persistenceBytes));
    assert.equal(shorthand[0].size, persistenceBytes.length);
    assert.equal(explicit[0].sha256, sha256(Buffer.alloc(0)));
    assert.equal(explicit[0].size, 0);

    const binaryRaw = await request(`/raw/${persistenceId}`, {}, false);
    assert.equal(binaryRaw.status, 200);
    assert.deepEqual(Buffer.from(await binaryRaw.arrayBuffer()), persistenceBytes);
    const emptyRaw = await request(`/raw/${explicit[0].id}`, {}, false);
    assert.equal(emptyRaw.status, 200);
    assert.equal((await emptyRaw.arrayBuffer()).byteLength, 0);
  });

  await t.test("tags, query/name searches, and list machine formats are stable", async () => {
    const reportPath = path.join(fixtureDir, "report-2026.pdf");
    const notesPath = path.join(fixtureDir, "meeting-notes.txt");
    await Promise.all([writeFile(reportPath, "pdf-ish"), writeFile(notesPath, "notes")]);
    const [report] = await uploadJson([reportPath, "--tag", "finance", "--tag", "quarterly"]);
    const [notes] = await uploadJson([notesPath, "--tag", "quarterly"]);

    const byQuery = parseJson(await cli(["find", "finance", "--json"]), "find by query");
    assert.deepEqual(byQuery.map((item) => item.id), [report.id]);
    const byName = parseJson(await cli(["find", "--name", "report-202?.pdf", "--json"]), "find by glob name");
    assert(byName.some((item) => item.id === report.id));
    assert(!byName.some((item) => item.id === notes.id));
    const byAllTags = parseJson(await cli(["find", "--tag", "finance", "--tag", "quarterly", "--json"]), "find by all tags");
    assert.deepEqual(byAllTags.map((item) => item.id), [report.id]);

    const listed = parseJson(await cli(["list", "--json"]), "list json");
    assert(listed.some((item) => item.id === report.id));
    const jsonlResult = await cli(["list", "--jsonl"]);
    assertExit(jsonlResult, 0, "list jsonl");
    const jsonl = jsonlResult.stdout.toString("utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(jsonl.length, listed.length);
    assert(jsonl.every((item) => typeof item.id === "string"));

    const idsResult = await cli(["list", "--ids"]);
    assertExit(idsResult, 0, "list ids");
    const ids = idsResult.stdout.toString("utf8").trim().split("\n");
    assert(ids.includes(report.id));
    const nullResult = await cli(["find", "--tag", "quarterly", "--ids", "--null"]);
    assertExit(nullResult, 0, "find nul-delimited ids");
    assert(nullResult.stdout.includes(0));
    assert.deepEqual(nullResult.stdout.toString("utf8").split("\0").filter(Boolean).sort(), [notes.id, report.id].sort());
  });

  await t.test("public/private access and visibility transitions obey authentication", async () => {
    const publicPath = path.join(fixtureDir, "public.txt");
    const privatePath = path.join(fixtureDir, "private.txt");
    await Promise.all([writeFile(publicPath, "public"), writeFile(privatePath, "private")]);
    const [publicFile] = await uploadJson([publicPath]);
    const [privateFile] = await uploadJson([privatePath, "--private"]);

    for (const route of [`/${publicFile.id}`, `/raw/${publicFile.id}`]) {
      assert.equal((await request(route, {}, false)).status, 200, `${route} should be public`);
    }
    for (const route of [`/${privateFile.id}`, `/raw/${privateFile.id}`]) {
      assert.equal((await request(route, {}, false)).status, 404, `${route} should hide private files`);
      assert.equal((await request(route)).status, 200, `${route} should accept a token`);
    }

    let changed = parseJson(await cli(["visibility", publicFile.id, "private", "--json"]), "make public file private");
    assert.equal(changed.visibility, "private");
    assert.equal((await request(`/raw/${publicFile.id}`, {}, false)).status, 404);
    changed = parseJson(await cli(["visibility", publicFile.id, "public", "--json"]), "make private file public");
    assert.equal(changed.visibility, "public");
    assert.equal((await request(`/raw/${publicFile.id}`, {}, false)).status, 200);
  });

  await t.test("HTML and SVG previews escape source and set defensive headers", async () => {
    const htmlSource = '<script>globalThis.pwned=true</script><b title="x">hello & goodbye</b>';
    const svgSource = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>safe?</text></svg>';
    const htmlPath = path.join(fixtureDir, "attack.html");
    const svgPath = path.join(fixtureDir, "attack.svg");
    await Promise.all([writeFile(htmlPath, htmlSource), writeFile(svgPath, svgSource)]);
    const [htmlFile] = await uploadJson([htmlPath]);
    const [svgFile] = await uploadJson([svgPath]);

    for (const [file, dangerous, escaped] of [
      [htmlFile, "<script>globalThis.pwned=true</script>", "&lt;script&gt;globalThis.pwned=true&lt;/script&gt;"],
      [svgFile, '<svg xmlns="http://www.w3.org/2000/svg">', "&lt;svg xmlns=&quot;http://www.w3.org/2000/svg&quot;&gt;"],
    ]) {
      const preview = await request(`/${file.id}`, {}, false);
      assert.equal(preview.status, 200);
      const page = await preview.text();
      assert(!page.includes(dangerous), "preview must not contain executable source markup");
      assert(page.includes(escaped), "preview should render escaped source text");
      assert.match(preview.headers.get("content-security-policy") ?? "", /default-src 'none'/);
      assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
      assert.equal(preview.headers.get("referrer-policy"), "no-referrer");

      const raw = await request(`/raw/${file.id}`, {}, false);
      assert.equal(raw.status, 200);
      assert.match(raw.headers.get("content-security-policy") ?? "", /^sandbox;/);
      assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
    }
  });

  await t.test("raw downloads implement exact single byte ranges", async () => {
    const bytes = Buffer.from("0123456789", "ascii");
    const rangePath = path.join(fixtureDir, "ranges.bin");
    await writeFile(rangePath, bytes);
    const [file] = await uploadJson([rangePath]);

    for (const [header, expected, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=6-", "6789", "bytes 6-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=8-99", "89", "bytes 8-9/10"],
    ]) {
      const response = await request(`/raw/${file.id}`, { headers: { range: header } }, false);
      assert.equal(response.status, 206, header);
      assert.equal(response.headers.get("content-range"), contentRange);
      assert.equal(response.headers.get("accept-ranges"), "bytes");
      assert.equal(Buffer.from(await response.arrayBuffer()).toString("ascii"), expected);
    }

    for (const header of ["bytes=10-", "bytes=4-2", "bytes=0-1,4-5", "nibbles=0-1", "bytes=-0"]) {
      const response = await request(`/raw/${file.id}`, { headers: { range: header } }, false);
      assert.equal(response.status, 416, header);
      assert.equal(response.headers.get("content-range"), "bytes */10");
    }
  });

  await t.test("info returns canonical preview/raw URLs and tag mutations work", async () => {
    const pathToFile = path.join(fixtureDir, "mutable.txt");
    await writeFile(pathToFile, "mutable");
    const [file] = await uploadJson([pathToFile, "--tag", "initial"]);
    let info = parseJson(await cli(["info", file.id, "--json"]), "info json");
    assert.equal(info.preview_url, `${baseUrl}/${file.id}`);
    assert.equal(info.raw_url, `${baseUrl}/raw/${file.id}`);

    info = parseJson(await cli(["tag", file.id, "add", "reviewed", "alpha", "--json"]), "tag add");
    assert.deepEqual([...info.tags].sort(), ["alpha", "initial", "reviewed"]);
    info = parseJson(await cli(["tag", file.id, "remove", "initial", "--json"]), "tag remove");
    assert.deepEqual([...info.tags].sort(), ["alpha", "reviewed"]);
    info = parseJson(await cli(["tag", file.id, "set", "final", "only", "--json"]), "tag set");
    assert.deepEqual([...info.tags].sort(), ["final", "only"]);
  });

  await t.test("quoted local globs deduplicate matches and exclude hidden files unless explicit", async () => {
    const globRoot = path.join(fixtureDir, "glob-inputs");
    await mkdir(path.join(globRoot, "nested"), { recursive: true });
    await Promise.all([
      writeFile(path.join(globRoot, "a.txt"), "a"),
      writeFile(path.join(globRoot, "b.txt"), "b"),
      writeFile(path.join(globRoot, ".hidden.txt"), "hidden"),
      writeFile(path.join(globRoot, "nested", "c.txt"), "c"),
    ]);

    const visible = await uploadJson(["up", path.join(globRoot, "**", "*.txt"), path.join(globRoot, "a.txt"), "--tag", "glob-visible"]);
    assert.equal(visible.length, 3, "a.txt should be deduplicated and hidden files excluded");
    assert.deepEqual(visible.map((item) => item.name).sort(), ["a.txt", "b.txt", "c.txt"]);
    const hidden = await uploadJson(["up", path.join(globRoot, ".*.txt"), "--tag", "glob-hidden"]);
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0].name, ".hidden.txt");
  });

  await t.test("recursive folder uploads archive without following symlinks and extract safely", async () => {
    const folder = path.join(fixtureDir, "folder-object");
    await mkdir(path.join(folder, "nested"), { recursive: true });
    await mkdir(path.join(folder, "empty-dir"));
    await writeFile(path.join(folder, "root.txt"), "root contents");
    await writeFile(path.join(folder, "nested", "value.bin"), Buffer.from([9, 8, 7, 0]));
    await symlink("nested/value.bin", path.join(folder, "value-link"));

    const [archive] = await uploadJson(["up", "-r", folder, "--tag", "archive"]);
    assert.equal(archive.name, "folder-object.tar.gz");
    assert.equal(archive.archive, "tar.gz");
    const extraction = path.join(downloadDir, "restored-folder");
    const result = await cli(["down", archive.id, "--extract", "-o", extraction]);
    assertExit(result, 0, "download and extract archive");
    assert.equal(await readFile(path.join(extraction, "root.txt"), "utf8"), "root contents");
    assert.deepEqual(await readFile(path.join(extraction, "nested", "value.bin")), Buffer.from([9, 8, 7, 0]));
    assert((await lstat(path.join(extraction, "empty-dir"))).isDirectory());
    assert((await lstat(path.join(extraction, "value-link"))).isSymbolicLink());
    assert.equal(await readlink(path.join(extraction, "value-link")), "nested/value.bin");
  });

  await t.test("archive extraction rejects traversal before writing outside the destination", async () => {
    const maliciousArchive = gzipSync(singleFileTar("../escaped.txt", "should never be written"));
    const response = await request("/api/files?name=malicious.tar.gz&archive=tar.gz", {
      method: "POST",
      headers: {
        "content-length": String(maliciousArchive.length),
        "content-type": "application/gzip",
      },
      body: maliciousArchive,
    });
    assert.equal(response.status, 201);
    const uploaded = await response.json();
    assert.equal(uploaded.archive, "tar.gz");

    const destination = path.join(downloadDir, "malicious-destination");
    const escaped = path.join(downloadDir, "escaped.txt");
    const result = await cli(["down", uploaded.id, "--extract", "-o", destination]);
    assertExit(result, 1, "malicious archive traversal");
    await assert.rejects(access(destination), { code: "ENOENT" });
    await assert.rejects(access(escaped), { code: "ENOENT" });
  });

  let stdinFile;
  const stdinBytes = Buffer.from([0, 1, 2, 3, 255, 10, 0]);
  await t.test("stdin upload and stdout download keep data channels byte-pure", async () => {
    const uploaded = await cli(["up", "-", "--name", "stdin.bin", "--tag", "stdin", "--json"], { input: stdinBytes });
    const body = parseJson(uploaded, "stdin upload");
    assert.equal(body.length, 1);
    stdinFile = body[0];
    assert.equal(stdinFile.sha256, sha256(stdinBytes));

    const downloaded = await cli(["down", stdinFile.id, "-o", "-"]);
    assertExit(downloaded, 0, "download to stdout");
    assert.deepEqual(downloaded.stdout, stdinBytes);
    assert.equal(downloaded.stderr.length, 0, "successful binary stdout must not be contaminated by diagnostics");
  });

  await t.test("rm requires noninteractive confirmation and deletes only with --yes", async () => {
    const refused = await cli(["rm", stdinFile.id, "--no-input"]);
    assertExit(refused, 2, "noninteractive rm without --yes");
    assert.match(refused.stderr.toString("utf8"), /requires --yes/i);
    assert.equal((await request(`/raw/${stdinFile.id}`)).status, 200);

    const removed = await cli(["rm", stdinFile.id, "--yes", "--json"]);
    const result = parseJson(removed, "confirmed rm");
    assert.deepEqual(result, [{ id: stdinFile.id, deleted: true }]);
    assert.equal((await request(`/raw/${stdinFile.id}`, {}, false)).status, 404);
    const missing = await cli(["info", stdinFile.id, "--json"]);
    assertExit(missing, 4, "info after delete");
  });

  await t.test("CLI maps usage, auth, not-found, conflict, network, and partial failures", async () => {
    const auth = await cli(["list", "--json"], { token: "wrong-token" });
    assertExit(auth, 3, "invalid token");
    const usage = await cli(["info", "bad-id", "--json"]);
    assertExit(usage, 2, "invalid ID usage");
    const notFound = await cli(["info", "ZZZZZZZ", "--json"]);
    assertExit(notFound, 4, "missing file");

    const existingOutput = path.join(downloadDir, "already-exists.bin");
    await writeFile(existingOutput, "keep me");
    const conflict = await cli(["down", persistenceId, "-o", existingOutput]);
    assertExit(conflict, 5, "existing download destination");
    assert.equal(await readFile(existingOutput, "utf8"), "keep me");

    const deadPort = await unusedPort();
    const network = await cli(["list", "--json"], { url: `http://127.0.0.1:${deadPort}` });
    assertExit(network, 6, "unreachable server");
    const partial = await cli(["info", persistenceId, "ZZZZZZZ", "--json"]);
    assertExit(partial, 8, "mixed info result");
    const partialBody = JSON.parse(partial.stdout.toString("utf8"));
    assert.equal(partialBody.length, 2);
    assert(partialBody.some((item) => item.id === persistenceId && !item.error));
    assert(partialBody.some((item) => item.id === "ZZZZZZZ" && item.error));
  });

  await t.test("over-1-GiB sparse upload stops at noninteractive preflight without a request", async () => {
    const before = parseJson(await cli(["list", "--json"]), "list before large preflight");
    const sparsePath = path.join(fixtureDir, "requires-approval.bin");
    const handle = await open(sparsePath, "w");
    try {
      await handle.truncate(oneGiB + 1);
    } finally {
      await handle.close();
    }

    const result = await cli(["up", sparsePath, "--no-input", "--json"], { timeout: 10_000 });
    assertExit(result, 7, "large upload approval preflight");
    assert.match(result.stderr.toString("utf8"), /human approval/i);
    assert.match(result.stderr.toString("utf8"), /continue unblocked work first/i);
    assert.equal(result.stdout.length, 0);
    const after = parseJson(await cli(["list", "--json"]), "list after large preflight");
    assert.equal(after.length, before.length, "rejected large upload must not reach server storage");
    assert(!after.some((item) => item.name === "requires-approval.bin"));
  });

  await t.test("metadata and object bytes persist across a real server restart", async () => {
    assert(persistenceId, "persistence fixture should exist");
    await stopServer(server);
    server = undefined;
    server = await startServer({ port, databasePath, storageDir });
    baseUrl = server.baseUrl;

    const info = parseJson(await cli(["info", persistenceId, "--json"]), "info after restart");
    assert.equal(info.sha256, sha256(persistenceBytes));
    const raw = await request(`/raw/${persistenceId}`, {}, false);
    assert.equal(raw.status, 200);
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), persistenceBytes);
  });
});
