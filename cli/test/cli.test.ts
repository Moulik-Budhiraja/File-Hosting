import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import * as tar from "tar";
import { run } from "../src/main.js";
import type { ProgressScheduler } from "../src/progress.js";
import type { FileMetadata, Streams } from "../src/types.js";

class Capture extends Writable {
  isTTY = false;
  readonly chunks: Buffer[] = [];
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
  get buffer(): Buffer { return Buffer.concat(this.chunks); }
  get text(): string { return this.buffer.toString("utf8"); }
}

class CliScheduler implements ProgressScheduler {
  private nowValue = 0;
  private sequence = 0;
  private readonly timeouts = new Map<number, { at: number; callback: () => void }>();

  now(): number { return this.nowValue; }
  setTimeout(callback: () => void, delay: number): object {
    const id = ++this.sequence;
    this.timeouts.set(id, { at: this.nowValue + delay, callback });
    return { id };
  }
  clearTimeout(handle: object): void { this.timeouts.delete((handle as { id: number }).id); }
  setInterval(_callback: () => void, _delay: number): object { return { id: ++this.sequence }; }
  clearInterval(_handle: object): void {}
  advance(ms: number): void {
    this.nowValue += ms;
    for (const [id, task] of [...this.timeouts]) {
      if (task.at <= this.nowValue) {
        this.timeouts.delete(id);
        task.callback();
      }
    }
  }
}

interface Stored {
  metadata: FileMetadata;
  body: Buffer;
}

class MockService {
  readonly files = new Map<string, Stored>();
  readonly requests: Array<{ method: string; path: string; query: URLSearchParams; authorization?: string }> = [];
  private sequence = 1;
  private readonly server = createServer((request, response) => void this.handle(request, response));
  url = "";

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    assert(address && typeof address === "object");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  reset(): void {
    this.files.clear();
    this.requests.length = 0;
    this.sequence = 1;
  }

  seed(overrides: Partial<FileMetadata> = {}, body = Buffer.from("seed")): FileMetadata {
    const id = overrides.id ?? this.nextId();
    const metadata: FileMetadata = {
      id,
      name: "seed.txt",
      size: body.length,
      visibility: "public",
      tags: [],
      archive: null,
      created_at: "2026-07-11T00:00:00Z",
      ...overrides,
    };
    this.files.set(id, { metadata, body });
    return metadata;
  }

  private nextId(): string {
    return `Ab${String(this.sequence++).padStart(5, "0")}`;
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  }

  private async body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  private auth(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.headers.authorization === "Bearer secret") return true;
    this.json(response, 401, { error: { code: "UNAUTHORIZED", message: "bad token" } });
    return false;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.url);
    this.requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      authorization: request.headers.authorization,
    });
    if (!this.auth(request, response)) return;

    if (request.method === "POST" && url.pathname === "/api/files") {
      const body = await this.body(request);
      const id = this.nextId();
      const metadata: FileMetadata = {
        id,
        name: url.searchParams.get("name") ?? "file",
        size: body.length,
        visibility: url.searchParams.get("private") === "true" ? "private" : "public",
        tags: url.searchParams.getAll("tag"),
        archive: url.searchParams.get("archive") === "tar.gz" ? "tar.gz" : null,
        sha256: "test-sha",
        created_at: "2026-07-11T00:00:00Z",
      };
      this.files.set(id, { metadata, body });
      this.json(response, 201, metadata);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/files") {
      let items = [...this.files.values()].map((entry) => entry.metadata);
      const q = url.searchParams.get("q")?.toLowerCase();
      if (q) items = items.filter((item) => item.name.toLowerCase().includes(q) || item.tags.some((tag) => tag.toLowerCase().includes(q)));
      const name = url.searchParams.get("name");
      if (name) {
        const escaped = name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
        const regex = new RegExp(`^${escaped}$`);
        items = items.filter((item) => regex.test(item.name));
      }
      for (const tag of url.searchParams.getAll("tag")) items = items.filter((item) => item.tags.includes(tag));
      const visibility = url.searchParams.get("visibility");
      if (visibility) items = items.filter((item) => item.visibility === visibility);
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const requested = Number(url.searchParams.get("limit") ?? 500);
      const pageSize = Math.min(requested, 2);
      const page = items.slice(offset, offset + pageSize);
      const next = offset + page.length < items.length ? String(offset + page.length) : null;
      this.json(response, 200, { items: page, next_cursor: next });
      return;
    }

    const apiMatch = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
    if (apiMatch) {
      const id = decodeURIComponent(apiMatch[1]!);
      const stored = this.files.get(id);
      if (!stored) {
        this.json(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
        return;
      }
      if (request.method === "GET") {
        this.json(response, 200, stored.metadata);
        return;
      }
      if (request.method === "PATCH") {
        const patch = JSON.parse((await this.body(request)).toString("utf8")) as {
          tags?: { operation: "add" | "remove" | "set"; values: string[] };
          visibility?: "public" | "private";
        };
        if (patch.tags?.operation === "set") stored.metadata.tags = [...new Set(patch.tags.values)];
        if (patch.tags?.operation === "add") stored.metadata.tags = [...new Set([...stored.metadata.tags, ...patch.tags.values])];
        if (patch.tags?.operation === "remove") stored.metadata.tags = stored.metadata.tags.filter((tag) => !patch.tags!.values.includes(tag));
        if (patch.visibility) stored.metadata.visibility = patch.visibility;
        this.json(response, 200, stored.metadata);
        return;
      }
      if (request.method === "DELETE") {
        this.files.delete(id);
        response.writeHead(204).end();
        return;
      }
    }

    const rawMatch = /^\/raw\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && rawMatch) {
      const stored = this.files.get(decodeURIComponent(rawMatch[1]!));
      if (!stored) {
        this.json(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
        return;
      }
      response.writeHead(200, { "content-length": String(stored.body.length) });
      response.end(stored.body);
      return;
    }
    this.json(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
  }
}

const service = new MockService();
let scratch = "";

before(async () => {
  await service.start();
  scratch = await mkdtemp(join(tmpdir(), "fs-cli-test-"));
});

after(async () => {
  await service.stop();
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(() => service.reset());

async function cli(
  args: string[],
  input: string | Buffer = "",
  env: NodeJS.ProcessEnv = {},
  options: Record<string, unknown> & { tty?: boolean; fetch?: typeof fetch; scheduler?: ProgressScheduler } = {},
): Promise<{
  code: number;
  stdout: Capture;
  stderr: Capture;
}> {
  const stdout = new Capture();
  const stderr = new Capture();
  stderr.isTTY = options.tty ?? false;
  const stdin = Readable.from([input]);
  const streams: Streams = { stdin, stdout, stderr };
  const code = await run(args, {
    env: { FS_URL: service.url, FS_TOKEN: "secret", ...env },
    streams,
    ...options,
    fetch: options.fetch,
    progressScheduler: options.scheduler,
  });
  return { code, stdout, stderr };
}

test("subcommand help works without credentials", async () => {
  const result = await cli(["up", "--help"], "", { FS_TOKEN: "" });
  assert.equal(result.code, 0);
  assert.match(result.stdout.text, /Usage: fs \[up\]/);
  assert.equal(service.requests.length, 0);
});

test("auth help works without loading credentials", async () => {
  let reads = 0;
  const result = await cli(["auth", "--help"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): null { reads += 1; return null; },
      setPassword(): void {},
      deletePassword(): void {},
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout.text, /fs auth set/);
  assert.equal(reads, 0);
});

test("invalid auth actions return usage before touching credentials", async () => {
  let reads = 0;
  const result = await cli(["auth", "bogus"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): null { reads += 1; return null; },
      setPassword(): void {},
      deletePassword(): void {},
    },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr.text, /Usage: fs auth/);
  assert.equal(reads, 0);
});

test("uses a stored credential when FS_TOKEN is unset", async () => {
  let reads = 0;
  const result = await cli(["list"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): string {
        reads += 1;
        return "secret";
      },
      setPassword(): void {},
      deletePassword(): void {},
    },
  });
  assert.equal(result.code, 0);
  assert.equal(reads, 1);
  assert.equal(service.requests[0]?.authorization, "Bearer secret");
});

test("FS_TOKEN overrides the stored credential without reading it", async () => {
  let reads = 0;
  const result = await cli(["list"], "", {}, {
    credentials: {
      getPassword(): string {
        reads += 1;
        return "wrong";
      },
      setPassword(): void {},
      deletePassword(): void {},
    },
  });
  assert.equal(result.code, 0);
  assert.equal(reads, 0);
  assert.equal(service.requests[0]?.authorization, "Bearer secret");
});

test("falls back to the missing-token guidance when the credential store is unavailable", async () => {
  const result = await cli(["list"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): string { throw new Error("credential backend unavailable"); },
      setPassword(): void {},
      deletePassword(): void {},
    },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr.text, /auth set|FS_TOKEN/);
  assert.doesNotMatch(result.stderr.text, /credential backend unavailable/);
  assert.equal(service.requests.length, 0);
});

test("auth set securely prompts and saves without printing the token", async () => {
  let saved = "";
  const result = await cli(["auth", "set"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): null { return null; },
      setPassword(password: string): void { saved = password; },
      deletePassword(): void {},
    },
    readSecret: async (): Promise<string> => "new-secret-token",
  });
  assert.equal(result.code, 0);
  assert.equal(saved, "new-secret-token");
  assert.match(result.stderr.text, /saved/i);
  assert.doesNotMatch(result.stdout.text + result.stderr.text, /new-secret-token/);
  assert.equal(service.requests.length, 0);
});

test("auth status reports whether a token is saved without revealing it", async () => {
  const result = await cli(["auth", "status"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): string { return "stored-secret-token"; },
      setPassword(): void {},
      deletePassword(): void {},
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout.text, /configured/i);
  assert.doesNotMatch(result.stdout.text + result.stderr.text, /stored-secret-token/);
});

test("auth delete removes the stored credential", async () => {
  let deleted = false;
  const result = await cli(["auth", "delete"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): string { return "stored-secret-token"; },
      setPassword(): void {},
      deletePassword(): boolean { deleted = true; return true; },
    },
  });
  assert.equal(result.code, 0);
  assert.equal(deleted, true);
  assert.match(result.stderr.text, /deleted/i);
});

test("auth delete reports when no saved credential exists", async () => {
  const result = await cli(["auth", "delete"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): null { return null; },
      setPassword(): void {},
      deletePassword(): boolean { return false; },
    },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr.text, /no saved token/i);
  assert.doesNotMatch(result.stderr.text, /token deleted/i);
});

test("global --no-input is ignored by auth status", async () => {
  let reads = 0;
  const result = await cli(["--no-input", "auth", "status"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): string { reads += 1; return "stored-secret-token"; },
      setPassword(): void {},
      deletePassword(): void {},
    },
  });
  assert.equal(result.code, 0);
  assert.equal(reads, 1);
  assert.match(result.stdout.text, /configured/i);
});

test("global --no-input is ignored by auth delete", async () => {
  let deletes = 0;
  const result = await cli(["--no-input", "auth", "delete"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): null { return null; },
      setPassword(): void {},
      deletePassword(): boolean { deletes += 1; return true; },
    },
  });
  assert.equal(result.code, 0);
  assert.equal(deletes, 1);
  assert.match(result.stderr.text, /deleted/i);
});

test("global --no-input rejects interactive auth set without reading or saving", async () => {
  let reads = 0;
  let writes = 0;
  const result = await cli(["--no-input", "auth", "set"], "", { FS_TOKEN: "" }, {
    credentials: {
      getPassword(): null { return null; },
      setPassword(): void { writes += 1; },
      deletePassword(): void {},
    },
    readSecret: async (): Promise<string> => { reads += 1; return "new-secret-token"; },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr.text, /auth set.*interactive|interactive.*auth set/i);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test("upload shorthand streams bytes and applies tags and visibility", async () => {
  const path = join(scratch, "report.txt");
  await writeFile(path, "hello agent");
  const result = await cli([path, "--tag", "report", "--tag", "quarterly", "--private", "--json"]);
  assert.equal(result.code, 0);
  const [item] = JSON.parse(result.stdout.text) as FileMetadata[];
  assert.equal(item.name, "report.txt");
  assert.equal(item.visibility, "private");
  assert.deepEqual(item.tags, ["report", "quarterly"]);
  assert.equal(item.preview_url, `${service.url}/${item.id}`);
  assert.equal(service.files.get(item.id)?.body.toString(), "hello agent");
  assert.equal(service.requests[0]?.authorization, "Bearer secret");
});

test("upload success waits for the API response after the body reaches EOF", async () => {
  const path = join(scratch, "await-response.bin");
  await writeFile(path, Buffer.alloc(256 * 1024));
  const scheduler = new CliScheduler();
  const stdout = new Capture();
  const stderr = new Capture();
  stderr.isTTY = true;
  let bodyFinished!: () => void;
  let releaseResponse!: () => void;
  const bodyFinishedPromise = new Promise<void>((resolve) => { bodyFinished = resolve; });
  const responsePromise = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const fetchAfterResponse: typeof fetch = async (_input, init) => {
    let first = true;
    for await (const _chunk of init!.body as unknown as Readable) {
      if (first) {
        first = false;
        scheduler.advance(2_500);
      }
    }
    bodyFinished();
    await responsePromise;
    return Response.json({
      id: "Ab90002",
      name: "await-response.bin",
      size: 256 * 1024,
      visibility: "public",
      tags: [],
      archive: null,
    }, { status: 201 });
  };

  const running = run([path], {
    env: { FS_URL: service.url, FS_TOKEN: "secret" },
    streams: { stdin: Readable.from([]), stdout, stderr },
    fetch: fetchAfterResponse,
    progressScheduler: scheduler,
  });
  await bodyFinishedPromise;

  assert.match(stderr.text, /Uploading await-response\.bin:/);
  assert.doesNotMatch(stderr.text, /done\n/);

  releaseResponse();
  assert.equal(await running, 0);
  assert.match(stderr.text, /done\n$/);
});

test("upload rejection after body EOF never renders success", async () => {
  const path = join(scratch, "rejected-after-eof.bin");
  await writeFile(path, Buffer.alloc(256 * 1024));
  const scheduler = new CliScheduler();
  const rejectAfterBody: typeof fetch = async (_input, init) => {
    let first = true;
    for await (const _chunk of init!.body as unknown as Readable) {
      if (first) {
        first = false;
        scheduler.advance(2_500);
      }
    }
    return Response.json({ error: { code: "STORE_FAILED", message: "storage failed" } }, { status: 500 });
  };

  const result = await cli([path], "", {}, { tty: true, scheduler, fetch: rejectAfterBody });

  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stderr.text, /done\n/);
  assert.match(result.stderr.text, /\r\x1b\[2Kfs: .*storage failed/);
});

test("upload progress is delayed and suppressed for structured output", async () => {
  const path = join(scratch, "slow-upload.bin");
  await writeFile(path, Buffer.alloc(256 * 1024));
  const delayedUpload = (progressScheduler: CliScheduler): typeof fetch => async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
    let size = 0;
    let first = true;
    for await (const chunk of init!.body as unknown as Readable) {
      size += Buffer.byteLength(chunk);
      if (first) {
        first = false;
        progressScheduler.advance(2_500);
      }
    }
    return Response.json({
      id: "Ab90001",
      name: requestUrl.searchParams.get("name"),
      size,
      visibility: "public",
      tags: [],
      archive: null,
    }, { status: 201 });
  };

  const fastScheduler = new CliScheduler();
  const fast = await cli([path], "", {}, { tty: true, scheduler: fastScheduler });
  assert.equal(fast.code, 0);
  assert.equal(fast.stderr.text, "");

  const slowScheduler = new CliScheduler();
  const slow = await cli([path], "", {}, { tty: true, scheduler: slowScheduler, fetch: delayedUpload(slowScheduler) });
  assert.equal(slow.code, 0);
  assert.match(slow.stderr.text, /Uploading slow-upload\.bin: 256\.0 KB \/ 256\.0 KB \(100%\).*done\n$/);

  for (const flag of ["--json", "--jsonl", "--id"]) {
    const structuredScheduler = new CliScheduler();
    const structured = await cli([path, flag], "", {}, {
      tty: true,
      scheduler: structuredScheduler,
      fetch: delayedUpload(structuredScheduler),
    });
    assert.equal(structured.stderr.text, "");
    if (flag === "--id") assert.match(structured.stdout.text, /^Ab\d{5}\n$/);
    else assert.doesNotThrow(() => JSON.parse(structured.stdout.text));
  }
});

test("stdin upload requires a name and can emit only an ID", async () => {
  const missing = await cli(["up", "-", "--id"], "piped");
  assert.equal(missing.code, 2);
  assert.match(missing.stderr.text, /requires --name/);
  const result = await cli(["up", "-", "--name", "pipe.log", "--id"], "piped");
  assert.equal(result.code, 0);
  assert.match(result.stdout.text, /^Ab\d{5}\n$/);
  assert.equal([...service.files.values()][0]?.body.toString(), "piped");
});

test("quoted recursive globs omit hidden files and deduplicate matches", async () => {
  const root = await mkdtemp(join(scratch, "glob-"));
  await writeFile(join(root, "one.txt"), "1");
  await writeFile(join(root, ".hidden.txt"), "hidden");
  await writeFile(join(root, "other.bin"), "x");
  const nested = join(root, "nested");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(nested));
  await writeFile(join(nested, "two.txt"), "2");
  const result = await cli(["up", `${root}/**/*.txt`, join(root, "one.txt"), "--json"]);
  assert.equal(result.code, 0);
  const items = JSON.parse(result.stdout.text) as FileMetadata[];
  assert.deepEqual(items.map((item) => item.name).sort(), ["one.txt", "two.txt"]);
});

test("directories require -r and archives retain symlink entries", async () => {
  const root = await mkdtemp(join(scratch, "folder-"));
  await writeFile(join(root, "a.txt"), "a");
  await symlink("a.txt", join(root, "link.txt"));
  const rejected = await cli(["up", root]);
  assert.equal(rejected.code, 2);
  assert.match(rejected.stderr.text, /--recursive/);

  const result = await cli(["up", "-r", root, "--json"]);
  assert.equal(result.code, 0);
  const [item] = JSON.parse(result.stdout.text) as FileMetadata[];
  assert.equal(item.archive, "tar.gz");
  assert.equal(item.name, `${basename(root)}.tar.gz`);
  const archive = join(scratch, "captured.tar.gz");
  await writeFile(archive, service.files.get(item.id)!.body);
  const entries: Array<{ path: string; type: string }> = [];
  await tar.list({ file: archive, onentry: (entry) => entries.push({ path: entry.path, type: entry.type }) });
  assert(entries.some((entry) => entry.path.endsWith("a.txt")));
  assert(entries.some((entry) => entry.path.endsWith("link.txt") && entry.type === "SymbolicLink"));
});

test("unmatched globs fail with usage status", async () => {
  const result = await cli(["up", `${scratch}/does-not-exist/**/*.wat`]);
  assert.equal(result.code, 2);
  assert.match(result.stderr.text, /did not match/);
});

test("noninteractive uploads over 1 GiB require explicit approval", async () => {
  const path = join(scratch, "sparse-large.bin");
  await writeFile(path, "");
  await truncate(path, 1024 ** 3 + 1);
  const result = await cli(["--no-input", path]);
  assert.equal(result.code, 7);
  assert.match(result.stderr.text, /human approval/i);
  assert.equal(service.requests.length, 0);
  await rm(path);
});

test("list paginates, caps server page size, and supports NUL-delimited IDs", async () => {
  const ids = [service.seed().id, service.seed().id, service.seed().id];
  const result = await cli(["list", "--limit", "1000", "--ids", "--null"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout.buffer, Buffer.from(`${ids[0]}\0${ids[1]}\0${ids[2]}\0`));
  const limits = service.requests.filter((request) => request.path === "/api/files").map((request) => Number(request.query.get("limit")));
  assert(limits.length >= 2);
  assert(limits.every((limit) => limit <= 500));
});

test("find sends query, name glob, tags, and visibility", async () => {
  const match = service.seed({ name: "quarterly.pdf", tags: ["finance"], visibility: "private" });
  service.seed({ name: "quarterly.txt", tags: ["finance"], visibility: "private" });
  service.seed({ name: "quarterly.pdf", tags: ["other"], visibility: "private" });
  const result = await cli(["find", "quarter", "--name", "*.pdf", "--tag", "finance", "--private", "--jsonl"]);
  assert.equal(result.code, 0);
  assert.equal((JSON.parse(result.stdout.text) as FileMetadata).id, match.id);
  const request = service.requests.find((entry) => entry.path === "/api/files")!;
  assert.equal(request.query.get("q"), "quarter");
  assert.equal(request.query.get("name"), "*.pdf");
  assert.deepEqual(request.query.getAll("tag"), ["finance"]);
  assert.equal(request.query.get("visibility"), "private");
});

test("info includes preview and raw URLs", async () => {
  const item = service.seed();
  const result = await cli(["info", item.id, "--json"]);
  assert.equal(result.code, 0);
  const value = JSON.parse(result.stdout.text) as FileMetadata;
  assert.equal(value.preview_url, `${service.url}/${item.id}`);
  assert.equal(value.raw_url, `${service.url}/raw/${item.id}`);
});

test("tag and visibility commands use PATCH semantics", async () => {
  const item = service.seed({ tags: ["old"] });
  assert.equal((await cli(["tag", item.id, "add", "new", "old", "--json"])).code, 0);
  assert.deepEqual(service.files.get(item.id)?.metadata.tags, ["old", "new"]);
  assert.equal((await cli(["tag", item.id, "remove", "old"])).code, 0);
  assert.deepEqual(service.files.get(item.id)?.metadata.tags, ["new"]);
  assert.equal((await cli(["tag", item.id, "set"])).code, 0);
  assert.deepEqual(service.files.get(item.id)?.metadata.tags, []);
  assert.equal((await cli(["visibility", item.id, "private"])).code, 0);
  assert.equal(service.files.get(item.id)?.metadata.visibility, "private");
});

test("rm never prompts noninteractively and supports leading --no-input", async () => {
  const first = service.seed();
  const refused = await cli(["rm", first.id]);
  assert.equal(refused.code, 2);
  assert(service.files.has(first.id));
  const result = await cli(["--no-input", "rm", first.id, "--yes", "--json"]);
  assert.equal(result.code, 0);
  assert(!service.files.has(first.id));
  assert.deepEqual(JSON.parse(result.stdout.text), [{ id: first.id, deleted: true }]);
});

test("IDs are validated as exact seven-character base62 values", async () => {
  for (const id of ["short", "Ab00001*", "Ab0000-"]) {
    const result = await cli(["info", id]);
    assert.equal(result.code, 2);
    assert.match(result.stderr.text, /7 base62/);
  }
  assert.equal(service.requests.length, 0);
});

test("download streams exact bytes to stdout", async () => {
  const body = Buffer.from([0, 1, 2, 255, 10]);
  const item = service.seed({ name: "binary.dat" }, body);
  const result = await cli(["down", item.id, "-o", "-"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout.buffer, body);
  assert.equal(result.stderr.text, "");
});

test("download progress is delayed and suppressed when streaming to stdout", async () => {
  const body = Buffer.alloc(1_000, 7);
  const item = service.seed({ name: "slow-download.bin" }, body);

  const fastDestination = join(scratch, "fast-download.bin");
  const fastScheduler = new CliScheduler();
  const fast = await cli(["down", item.id, "-o", fastDestination, "--force"], "", {}, { tty: true, scheduler: fastScheduler });
  assert.equal(fast.code, 0);
  assert.equal(fast.stderr.text, "");

  const slowDestination = join(scratch, "slow-download.bin");
  const slowScheduler = new CliScheduler();
  const slowFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(input instanceof Request ? input.url : input.toString()).pathname.startsWith("/raw/")) slowScheduler.advance(2_500);
    return response;
  };
  const slow = await cli(["down", item.id, "-o", slowDestination, "--force"], "", {}, {
    tty: true,
    scheduler: slowScheduler,
    fetch: slowFetch,
  });
  assert.equal(slow.code, 0);
  assert.deepEqual(await readFile(slowDestination), body);
  assert.match(slow.stderr.text, /Downloading slow-download\.bin: 1000 B \/ 1000 B \(100%\).*done\n$/);

  const stdoutScheduler = new CliScheduler();
  const stdoutFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(input instanceof Request ? input.url : input.toString()).pathname.startsWith("/raw/")) stdoutScheduler.advance(2_500);
    return response;
  };
  const piped = await cli(["down", item.id, "-o", "-"], "", {}, { tty: true, scheduler: stdoutScheduler, fetch: stdoutFetch });
  assert.deepEqual(piped.stdout.buffer, body);
  assert.equal(piped.stderr.text, "");
});

test("download avoids overwrite unless --force", async () => {
  const item = service.seed({ name: "result.txt" }, Buffer.from("new"));
  const destination = join(scratch, "download-result.txt");
  await writeFile(destination, "old");
  const refused = await cli(["down", item.id, "-o", destination]);
  assert.equal(refused.code, 5);
  assert.equal(await readFile(destination, "utf8"), "old");
  const replaced = await cli(["down", item.id, "-o", destination, "--force"]);
  assert.equal(replaced.code, 0);
  assert.equal(await readFile(destination, "utf8"), "new");
});

test("folder archives download and extract safely", async () => {
  const source = await mkdtemp(join(scratch, "extract-source-"));
  await writeFile(join(source, "inside.txt"), "inside");
  const uploaded = await cli(["up", "-r", source, "--json"]);
  const [item] = JSON.parse(uploaded.stdout.text) as FileMetadata[];
  const destination = join(scratch, "extracted-folder");
  const downloaded = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(downloaded.code, 0);
  assert.equal(await readFile(join(destination, "inside.txt"), "utf8"), "inside");
});

// Minimal ustar block for hostile fixtures — node-tar refuses to CREATE
// unsafe entries, so the attack bytes must be hand-built.
function rawTarEntry(
  pathname: string,
  contents: string,
  options: {
    type?: string;
    linkname?: string;
    declaredSize?: number;
    // ustar name prefix (offset 345) and the full 8-byte magic+version field
    // (offset 257); node-tar honors a prefix only for exactly "ustar\u000000".
    prefix?: string;
    prefixBytes?: Buffer;
    magic?: string;
    // Verbatim field writers. `Buffer.write(…, "utf8")` can never emit a NUL,
    // so the fields node-tar decodes with `decString` — which keeps the bytes
    // after a NUL that is followed by a line terminator — can only be
    // exercised by writing the raw bytes.
    nameBytes?: Buffer;
    linknameBytes?: Buffer;
  } = {},
): Buffer {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  if (options.nameBytes) options.nameBytes.copy(header, 0, 0, 100);
  else header.write(pathname, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "latin1");
  header.write("0000000\0", 108, 8, "latin1");
  header.write("0000000\0", 116, 8, "latin1");
  const declaredSize = options.declaredSize ?? body.length;
  if (declaredSize.toString(8).length <= 11) {
    header.write(`${declaredSize.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  } else {
    // POSIX/GNU base-256 numeric encoding for large declared sizes.
    let encoded = BigInt(declaredSize);
    for (let index = 135; index >= 124; index -= 1) {
      header[index] = Number(encoded & 0xffn);
      encoded >>= 8n;
    }
    header[124] = (header[124] ?? 0) | 0x80;
  }
  header.write("00000000000\0", 136, 12, "latin1");
  header.fill(0x20, 148, 156);
  header.write(options.type ?? "0", 156, 1, "latin1");
  if (options.linknameBytes) options.linknameBytes.copy(header, 157, 0, 100);
  else if (options.linkname) header.write(options.linkname, 157, 100, "utf8");
  header.write(options.magic ?? "ustar\u000000", 257, 8, "latin1");
  if (options.prefix) header.write(options.prefix, 345, 155, "utf8");
  if (options.prefixBytes) options.prefixBytes.copy(header, 345);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
}

// Server archive metadata is untrusted: extraction revalidates structure and
// paths independently before writing anything to the destination.
test("extraction refuses hostile bytes served under trusted archive metadata", async () => {
  const hostile = gzipSync(rawTarEntry("../escaped.txt", "should never be written"));
  const item = service.seed(
    { name: "hostile.tar.gz", archive: "tar.gz", size: hostile.length },
    hostile,
  );
  const destination = join(scratch, "hostile-destination");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.text, /unsafe path/i);
  await assert.rejects(readFile(destination), { code: "ENOENT" });
  await assert.rejects(readFile(join(scratch, "escaped.txt")), { code: "ENOENT" });
});

test("extraction refuses Windows traversal, special entries, and oversized declarations", async () => {
  const fixtures = [
    {
      name: "windows-traversal.tar.gz",
      bytes: gzipSync(rawTarEntry("..\\escaped.txt", "escape")),
      pattern: /unsafe path/i,
    },
    {
      name: "device.tar.gz",
      bytes: gzipSync(rawTarEntry("device", "", { type: "3" })),
      pattern: /unsupported archive entry type/i,
    },
    {
      name: "oversized.tar.gz",
      bytes: gzipSync(rawTarEntry("huge.bin", "", { declaredSize: 101 * 1024 ** 3 })),
      pattern: /declared uncompressed size/i,
    },
  ];

  for (const fixture of fixtures) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1);
    assert.match(result.stderr.text, fixture.pattern);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
  await assert.rejects(readFile(join(scratch, "escaped.txt")), { code: "ENOENT" });
});

// Strip the 1024-byte end-of-archive marker rawTarEntry appends, so entries
// can be concatenated or terminated deliberately.
function stripMarker(entry: Buffer): Buffer {
  return entry.subarray(0, entry.length - 1024);
}

test("extraction enforces the strict tar termination contract", async () => {
  const whole = rawTarEntry("inside.txt", "inside");
  const rejects: Array<{ name: string; bytes: Buffer; pattern: RegExp }> = [
    {
      name: "no-trailer.tar.gz",
      bytes: gzipSync(stripMarker(whole)),
      pattern: /end-of-archive/i,
    },
    {
      name: "one-zero-block.tar.gz",
      bytes: gzipSync(Buffer.concat([stripMarker(whole), Buffer.alloc(512)])),
      pattern: /end-of-archive/i,
    },
    {
      name: "tail-1.tar.gz",
      bytes: gzipSync(Buffer.concat([whole, Buffer.from([0x41])])),
      pattern: /after the end-of-archive/i,
    },
    {
      name: "tail-511.tar.gz",
      bytes: gzipSync(Buffer.concat([whole, Buffer.alloc(511, 0x41)])),
      pattern: /after the end-of-archive/i,
    },
    {
      name: "tail-block.tar.gz",
      bytes: gzipSync(Buffer.concat([whole, Buffer.alloc(512, 0x41)])),
      pattern: /after the end-of-archive/i,
    },
    {
      name: "second-member.tar.gz",
      bytes: Buffer.concat([gzipSync(whole), gzipSync(whole)]),
      pattern: /after the end-of-archive/i,
    },
    {
      name: "cut-gzip.tar.gz",
      bytes: gzipSync(whole).subarray(0, gzipSync(whole).length - 8),
      pattern: /gzip/i,
    },
  ];
  for (const fixture of rejects) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, fixture.pattern, fixture.name);
    // No destination is ever created or replaced for a rejected archive.
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }

  const accepts: Array<{ name: string; bytes: Buffer }> = [
    { name: "plain.tar.gz", bytes: gzipSync(whole) },
    {
      name: "partial-zero-tail.tar.gz",
      bytes: gzipSync(Buffer.concat([whole, Buffer.alloc(100)])),
    },
    {
      name: "extra-zero-blocks.tar.gz",
      bytes: gzipSync(Buffer.concat([whole, Buffer.alloc(3 * 512 + 7)])),
    },
    {
      name: "zero-member.tar.gz",
      bytes: Buffer.concat([gzipSync(whole), gzipSync(Buffer.alloc(700))]),
    },
  ];
  for (const fixture of accepts) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-out`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 0, `${fixture.name}: ${result.stderr.text}`);
    assert.equal(
      await readFile(join(destination, "inside.txt"), "utf8"),
      "inside",
    );
  }
});

test("extraction rejects a rejected archive without touching an existing destination", async () => {
  const destination = join(scratch, "keep-me");
  await writeFile(destination, "existing content");
  const bytes = gzipSync(
    Buffer.concat([rawTarEntry("inside.txt", "x"), Buffer.from([0x41])]),
  );
  const item = service.seed(
    { name: "tail.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const result = await cli([
    "down",
    item.id,
    "--extract",
    "-o",
    destination,
    "--force",
  ]);
  assert.equal(result.code, 1);
  assert.equal(await readFile(destination, "utf8"), "existing content");
});

test("extraction rejects Windows path spellings on every host OS", async () => {
  const fixtures: Array<{ name: string; bytes: Buffer }> = [
    {
      name: "drive-abs-backslash.tar.gz",
      bytes: gzipSync(rawTarEntry("C:\\absolute.txt", "x")),
    },
    {
      name: "drive-abs-slash.tar.gz",
      bytes: gzipSync(rawTarEntry("C:/absolute.txt", "x")),
    },
    {
      name: "drive-relative.tar.gz",
      bytes: gzipSync(rawTarEntry("c:relative.txt", "x")),
    },
    {
      name: "unc.tar.gz",
      bytes: gzipSync(rawTarEntry("\\\\server\\share\\file.txt", "x")),
    },
    {
      name: "device.tar.gz",
      bytes: gzipSync(rawTarEntry("\\\\.\\PIPE\\name", "x")),
    },
    {
      name: "drive-link.tar.gz",
      bytes: gzipSync(
        rawTarEntry("link", "", { type: "2", linkname: "C:\\target.txt" }),
      ),
    },
    {
      name: "drive-relative-link.tar.gz",
      bytes: gzipSync(
        rawTarEntry("link", "", { type: "1", linkname: "d:relative.txt" }),
      ),
    },
  ];
  for (const fixture of fixtures) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, /unsafe (path|link)/i, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
});

test("extraction honors pax size overrides for framing, like the server", async () => {
  function paxRecord(key: string, value: string): string {
    let length = key.length + value.length + 3;
    for (;;) {
      const next = String(length).length + key.length + value.length + 3;
      if (next === length) return `${length} ${key}=${value}\n`;
      length = next;
    }
  }
  // Legacy header placeholder says 0 bytes; the pax record carries the real
  // size. Framing must follow the pax size on both scan and extraction.
  const bytes = gzipSync(
    Buffer.concat([
      stripMarker(
        rawTarEntry("PaxHeader/big.bin", paxRecord("size", "5"), {
          type: "x",
        }),
      ),
      rawTarEntry("big.bin", "hello", { declaredSize: 0 }),
    ]),
  );
  const item = service.seed(
    { name: "pax-size.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const destination = join(scratch, "pax-size-out");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 0, result.stderr.text);
  assert.equal(await readFile(join(destination, "big.bin"), "utf8"), "hello");

  // A pax-declared size beyond the 100 GiB budget rejects up front with the
  // truthful budget reason, before any bytes land.
  const oversized = gzipSync(
    Buffer.concat([
      stripMarker(
        rawTarEntry(
          "PaxHeader/huge.bin",
          paxRecord("size", String(200 * 1024 ** 3)),
          { type: "x" },
        ),
      ),
      rawTarEntry("huge.bin", "", { declaredSize: 0 }),
    ]),
  );
  const big = service.seed(
    { name: "pax-oversize.tar.gz", archive: "tar.gz", size: oversized.length },
    oversized,
  );
  const bigDestination = join(scratch, "pax-oversize-out");
  const bigResult = await cli([
    "down",
    big.id,
    "--extract",
    "-o",
    bigDestination,
  ]);
  assert.equal(bigResult.code, 1);
  assert.match(bigResult.stderr.text, /declared uncompressed size/i);
  await assert.rejects(readFile(bigDestination), { code: "ENOENT" });
});

function rawPaxRecord(key: string, value: string): string {
  let length = key.length + value.length + 3;
  for (;;) {
    const next = String(length).length + key.length + value.length + 3;
    if (next === length) return `${length} ${key}=${value}\n`;
    length = next;
  }
}

test("extraction rejects nested .. hardlink targets in all override variants", async () => {
  const fixtures: Array<{ name: string; bytes: Buffer }> = [
    {
      name: "hard-regular.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("safe.txt", "safe")),
          rawTarEntry("dir/link", "", { type: "1", linkname: "../outside" }),
        ]),
      ),
    },
    {
      name: "hard-gnu.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("safe.txt", "safe")),
          stripMarker(
            rawTarEntry("././@LongLink", "../outside\0", { type: "K" }),
          ),
          rawTarEntry("dir/link", "", { type: "1", linkname: "placeholder" }),
        ]),
      ),
    },
    {
      name: "hard-pax-local.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("safe.txt", "safe")),
          stripMarker(
            rawTarEntry(
              "PaxHeader/link",
              rawPaxRecord("linkpath", "../outside"),
              { type: "x" },
            ),
          ),
          rawTarEntry("dir/link", "", { type: "1", linkname: "placeholder" }),
        ]),
      ),
    },
    {
      name: "hard-pax-global.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("safe.txt", "safe")),
          stripMarker(
            rawTarEntry("GlobalHead", rawPaxRecord("linkpath", "../outside"), {
              type: "g",
            }),
          ),
          rawTarEntry("dir/link", "", { type: "1", linkname: "placeholder" }),
        ]),
      ),
    },
  ];
  for (const fixture of fixtures) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, /unsafe link/i, fixture.name);
    // Never a partial destination: the pre-fix behavior published safe.txt
    // and silently dropped the hardlink.
    await assert.rejects(readFile(destination), { code: "ENOENT" });
    await assert.rejects(readFile(join(scratch, "outside")), {
      code: "ENOENT",
    });
  }
});

test("extraction rejects unmaterializable hardlink targets", async () => {
  const fixtures: Array<{ name: string; bytes: Buffer }> = [
    {
      name: "hard-missing.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("safe.txt", "safe")),
          rawTarEntry("link", "", { type: "1", linkname: "absent.txt" }),
        ]),
      ),
    },
    {
      name: "hard-forward.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry("link", "", { type: "1", linkname: "later.txt" }),
          ),
          rawTarEntry("later.txt", "content"),
        ]),
      ),
    },
    {
      name: "hard-cycle.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("l1", "", { type: "1", linkname: "l2" })),
          rawTarEntry("l2", "", { type: "1", linkname: "l1" }),
        ]),
      ),
    },
    {
      name: "hard-dir.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("d/", "", { type: "5" })),
          rawTarEntry("link", "", { type: "1", linkname: "d" }),
        ]),
      ),
    },
    {
      name: "hard-symlink.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("real.txt", "content")),
          stripMarker(
            rawTarEntry("s", "", { type: "2", linkname: "real.txt" }),
          ),
          rawTarEntry("link", "", { type: "1", linkname: "s" }),
        ]),
      ),
    },
  ];
  for (const fixture of fixtures) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, /hardlink target/i, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
});

test("extraction preserves an existing destination when a hardlink is rejected under --force", async () => {
  const destination = join(scratch, "keep-hardlink");
  await writeFile(destination, "existing content");
  const bytes = gzipSync(
    Buffer.concat([
      stripMarker(rawTarEntry("safe.txt", "safe")),
      rawTarEntry("dir/link", "", { type: "1", linkname: "../outside" }),
    ]),
  );
  const item = service.seed(
    { name: "hard-force.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const result = await cli([
    "down",
    item.id,
    "--extract",
    "-o",
    destination,
    "--force",
  ]);
  assert.equal(result.code, 1);
  assert.equal(await readFile(destination, "utf8"), "existing content");
});

test("a valid hardlink extracts completely, including chains", async () => {
  const bytes = gzipSync(
    Buffer.concat([
      stripMarker(rawTarEntry("a.txt", "content")),
      stripMarker(rawTarEntry("hard1", "", { type: "1", linkname: "a.txt" })),
      rawTarEntry("hard2", "", { type: "1", linkname: "hard1" }),
    ]),
  );
  const item = service.seed(
    { name: "hard-ok.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const destination = join(scratch, "hard-ok-out");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 0, result.stderr.text);
  // Every accepted entry must be materialized — no silent partial success.
  assert.equal(await readFile(join(destination, "a.txt"), "utf8"), "content");
  assert.equal(await readFile(join(destination, "hard1"), "utf8"), "content");
  assert.equal(await readFile(join(destination, "hard2"), "utf8"), "content");
});

test("extraction rejects non-portable Windows names and destination aliases", async () => {
  const unsafePaths: Array<{ name: string; entry: string }> = [
    { name: "device-plain.tar.gz", entry: "CON" },
    { name: "device-ext.tar.gz", entry: "nul.txt" },
    { name: "device-nested.tar.gz", entry: "dir/COM1.log" },
    { name: "device-super.tar.gz", entry: "com¹" },
    { name: "device-clock.tar.gz", entry: "CLOCK$" },
    { name: "ads.tar.gz", entry: "file:stream" },
    { name: "trailing-dot.tar.gz", entry: "name." },
    { name: "trailing-space.tar.gz", entry: "dir/trailing " },
    { name: "control.tar.gz", entry: "ctrl\u0007.txt" },
  ];
  for (const fixture of unsafePaths) {
    const bytes = gzipSync(rawTarEntry(fixture.entry, "x"));
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: bytes.length },
      bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, /unsafe path/i, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }

  // Device basename as a link target.
  const linkBytes = gzipSync(
    rawTarEntry("link", "", { type: "2", linkname: "NUL.txt" }),
  );
  const linkItem = service.seed(
    { name: "device-link.tar.gz", archive: "tar.gz", size: linkBytes.length },
    linkBytes,
  );
  const linkResult = await cli([
    "down",
    linkItem.id,
    "--extract",
    "-o",
    join(scratch, "device-link-out"),
  ]);
  assert.equal(linkResult.code, 1);
  assert.match(linkResult.stderr.text, /unsafe link/i);

  const collisions: Array<{ name: string; bytes: Buffer }> = [
    {
      name: "case-collision.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("File.txt", "a")),
          rawTarEntry("file.txt", "b"),
        ]),
      ),
    },
    {
      name: "nfc-nfd-collision.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("caf\u00e9.txt", "nfc")),
          rawTarEntry("cafe\u0301.txt", "nfd"),
        ]),
      ),
    },
    {
      name: "file-vs-parent.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("a", "file")),
          rawTarEntry("a/b.txt", "child"),
        ]),
      ),
    },
  ];
  for (const fixture of collisions) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, /conflicting/i, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
});

test("extraction keeps ordinary Unicode and device look-alike names", async () => {
  const bytes = gzipSync(
    Buffer.concat([
      stripMarker(rawTarEntry("résumé.txt", "unicode")),
      stripMarker(rawTarEntry("COM10.log", "not a device")),
      rawTarEntry("console.log", "fine"),
    ]),
  );
  const item = service.seed(
    { name: "ordinary.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const destination = join(scratch, "ordinary-out");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 0, result.stderr.text);
  assert.equal(
    await readFile(join(destination, "résumé.txt"), "utf8"),
    "unicode",
  );
  assert.equal(
    await readFile(join(destination, "COM10.log"), "utf8"),
    "not a device",
  );
});

test("extraction canonicalizes removable dot and empty segments", async () => {
  // `.` and empty segments are lexical no-ops the extractor collapses; the
  // scanner canonicalizes them the same way instead of rejecting.
  const accepted: Array<{ name: string; bytes: Buffer; check: string }> = [
    {
      name: "empty-entry-segment.tar.gz",
      bytes: gzipSync(rawTarEntry("dir//file.txt", "x")),
      check: "dir/file.txt",
    },
    {
      name: "dot-entry-segment.tar.gz",
      bytes: gzipSync(rawTarEntry("dir/./file.txt", "x")),
      check: "dir/file.txt",
    },
    {
      name: "dot-hardlink-segment.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("a/file.txt", "content")),
          rawTarEntry("hard", "", { type: "1", linkname: "a/./file.txt" }),
        ]),
      ),
      check: "hard",
    },
  ];
  for (const fixture of accepted) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      Buffer.from(fixture.bytes),
    );
    const destination = join(scratch, `${fixture.name}-out`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 0, `${fixture.name}: ${result.stderr.text}`);
    assert.ok(await readFile(join(destination, fixture.check)));
  }

  // A file spelled with a trailing slash and content is still invalid, and
  // a rejected archive never touches an existing --force destination.
  const bytes = gzipSync(rawTarEntry("regular.txt/", "x"));
  const item = service.seed(
    { name: "regular-trailing-separator.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const fresh = join(scratch, "trailing-separator-out");
  const rejected = await cli(["down", item.id, "--extract", "-o", fresh]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr.text, /unsafe path/i);
  await assert.rejects(readFile(fresh), { code: "ENOENT" });

  const existing = join(scratch, "keep-empty-segment");
  await writeFile(existing, "existing content");
  const forced = await cli([
    "down",
    item.id,
    "--extract",
    "-o",
    existing,
    "--force",
  ]);
  assert.equal(forced.code, 1);
  assert.equal(await readFile(existing, "utf8"), "existing content");
});

// Windows spells a stored relative symlink target with the host separator
// ("\") even when it was created with "/"; fold only the host separator back
// so the canonical archive spelling can be asserted. On POSIX `sep` is "/",
// so a literal backslash in a target stays visible and adversarial.
async function readlinkPortable(path: string): Promise<string> {
  const { readlink } = await import("node:fs/promises");
  return (await readlink(path)).split(sep).join("/");
}

test("extraction keeps the stock tar dot-root spelling for hardlinks and symlinks", async () => {
  const { stat: statFile } = await import("node:fs/promises");
  const bytes = gzipSync(
    Buffer.concat([
      stripMarker(rawTarEntry("./", "", { type: "5" })),
      stripMarker(rawTarEntry("./b.txt", "content")),
      stripMarker(rawTarEntry("./a.txt", "", { type: "1", linkname: "./b.txt" })),
      rawTarEntry("./link.txt", "", { type: "2", linkname: "./b.txt" }),
    ]),
  );
  const item = service.seed(
    { name: "dot-root.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const destination = join(scratch, "dot-root-out");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 0, result.stderr.text);
  assert.equal(await readFile(join(destination, "b.txt"), "utf8"), "content");
  const a = await statFile(join(destination, "a.txt"));
  const b = await statFile(join(destination, "b.txt"));
  assert.equal(a.ino, b.ino, "hardlink must share the inode");
  assert.equal(await readlinkPortable(join(destination, "link.txt")), "./b.txt");
});

test("a stock system tar archive of a dot root with hardlinks extracts", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { link, mkdir } = await import("node:fs/promises");
  const run = promisify(execFile);
  const source = await mkdtemp(join(scratch, "stock-tar-"));
  await writeFile(join(source, "b.txt"), "shared bytes");
  await link(join(source, "b.txt"), join(source, "a.txt"));
  await mkdir(join(source, "sub"));
  await symlink("../b.txt", join(source, "sub/rel.txt"));
  await symlink("./b.txt", join(source, "rel2.txt"));
  const archive = join(scratch, "stock-dot.tar.gz");
  await run("tar", ["-czf", archive, "-C", source, "."]);
  const bytes = await readFile(archive);
  const item = service.seed(
    { name: "stock-dot.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const destination = join(scratch, "stock-dot-out");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 0, result.stderr.text);
  const { stat: statFile } = await import("node:fs/promises");
  const a = await statFile(join(destination, "a.txt"));
  const b = await statFile(join(destination, "b.txt"));
  assert.equal(a.ino, b.ino);
  assert.equal(
    await readFile(join(destination, "sub/rel.txt"), "utf8"),
    "shared bytes",
  );
  assert.equal(
    await readFile(join(destination, "rel2.txt"), "utf8"),
    "shared bytes",
  );
});

test("a shipped-CLI recursive archive containing a ./ symlink round-trips", async () => {
  const source = await mkdtemp(join(scratch, "dot-symlink-src-"));
  await writeFile(join(source, "target.txt"), "pointed at");
  await symlink("./target.txt", join(source, "link.txt"));
  const uploaded = await cli(["up", "-r", source, "--json"]);
  assert.equal(uploaded.code, 0, uploaded.stderr.text);
  const [item] = JSON.parse(uploaded.stdout.text) as FileMetadata[];
  const destination = join(scratch, "dot-symlink-out");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 0, result.stderr.text);
  assert.equal(
    await readFile(join(destination, "target.txt"), "utf8"),
    "pointed at",
  );
  assert.equal(await readlinkPortable(join(destination, "link.txt")), "./target.txt");
});

test("extraction validates the real header path under a global pax path", async () => {
  // node-tar ignores a global pax `path`, so the raw header path is what
  // extracts — a benign global value must not mask a hostile header path.
  const fixtures: Array<{ name: string; bytes: Buffer; pattern: RegExp }> = [
    {
      name: "global-path-masks-device.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("d/", "", { type: "5" })),
          stripMarker(
            rawTarEntry("GlobalHead", rawPaxRecord("path", "d/"), {
              type: "g",
            }),
          ),
          rawTarEntry("CON.txt", ""),
        ]),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "global-path-masks-traversal.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry("GlobalHead", rawPaxRecord("path", "benign.txt"), {
              type: "g",
            }),
          ),
          rawTarEntry("../escape.txt", "x"),
        ]),
      ),
      pattern: /unsafe path/i,
    },
  ];
  for (const fixture of fixtures) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, fixture.pattern, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
  await assert.rejects(readFile(join(scratch, "escape.txt")), {
    code: "ENOENT",
  });

  // A hostile global path over a benign header path is inert (node-tar
  // never applies it) and must not block extraction of the header path.
  const inert = gzipSync(
    Buffer.concat([
      stripMarker(
        rawTarEntry("GlobalHead", rawPaxRecord("path", "../../outside"), {
          type: "g",
        }),
      ),
      rawTarEntry("inner.txt", "content"),
    ]),
  );
  const item = service.seed(
    { name: "global-path-inert.tar.gz", archive: "tar.gz", size: inert.length },
    inert,
  );
  const destination = join(scratch, "global-path-inert-out");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 0, result.stderr.text);
  assert.equal(await readFile(join(destination, "inner.txt"), "utf8"), "content");
});

test("extraction applies node-tar's global-over-local linkpath precedence", async () => {
  const { readlink } = await import("node:fs/promises");
  // Hostile global linkpath masked by a benign local one must reject: the
  // extractor publishes the GLOBAL value.
  const masked = gzipSync(
    Buffer.concat([
      stripMarker(rawTarEntry("safe.txt", "content")),
      stripMarker(
        rawTarEntry("GlobalHead", rawPaxRecord("linkpath", "NUL.txt"), {
          type: "g",
        }),
      ),
      stripMarker(
        rawTarEntry("PaxHeader/link", rawPaxRecord("linkpath", "safe.txt"), {
          type: "x",
        }),
      ),
      rawTarEntry("link", "", { type: "2", linkname: "safe.txt" }),
    ]),
  );
  const maskedItem = service.seed(
    { name: "global-linkpath-mask.tar.gz", archive: "tar.gz", size: masked.length },
    masked,
  );
  const maskedOut = join(scratch, "global-linkpath-mask-out");
  const maskedResult = await cli([
    "down",
    maskedItem.id,
    "--extract",
    "-o",
    maskedOut,
  ]);
  assert.equal(maskedResult.code, 1);
  assert.match(maskedResult.stderr.text, /unsafe link/i);
  await assert.rejects(readFile(maskedOut), { code: "ENOENT" });

  // Positive control: the published symlink target is the global value.
  const positive = gzipSync(
    Buffer.concat([
      stripMarker(rawTarEntry("real.txt", "real")),
      stripMarker(rawTarEntry("other.txt", "other")),
      stripMarker(
        rawTarEntry("GlobalHead", rawPaxRecord("linkpath", "real.txt"), {
          type: "g",
        }),
      ),
      rawTarEntry("link", "", { type: "2", linkname: "other.txt" }),
    ]),
  );
  const positiveItem = service.seed(
    { name: "global-linkpath-wins.tar.gz", archive: "tar.gz", size: positive.length },
    positive,
  );
  const positiveOut = join(scratch, "global-linkpath-wins-out");
  const positiveResult = await cli([
    "down",
    positiveItem.id,
    "--extract",
    "-o",
    positiveOut,
  ]);
  assert.equal(positiveResult.code, 0, positiveResult.stderr.text);
  assert.equal(await readlink(join(positiveOut, "link")), "real.txt");
});

test("extraction rejects empty symlink targets before staging", async () => {
  const fixtures: Array<{ name: string; bytes: Buffer }> = [
    {
      name: "empty-symlink.tar.gz",
      bytes: gzipSync(rawTarEntry("link", "", { type: "2" })),
    },
    {
      name: "pax-only-symlink-target.tar.gz",
      // node-tar refuses a link entry whose RAW linkpath is empty even when
      // a pax record supplies one ("linkpath required").
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("real.txt", "content")),
          stripMarker(
            rawTarEntry("PaxHeader/link", rawPaxRecord("linkpath", "real.txt"), {
              type: "x",
            }),
          ),
          rawTarEntry("link", "", { type: "2" }),
        ]),
      ),
    },
  ];
  for (const fixture of fixtures) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, /empty link target/i, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
});

test("extraction resolves composed symlink chains over the final manifest", async () => {
  const { readlink } = await import("node:fs/promises");
  const rejects: Array<{ name: string; bytes: Buffer; pattern: RegExp }> = [
    {
      name: "composed-escape.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("d/", "", { type: "5" })),
          stripMarker(rawTarEntry("d/s1", "", { type: "2", linkname: ".." })),
          rawTarEntry("d/s2", "", { type: "2", linkname: "s1/../.." }),
        ]),
      ),
      pattern: /outside the extraction root/i,
    },
    {
      name: "symlink-self-loop.tar.gz",
      bytes: gzipSync(rawTarEntry("s", "", { type: "2", linkname: "s" })),
      pattern: /symlink (cycle|chain)/i,
    },
    {
      name: "symlink-pair-loop.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("a", "", { type: "2", linkname: "b" })),
          rawTarEntry("b", "", { type: "2", linkname: "a" }),
        ]),
      ),
      pattern: /symlink (cycle|chain)|cannot materialize/i,
    },
    {
      name: "through-file.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("f.txt", "content")),
          rawTarEntry("s", "", { type: "2", linkname: "f.txt/x" }),
        ]),
      ),
      pattern: /non-directory/i,
    },
    {
      name: "chain-target-declared-earlier.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("real.txt", "content")),
          stripMarker(rawTarEntry("s1", "", { type: "2", linkname: "real.txt" })),
          rawTarEntry("s2", "", { type: "2", linkname: "s1" }),
        ]),
      ),
      pattern: /cannot materialize/i,
    },
  ];
  for (const fixture of rejects) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, fixture.pattern, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }

  // Contained chain in extractor-creatable order (s2 precedes s1) extracts
  // and resolves inside the destination.
  const chain = gzipSync(
    Buffer.concat([
      stripMarker(rawTarEntry("real.txt", "chained")),
      stripMarker(rawTarEntry("s2", "", { type: "2", linkname: "s1" })),
      rawTarEntry("s1", "", { type: "2", linkname: "real.txt" }),
    ]),
  );
  const chainItem = service.seed(
    { name: "contained-chain.tar.gz", archive: "tar.gz", size: chain.length },
    chain,
  );
  const chainOut = join(scratch, "contained-chain-out");
  const chainResult = await cli([
    "down",
    chainItem.id,
    "--extract",
    "-o",
    chainOut,
  ]);
  assert.equal(chainResult.code, 0, chainResult.stderr.text);
  assert.equal(await readlink(join(chainOut, "s2")), "s1");
  assert.equal(await readFile(join(chainOut, "s2"), "utf8"), "chained");

  // Dangling but contained targets stay valid.
  const dangling = gzipSync(
    rawTarEntry("link", "", { type: "2", linkname: "absent.txt" }),
  );
  const danglingItem = service.seed(
    { name: "dangling.tar.gz", archive: "tar.gz", size: dangling.length },
    dangling,
  );
  const danglingOut = join(scratch, "dangling-out");
  const danglingResult = await cli([
    "down",
    danglingItem.id,
    "--extract",
    "-o",
    danglingOut,
  ]);
  assert.equal(danglingResult.code, 0, danglingResult.stderr.text);
  assert.equal(await readlink(join(danglingOut, "link")), "absent.txt");
});

test("extraction rejects non-zero entry content padding without touching destinations", async () => {
  // 1 content byte, hostile 0x41 fill through the remaining 511 padding
  // bytes of the content record.
  const entry = stripMarker(rawTarEntry("pad.txt", "A"));
  entry.fill(0x41, 513);
  const bytes = gzipSync(Buffer.concat([entry, Buffer.alloc(1024)]));
  const item = service.seed(
    { name: "nonzero-padding.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const fresh = join(scratch, "nonzero-padding-out");
  const result = await cli(["down", item.id, "--extract", "-o", fresh]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.text, /entry padding/i);
  await assert.rejects(readFile(fresh), { code: "ENOENT" });

  const existing = join(scratch, "keep-padding");
  await writeFile(existing, "existing content");
  const forced = await cli([
    "down",
    item.id,
    "--extract",
    "-o",
    existing,
    "--force",
  ]);
  assert.equal(forced.code, 1);
  assert.equal(await readFile(existing, "utf8"), "existing content");
});

// Second line of defense behind the strict scan: extraction publishes only
// when every scanner-accepted entry actually materialized. node-tar runs in
// strict mode with warnings made fatal, and the staged tree is verified
// against the scan manifest before the atomic rename.
test("the extraction warning guard makes every node-tar warning fatal", async () => {
  const extract = await import("../src/extract.js");
  const candidate = (extract as unknown as Record<string, unknown>)[
    "throwIfExtractionWarnings"
  ];
  assert.equal(typeof candidate, "function");
  const guard = candidate as (warnings: string[]) => void;
  assert.throws(
    () => guard(["TAR_ENTRY_ERROR: skipped hardlink"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /reported warnings/i);
      assert.match(error.message, /TAR_ENTRY_ERROR/);
      return true;
    },
  );
  guard([]);
});

test("the extraction completeness guard rejects a staging tree missing a manifest entry", async () => {
  const extract = await import("../src/extract.js");
  assert.equal(typeof extract.verifyExtractionCompleteness, "function");
  const staging = await mkdtemp(join(scratch, "completeness-"));
  await writeFile(join(staging, "present.txt"), "x");
  await extract.verifyExtractionCompleteness(staging, ["present.txt"]);
  await assert.rejects(
    extract.verifyExtractionCompleteness(staging, [
      "present.txt",
      "missing/entry.txt",
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /missing\/entry\.txt/);
      return true;
    },
  );
});

test("the completeness guard rejects staging entries the scanner never declared", async () => {
  const extract = await import("../src/extract.js");
  const staging = await mkdtemp(join(scratch, "exactness-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(staging, "a"));
  await writeFile(join(staging, "a", "b.txt"), "x");
  // Implicit parent directories of declared entries are expected.
  await extract.verifyExtractionCompleteness(staging, ["a/b.txt"]);
  // An extra file the scanner never saw must reject: a stream the extractor
  // interprets differently than the scanner cannot publish silently.
  await writeFile(join(staging, "smuggled.txt"), "x");
  await assert.rejects(
    extract.verifyExtractionCompleteness(staging, ["a/b.txt"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /undeclared/i);
      assert.match(error.message, /smuggled\.txt/);
      return true;
    },
  );
});

test("--force replacement survives an injected publish-rename failure", async () => {
  const extract = await import("../src/extract.js");
  const { readdir } = await import("node:fs/promises");
  const bytes = gzipSync(rawTarEntry("inside.txt", "new content"));
  const archivePath = join(scratch, "force-publish.tar.gz");
  await writeFile(archivePath, bytes);
  const room = await mkdtemp(join(scratch, "force-room-"));
  const destination = join(room, "dest");
  await writeFile(destination, "old content");

  let calls = 0;
  await assert.rejects(
    extract.extractArchive(archivePath, destination, true, {
      publishRename: async (from: string, to: string) => {
        calls += 1;
        throw Object.assign(new Error("injected rename failure"), {
          code: "EIO",
          from,
          to,
        });
      },
    }),
    /injected rename failure/,
  );
  assert.equal(calls, 1);
  // The old destination is restored, and nothing else is left beside it.
  assert.equal(await readFile(destination, "utf8"), "old content");
  assert.deepEqual(await readdir(room), ["dest"]);

  // Without injection the same replacement succeeds.
  await extract.extractArchive(archivePath, destination, true);
  assert.equal(
    await readFile(join(destination, "inside.txt"), "utf8"),
    "new content",
  );
  assert.deepEqual(await readdir(room), ["dest"]);
});

test("--force keeps the new destination when backup removal fails, then recovers", async () => {
  const extract = await import("../src/extract.js");
  const { readdir } = await import("node:fs/promises");
  const bytes = gzipSync(rawTarEntry("inside.txt", "new content"));
  const archivePath = join(scratch, "force-rmfail.tar.gz");
  await writeFile(archivePath, bytes);
  const room = await mkdtemp(join(scratch, "rmfail-room-"));
  const destination = join(room, "dest");
  await writeFile(destination, "old content");

  await assert.rejects(
    extract.extractArchive(archivePath, destination, true, {
      removeBackup: async () => {
        throw Object.assign(new Error("injected remove failure"), {
          code: "EIO",
        });
      },
    }),
    /injected remove failure/,
  );
  // Publish already happened: the new content is live, the backup remains.
  assert.equal(
    await readFile(join(destination, "inside.txt"), "utf8"),
    "new content",
  );
  const leftovers = (await readdir(room)).filter((name) =>
    name.includes(".fs-backup-"),
  );
  assert.equal(leftovers.length, 1);
  assert.equal(
    await readFile(join(room, leftovers[0]!, "previous"), "utf8"),
    "old content",
  );

  // The next invocation detects the leftover backup and cleans it up.
  const again = join(room, "second-out");
  await extract.extractArchive(archivePath, join(room, "dest"), true);
  assert.deepEqual(await readdir(room), ["dest"]);
  await extract.extractArchive(archivePath, again, false);
  assert.equal(
    await readFile(join(again, "inside.txt"), "utf8"),
    "new content",
  );
});

test("a crash between backup and publish is recovered on the next invocation", async () => {
  const extract = await import("../src/extract.js");
  const { mkdir, readdir } = await import("node:fs/promises");
  const bytes = gzipSync(rawTarEntry("inside.txt", "new content"));
  const archivePath = join(scratch, "force-crash.tar.gz");
  await writeFile(archivePath, bytes);
  const room = await mkdtemp(join(scratch, "crash-room-"));
  // Simulated crash state: the destination was moved to its unique backup
  // and the process died before the staging rename.
  const backupRoot = join(room, ".dest.fs-backup-abc123");
  await mkdir(backupRoot);
  await writeFile(join(backupRoot, "previous"), "old content");

  // Without --force: recovery restores the old destination, then the
  // ordinary exists-check refuses to replace it.
  const refused = await (async () => {
    try {
      await extract.extractArchive(archivePath, join(room, "dest"), false);
      return null;
    } catch (error) {
      return error as Error;
    }
  })();
  assert.ok(refused);
  assert.match(refused.message, /already exists/i);
  assert.equal(await readFile(join(room, "dest"), "utf8"), "old content");
  assert.deepEqual(await readdir(room), ["dest"]);

  // With --force after another simulated crash: recovery restores, then the
  // replacement proceeds and leaves no backup behind.
  const backupRoot2 = join(room, ".dest.fs-backup-def456");
  await mkdir(backupRoot2);
  await rm(join(room, "dest"));
  await writeFile(join(backupRoot2, "previous"), "old content");
  await extract.extractArchive(archivePath, join(room, "dest"), true);
  assert.equal(
    await readFile(join(room, "dest", "inside.txt"), "utf8"),
    "new content",
  );
  assert.deepEqual(await readdir(room), ["dest"]);
});

test("extraction fails cleanly on garbage bytes marked archive=tar.gz", async () => {
  const item = service.seed(
    { name: "garbage.tar.gz", archive: "tar.gz", size: 24 },
    Buffer.from("definitely not a tar.gz!"),
  );
  const destination = join(scratch, "garbage-destination");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.notEqual(result.code, 0);
  await assert.rejects(readFile(destination), { code: "ENOENT" });
});

test("multi-object operations return partial-success status 8", async () => {
  const item = service.seed({ name: "one.txt" });
  const output = await mkdtemp(join(scratch, "multi-down-"));
  const result = await cli(["down", item.id, "Zz99999", "-o", output]);
  assert.equal(result.code, 8);
  assert.equal(await readFile(join(output, "one.txt"), "utf8"), "seed");
  assert.match(result.stderr.text, /missing/);
});

test("HTTP auth, missing metadata, and network failures map to stable exit codes", async () => {
  const auth = await cli(["list"], "", { FS_TOKEN: "wrong" });
  assert.equal(auth.code, 3);
  const missing = await cli(["info", "Zz99999"]);
  assert.equal(missing.code, 4);
  const network = await cli(["list"], "", { FS_URL: "http://127.0.0.1:1" });
  assert.equal(network.code, 6);
});

// node-tar reads a pax payload line by line (pax.js `parseKV`), never by the
// length framing, so one length-framed record can hide a second self-
// consistent pax line inside its own value. The scanner must read the payload
// exactly as the extractor does, or it certifies destinations it never saw.
function hidingPaxRecord(outerKey: string, hidden: string): string {
  return rawPaxRecord(outerKey, `${"J".repeat(24)}\n${hidden.slice(0, -1)}`);
}

test("real node-tar honors a pax record hidden inside another record's value", async () => {
  // Executable proof of the vector the scanner must fail closed on: node-tar
  // publishes link -> COM1.log although the only length-framed record is an
  // ignored FSAUDIT key.
  const bytes = gzipSync(
    Buffer.concat([
      stripMarker(rawTarEntry("safe.txt", "safe")),
      stripMarker(
        rawTarEntry(
          "PaxHeader/link",
          hidingPaxRecord("FSAUDIT", rawPaxRecord("linkpath", "COM1.log")),
          { type: "x" },
        ),
      ),
      rawTarEntry("link", "", { type: "2", linkname: "safe.txt" }),
    ]),
  );
  const { mkdir, readlink } = await import("node:fs/promises");
  const { scanTarGzArchive } = await import("../src/tar-scan.js");
  const room = await mkdtemp(join(scratch, "hidden-pax-real-"));
  const archivePath = join(room, "a.tar.gz");
  await writeFile(archivePath, bytes);
  const out = join(room, "out");
  await mkdir(out);
  await tar.extract({ file: archivePath, cwd: out, preservePaths: false, strict: true });
  assert.equal(await readlink(join(out, "link")), "COM1.log");

  // The shipped scanner therefore must refuse the same bytes.
  await assert.rejects(scanTarGzArchive(archivePath, bytes.length), (error: unknown) => {
    assert.match((error as Error).message, /pax metadata/i);
    return true;
  });
});

test("extraction refuses pax payloads that hide a second record, publishing nothing", async () => {
  const fixtures: Array<{ name: string; bytes: Buffer }> = [
    {
      name: "hidden-linkpath-local.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("safe.txt", "safe")),
          stripMarker(
            rawTarEntry(
              "PaxHeader/link",
              hidingPaxRecord("FSAUDIT", rawPaxRecord("linkpath", "COM1.log")),
              { type: "x" },
            ),
          ),
          rawTarEntry("link", "", { type: "2", linkname: "safe.txt" }),
        ]),
      ),
    },
    {
      name: "hidden-linkpath-global.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("safe.txt", "safe")),
          stripMarker(
            rawTarEntry(
              "GlobalHead",
              hidingPaxRecord("FSAUDIT", rawPaxRecord("linkpath", "NUL.txt")),
              { type: "g" },
            ),
          ),
          rawTarEntry("link", "", { type: "2", linkname: "safe.txt" }),
        ]),
      ),
    },
    {
      name: "hidden-path-local.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry(
              "PaxHeader/x",
              hidingPaxRecord("FSAUDIT", rawPaxRecord("path", "CON.txt")),
              { type: "x" },
            ),
          ),
          rawTarEntry("benign.txt", "b"),
        ]),
      ),
    },
    {
      name: "hidden-path-duplicate-destination.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("one.txt", "AAAA")),
          stripMarker(
            rawTarEntry(
              "PaxHeader/two.txt",
              hidingPaxRecord("FSAUDIT", rawPaxRecord("path", "one.txt")),
              { type: "x" },
            ),
          ),
          rawTarEntry("two.txt", "BBBB"),
        ]),
      ),
    },
    {
      name: "hidden-size.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry(
              "PaxHeader/f.txt",
              hidingPaxRecord("FSAUDIT", rawPaxRecord("size", "1024")),
              { type: "x" },
            ),
          ),
          rawTarEntry("f.txt", "0123456789"),
        ]),
      ),
    },
    {
      name: "pax-embedded-nul.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry("PaxHeader/x", rawPaxRecord("path", "benign.txt\0CON"), {
              type: "x",
            }),
          ),
          rawTarEntry("placeholder.txt", "b"),
        ]),
      ),
    },
  ];
  for (const fixture of fixtures) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, /pax metadata/i, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
});

test("valid pax framing, duplicate precedence, and size semantics still extract", async () => {
  const bytes = gzipSync(
    Buffer.concat([
      stripMarker(
        rawTarEntry(
          "PaxHeader/x",
          rawPaxRecord("path", "dir/renamed.txt") +
            rawPaxRecord("mtime", "1700000000.5") +
            rawPaxRecord("uname", "admin") +
            rawPaxRecord("path", "dir/final.txt"),
          { type: "x" },
        ),
      ),
      rawTarEntry("placeholder.txt", "hello"),
    ]),
  );
  const item = service.seed(
    { name: "valid-pax.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const destination = join(scratch, "valid-pax-out");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 0, result.stderr.text);
  // Last duplicate record wins, exactly as node-tar's reduce does.
  assert.equal(await readFile(join(destination, "dir", "final.txt"), "utf8"), "hello");
});

// A backslash is an ordinary POSIX filename character (node-tar's
// normalize-windows-path is the identity off Windows) but a separator on
// Windows. Rewriting it to "/" made the scanner derive a manifest path the
// extractor never publishes, so an archive the shipped CLI itself produced
// scanned clean and then failed with a misleading "incomplete extraction".
test("a backslash filename is rejected truthfully, not mis-normalized", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { scanTarGzArchive } = await import("../src/tar-scan.js");
  // A literal-backslash filename cannot exist on a Windows filesystem (the
  // backslash is a separator there), so the shipped-CLI upload of a real tree
  // is exercised only off Windows; on Windows the same canonical archive is
  // built from raw tar bytes carrying the literal name.
  let stored: Buffer;
  let itemId: string;
  if (process.platform === "win32") {
    stored = gzipSync(rawTarEntry("back\\slash.txt", "literal"));
    itemId = service.seed(
      { name: "backslash.tar.gz", archive: "tar.gz", size: stored.length },
      stored,
    ).id;
  } else {
    const source = await mkdtemp(join(scratch, "backslash-source-"));
    await writeFile(join(source, "back\\slash.txt"), "literal");
    const uploaded = await cli(["up", "-r", source, "--json"]);
    assert.equal(uploaded.code, 0, uploaded.stderr.text);
    const [item] = JSON.parse(uploaded.stdout.text) as FileMetadata[];
    itemId = item.id;
    stored = service.files.get(item.id)!.body;
  }

  const room = await mkdtemp(join(scratch, "backslash-real-"));
  const archivePath = join(room, "a.tar.gz");
  await writeFile(archivePath, stored);
  const out = join(room, "out");
  await mkdir(out);
  await tar.extract({ file: archivePath, cwd: out, preservePaths: false, strict: true });
  if (process.platform === "win32") {
    // Real node-tar rewrites the backslash into a separator on Windows: the
    // published tree diverges from the literal archive name, so no single
    // manifest spelling could be truthful on every platform.
    assert.equal(await readFile(join(out, "back", "slash.txt"), "utf8"), "literal");
  } else {
    // Real node-tar publishes the literal name, so a "/"-normalized manifest
    // path could never be materialized.
    assert.equal(await readFile(join(out, "back\\slash.txt"), "utf8"), "literal");
  }

  // The scanner refuses it up front with an accurate reason.
  await assert.rejects(scanTarGzArchive(archivePath, stored.length), (error: unknown) => {
    assert.match((error as Error).message, /unsafe path \(backslash/i);
    return true;
  });
  const destination = join(scratch, "backslash-destination");
  const result = await cli(["down", itemId, "--extract", "-o", destination]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.text, /unsafe path \(backslash/i);
  assert.doesNotMatch(result.stderr.text, /incomplete/i);
  await assert.rejects(readFile(destination), { code: "ENOENT" });
});

test("backslashes in raw link targets and every override form reject without publishing", async () => {
  const fixtures: Array<{ name: string; bytes: Buffer; pattern: RegExp }> = [
    {
      name: "raw-backslash-path.tar.gz",
      bytes: gzipSync(rawTarEntry("dir/back\\slash.txt", "x")),
      pattern: /unsafe path \(backslash/i,
    },
    {
      name: "raw-backslash-symlink.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("target.txt", "x")),
          rawTarEntry("link", "", { type: "2", linkname: "back\\slash.txt" }),
        ]),
      ),
      pattern: /unsafe link \(backslash/i,
    },
    {
      name: "raw-backslash-hardlink.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("target.txt", "x")),
          rawTarEntry("hard", "", { type: "1", linkname: "dir\\target.txt" }),
        ]),
      ),
      pattern: /unsafe link \(backslash/i,
    },
    {
      name: "gnu-longpath-backslash.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("././@LongLink", "dir/back\\slash.txt\0", { type: "L" })),
          rawTarEntry("placeholder.txt", "x"),
        ]),
      ),
      pattern: /unsafe path \(backslash/i,
    },
    {
      name: "gnu-longlink-backslash.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("target.txt", "x")),
          stripMarker(rawTarEntry("././@LongLink", "back\\slash.txt\0", { type: "K" })),
          rawTarEntry("link", "", { type: "2", linkname: "placeholder" }),
        ]),
      ),
      pattern: /unsafe link \(backslash/i,
    },
    {
      name: "pax-local-path-backslash.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry("PaxHeader/x", rawPaxRecord("path", "dir/back\\slash.txt"), {
              type: "x",
            }),
          ),
          rawTarEntry("placeholder.txt", "x"),
        ]),
      ),
      pattern: /unsafe path \(backslash/i,
    },
    {
      name: "pax-global-linkpath-backslash.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("target.txt", "x")),
          stripMarker(
            rawTarEntry("GlobalHead", rawPaxRecord("linkpath", "back\\slash.txt"), {
              type: "g",
            }),
          ),
          rawTarEntry("link", "", { type: "2", linkname: "target.txt" }),
        ]),
      ),
      pattern: /unsafe link \(backslash/i,
    },
  ];
  for (const fixture of fixtures) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, fixture.pattern, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
});

// node-tar joins the ustar `prefix` field only when the magic+version field
// is exactly "ustar\u000000" (dist/esm/header.js). A prefix taken from a
// non-ustar header invents a manifest path the extractor never publishes.
test("the ustar prefix is applied exactly when node-tar applies it", async () => {
  // Old-GNU magic with non-zero prefix bytes: node-tar publishes inner.txt,
  // so the manifest must say inner.txt and extraction must succeed.
  const ignored = gzipSync(
    rawTarEntry("inner.txt", "x", { magic: "ustar  \0", prefix: "00000000000" }),
  );
  const ignoredItem = service.seed(
    { name: "nonustar-prefix.tar.gz", archive: "tar.gz", size: ignored.length },
    ignored,
  );
  const ignoredOut = join(scratch, "nonustar-prefix-out");
  const ignoredResult = await cli(["down", ignoredItem.id, "--extract", "-o", ignoredOut]);
  assert.equal(ignoredResult.code, 0, ignoredResult.stderr.text);
  assert.equal(await readFile(join(ignoredOut, "inner.txt"), "utf8"), "x");
  assert.deepEqual(await (await import("node:fs/promises")).readdir(ignoredOut), [
    "inner.txt",
  ]);

  // A real ustar prefix still applies.
  const applied = gzipSync(rawTarEntry("inner.txt", "y", { prefix: "outer" }));
  const appliedItem = service.seed(
    { name: "ustar-prefix.tar.gz", archive: "tar.gz", size: applied.length },
    applied,
  );
  const appliedOut = join(scratch, "ustar-prefix-out");
  const appliedResult = await cli(["down", appliedItem.id, "--extract", "-o", appliedOut]);
  assert.equal(appliedResult.code, 0, appliedResult.stderr.text);
  assert.equal(await readFile(join(appliedOut, "outer", "inner.txt"), "utf8"), "y");

  // Two headers that really extract to the same destination collide, and
  // nothing is published.
  const colliding = gzipSync(
    Buffer.concat([
      stripMarker(rawTarEntry("inner.txt", "a")),
      rawTarEntry("inner.txt", "b", { magic: "ustar  \0", prefix: "00000000000" }),
    ]),
  );
  const collideItem = service.seed(
    { name: "prefix-collision.tar.gz", archive: "tar.gz", size: colliding.length },
    colliding,
  );
  const collideOut = join(scratch, "prefix-collision-out");
  const collideResult = await cli(["down", collideItem.id, "--extract", "-o", collideOut]);
  assert.equal(collideResult.code, 1);
  assert.match(collideResult.stderr.text, /conflicting entry paths/i);
  await assert.rejects(readFile(collideOut), { code: "ENOENT" });
});

// No benign value may hide a hostile one: every override node-tar could
// apply is validated in its own right, and a masked raw header field must
// still be contained.
test("hostile values cannot be masked by benign overrides, and nothing is published", async () => {
  const fixtures: Array<{ name: string; bytes: Buffer; pattern: RegExp }> = [
    {
      name: "masked-gnu-longpath.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("././@LongLink", "../escape.txt\0", { type: "L" })),
          stripMarker(
            rawTarEntry("PaxHeader/x", rawPaxRecord("path", "benign.txt"), { type: "x" }),
          ),
          rawTarEntry("placeholder.txt", "x"),
        ]),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "masked-nonportable-gnu-longpath.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("././@LongLink", "dir/CON.txt\0", { type: "L" })),
          stripMarker(
            rawTarEntry("PaxHeader/x", rawPaxRecord("path", "benign.txt"), { type: "x" }),
          ),
          rawTarEntry("placeholder.txt", "x"),
        ]),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "masked-raw-traversal.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry("PaxHeader/x", rawPaxRecord("path", "benign.txt"), { type: "x" }),
          ),
          rawTarEntry("../escape.txt", "x"),
        ]),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "masked-local-linkpath.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("safe.txt", "x")),
          stripMarker(
            rawTarEntry("GlobalHead", rawPaxRecord("linkpath", "safe.txt"), { type: "g" }),
          ),
          stripMarker(
            rawTarEntry("PaxHeader/link", rawPaxRecord("linkpath", "../../out"), {
              type: "x",
            }),
          ),
          rawTarEntry("link", "", { type: "2", linkname: "raw.txt" }),
        ]),
      ),
      pattern: /unsafe link/i,
    },
    {
      name: "masked-raw-linkname.tar.gz",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("safe.txt", "x")),
          stripMarker(
            rawTarEntry("PaxHeader/link", rawPaxRecord("linkpath", "safe.txt"), {
              type: "x",
            }),
          ),
          rawTarEntry("link", "", { type: "2", linkname: "../../outside" }),
        ]),
      ),
      pattern: /unsafe link/i,
    },
  ];
  for (const fixture of fixtures) {
    const item = service.seed(
      { name: fixture.name, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(scratch, `${fixture.name}-destination`);
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, `${fixture.name} must fail`);
    assert.match(result.stderr.text, fixture.pattern, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
});

test("a long name written by the shipped archiver still round-trips", async () => {
  // node-tar writes a 100-byte truncation of the real name into the raw
  // header field beside the pax `path` record; that truncation can land on a
  // trailing dot, so the raw field must not face the portable-name policy.
  const source = await mkdtemp(join(scratch, "longname-source-"));
  const longName = `${"segment.".repeat(14)}report.name.txt`;
  await writeFile(join(source, longName), "long");
  const uploaded = await cli(["up", "-r", source, "--json"]);
  assert.equal(uploaded.code, 0, uploaded.stderr.text);
  const [item] = JSON.parse(uploaded.stdout.text) as FileMetadata[];
  const destination = join(scratch, "longname-out");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 0, result.stderr.text);
  assert.equal(await readFile(join(destination, longName), "utf8"), "long");
});

// Two leftover backups can only coexist after two crashes or two concurrent
// runs against the same destination. Restoring whichever `readdir` returned
// first — and deleting the other — would destroy real data on a coin flip,
// so the ambiguity is refused instead.
test("multiple leftover backups fail closed instead of guessing", async () => {
  const extract = await import("../src/extract.js");
  const { mkdir, readdir } = await import("node:fs/promises");
  const room = await mkdtemp(join(scratch, "ambiguous-backup-"));
  const archivePath = join(room, "a.tar.gz");
  await writeFile(
    archivePath,
    gzipSync(rawTarEntry("inside.txt", "new content")),
  );
  for (const suffix of ["abc123", "def456"]) {
    const backupRoot = join(room, `.dest.fs-backup-${suffix}`);
    await mkdir(backupRoot);
    await writeFile(join(backupRoot, "previous"), `old ${suffix}`);
  }

  for (const force of [false, true]) {
    const failure = await extract
      .extractArchive(archivePath, join(room, "dest"), force)
      .then(() => null, (error: Error) => error);
    assert.ok(failure, `--force=${force} must fail closed`);
    assert.match(failure.message, /multiple leftover backups/i);
    // Nothing restored, nothing deleted, nothing published.
    assert.deepEqual((await readdir(room)).sort(), [
      ".dest.fs-backup-abc123",
      ".dest.fs-backup-def456",
      "a.tar.gz",
    ]);
    assert.equal(
      await readFile(join(room, ".dest.fs-backup-abc123", "previous"), "utf8"),
      "old abc123",
    );
    assert.equal(
      await readFile(join(room, ".dest.fs-backup-def456", "previous"), "utf8"),
      "old def456",
    );
  }

  // With the ambiguity resolved down to one backup, recovery proceeds.
  await rm(join(room, ".dest.fs-backup-def456"), { recursive: true });
  await extract.extractArchive(archivePath, join(room, "dest"), true);
  assert.equal(
    await readFile(join(room, "dest", "inside.txt"), "utf8"),
    "new content",
  );
  assert.deepEqual((await readdir(room)).sort(), ["a.tar.gz", "dest"]);
});

// Path-only completeness cannot see a symlink whose TARGET the extractor
// resolved differently than the scanner did, and a published link target is
// exactly what the portable-name and containment policy is about. The staged
// tree is therefore checked against the declared targets too.
test("staged symlink targets must match the scan manifest exactly", async () => {
  const extract = await import("../src/extract.js");
  const { mkdir, symlink } = await import("node:fs/promises");
  const staging = await mkdtemp(join(scratch, "link-verify-"));
  await mkdir(join(staging, "dir"));
  await writeFile(join(staging, "dir", "real.txt"), "x");
  await symlink("real.txt", join(staging, "dir", "link"));

  await extract.verifyExtractionCompleteness(
    staging,
    ["dir/real.txt", "dir/link"],
    [{ path: "dir/link", target: "real.txt" }],
  );
  await assert.rejects(
    extract.verifyExtractionCompleteness(
      staging,
      ["dir/real.txt", "dir/link"],
      [{ path: "dir/link", target: "COM1.log" }],
    ),
    (error: unknown) => {
      assert.match((error as Error).message, /link target/i);
      return true;
    },
  );
});

test("a scanned archive reports its symlink targets in the manifest", async () => {
  const { scanTarGzArchive } = await import("../src/tar-scan.js");
  const room = await mkdtemp(join(scratch, "link-manifest-"));
  const archivePath = join(room, "a.tar.gz");
  const bytes = gzipSync(
    Buffer.concat([
      stripMarker(rawTarEntry("dir/real.txt", "x")),
      rawTarEntry("dir/link", "", { type: "2", linkname: "real.txt" }),
    ]),
  );
  await writeFile(archivePath, bytes);
  const manifest = await scanTarGzArchive(archivePath, bytes.length);
  assert.deepEqual(manifest.entries, ["dir/real.txt", "dir/link"]);
  assert.deepEqual(manifest.links, [{ path: "dir/link", target: "real.txt" }]);
});

// node-tar reads every header string field with `decString`
// (dist/esm/header.js): `.toString("utf8").replace(/\0.*/, "")`. The regex is
// non-global and `.` never matches a line terminator, so only the run from
// the FIRST NUL to the next LF/CR/U+2028/U+2029 is dropped — everything after
// that terminator survives into the path or link target node-tar actually
// publishes. Decoding as a C string let a benign prefix hide a hostile suffix
// from the whole policy and made the manifest disagree with the real tree.
// The GNU `L`/`K` payload gets the same rule (dist/esm/parse.js `[EMITMETA]`).

// A 100-byte field: `prefix`, a NUL, a line terminator, then a suffix a
// C-string decoder discards but node-tar keeps.
function nulHiddenField(
  prefix: string,
  separator: string,
  suffix: string,
  fill = 0x59,
): Buffer {
  const field = Buffer.alloc(100, fill);
  Buffer.from(`${prefix}\0${separator}${suffix}`, "utf8").copy(field);
  return field;
}

async function scanBytes(bytes: Buffer, label: string) {
  const { scanTarGzArchive } = await import("../src/tar-scan.js");
  const room = await mkdtemp(join(scratch, `${label}-`));
  const archivePath = join(room, "a.tar.gz");
  await writeFile(archivePath, bytes);
  return { archivePath, room, scan: () => scanTarGzArchive(archivePath, bytes.length) };
}

test("the scanner mirrors node-tar decString for every header string field", async () => {
  const fixtures: Array<{ name: string; bytes: Buffer; pattern: RegExp }> = [
    {
      name: "name-device",
      bytes: gzipSync(
        rawTarEntry("ignored", "", {
          nameBytes: nulHiddenField("good.txt", "\n", "CON.txt"),
        }),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "name-ads-colon",
      bytes: gzipSync(
        rawTarEntry("ignored", "", {
          nameBytes: nulHiddenField("ok.txt", "\n", "a:b.txt"),
        }),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "name-trailing-space",
      bytes: gzipSync(
        rawTarEntry("ignored", "", {
          nameBytes: nulHiddenField("ok.txt", "\n", "bad "),
        }),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "name-traversal",
      bytes: gzipSync(
        rawTarEntry("ignored", "", {
          nameBytes: nulHiddenField("ok.txt", "\n", "/../escape.txt"),
        }),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "name-carriage-return",
      bytes: gzipSync(
        rawTarEntry("ignored", "", {
          nameBytes: nulHiddenField("ok.txt", "\r", "CON.txt"),
        }),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "name-nul-padded-tail",
      bytes: gzipSync(
        rawTarEntry("ignored", "", {
          nameBytes: nulHiddenField("good.txt", "\n", "CON.txt", 0),
        }),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "linkpath-symlink",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("real.txt", "x")),
          rawTarEntry("lnk", "", {
            type: "2",
            linknameBytes: nulHiddenField("real.txt", "\n", "COM1.log"),
          }),
        ]),
      ),
      pattern: /unsafe link/i,
    },
    {
      name: "linkpath-hardlink",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("real.txt", "x")),
          rawTarEntry("hard", "", {
            type: "1",
            linknameBytes: nulHiddenField("real.txt", "\n", "QQQ"),
          }),
        ]),
      ),
      pattern: /unsafe link/i,
    },
    {
      name: "ustar-prefix",
      bytes: gzipSync(
        rawTarEntry("inner.txt", "x", {
          prefixBytes: (() => {
            const field = Buffer.alloc(155);
            Buffer.from("dir\0\nCON", "utf8").copy(field);
            return field;
          })(),
        }),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "gnu-long-name",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("././@LongLink", "good.txt\0\nCON.txt", { type: "L" })),
          rawTarEntry("truncated.txt", "x"),
        ]),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "gnu-long-link",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("real.txt", "x")),
          stripMarker(rawTarEntry("././@LongLink", "real.txt\0\nCOM1.log", { type: "K" })),
          rawTarEntry("lnk", "", { type: "2", linkname: "real.txt" }),
        ]),
      ),
      pattern: /unsafe link/i,
    },
    {
      name: "gnu-masked-by-pax",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("././@LongLink", "good.txt\0\nCON.txt", { type: "L" })),
          stripMarker(
            rawTarEntry("PaxHeader/x", rawPaxRecord("path", "benign.txt"), { type: "x" }),
          ),
          rawTarEntry("truncated.txt", "x"),
        ]),
      ),
      pattern: /unsafe path/i,
    },
    {
      name: "gnu-link-masked-by-global-pax",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("real.txt", "x")),
          stripMarker(rawTarEntry("././@LongLink", "real.txt\0\nCOM1.log", { type: "K" })),
          stripMarker(
            rawTarEntry("GlobalHead", rawPaxRecord("linkpath", "real.txt"), { type: "g" }),
          ),
          rawTarEntry("lnk", "", { type: "2", linkname: "real.txt" }),
        ]),
      ),
      pattern: /unsafe link/i,
    },
  ];

  for (const fixture of fixtures) {
    const probe = await scanBytes(fixture.bytes, `dec-${fixture.name}`);
    await assert.rejects(probe.scan(), (error: unknown) => {
      assert.match((error as Error).message, fixture.pattern);
      return true;
    }, `expected ${fixture.name} to reject`);

    // No publication either: the whole command fails closed with a truthful
    // CliError and leaves the destination absent.
    const item = service.seed(
      { name: `${fixture.name}.tar.gz`, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(probe.room, "dest");
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1);
    assert.match(result.stderr.text, fixture.pattern);
    assert.deepEqual((await readdir(probe.room)).sort(), ["a.tar.gz"]);
  }
});

// The point of mirroring decString is that the scanner validates the exact
// string node-tar publishes — not that every NUL-bearing field is refused.
// U+2028 also ends the regex's run but is not a control character, so the
// joined name is an ordinary portable one; the manifest must equal the tree a
// real `tar.extract` produces, byte for byte.
test("a surviving suffix that is portable is validated and matches real extraction", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { scanTarGzArchive } = await import("../src/tar-scan.js");
  const bytes = gzipSync(
    rawTarEntry("ignored", "hi", {
      nameBytes: nulHiddenField("good.txt", "\u2028", "CON.txt"),
    }),
  );
  const room = await mkdtemp(join(scratch, "dec-portable-"));
  const archivePath = join(room, "a.tar.gz");
  await writeFile(archivePath, bytes);
  const manifest = await scanTarGzArchive(archivePath, bytes.length);
  assert.equal(manifest.entries.length, 1);
  assert.match(manifest.entries[0]!, /^good\.txt\u2028CON\.txtY+$/u);

  const out = join(room, "out");
  await mkdir(out);
  await tar.extract({ file: archivePath, cwd: out, preservePaths: false, strict: true });
  assert.deepEqual((await readdir(out)).sort(), manifest.entries);
});

// The same bytes must be refused identically no matter how the gzip stream is
// chunked into the walker, and the server must never store them.
test("hidden-suffix archives reject at every chunk size and are never persisted", async () => {
  const bytes = gzipSync(
    rawTarEntry("ignored", "", {
      nameBytes: nulHiddenField("good.txt", "\n", "CON.txt"),
    }),
  );
  const { scanTarGzArchive } = await import("../src/tar-scan.js");
  const room = await mkdtemp(join(scratch, "dec-chunks-"));
  const archivePath = join(room, "a.tar.gz");
  await writeFile(archivePath, bytes);
  for (const highWaterMark of [1, 7, 511, 512, 513, 65536]) {
    // createReadStream inside the scanner uses the default watermark, so the
    // chunking is exercised through the archive bytes themselves: rewriting
    // the file with different gzip framing keeps the tar identical.
    await writeFile(archivePath, gzipSync(Buffer.from(gunzipSync(bytes)), { chunkSize: highWaterMark < 64 ? 64 : highWaterMark }));
    await assert.rejects(scanTarGzArchive(archivePath, bytes.length), (error: unknown) => {
      assert.match((error as Error).message, /unsafe path/i);
      return true;
    });
  }
});

// node-tar's parser applies its raw-header gates BEFORE dispatching on the
// header type, so GNU `L`/`K` and PAX `x`/`g` metadata headers are subject to
// them too: `path is required` fires for any header whose own name field
// decodes empty, and `linkpath forbidden` fires for `L`/`K` — only link
// entries and PAX `x`/`g` are exempt. The scanner must refuse exactly what
// the shipped extractor refuses, or a server-certified archive could never be
// materialized by `fs down --extract`.
test("metadata headers the extractor refuses reject, match real tar.extract, and never publish", async () => {
  const { scanTarGzArchive } = await import("../src/tar-scan.js");
  const { mkdir } = await import("node:fs/promises");
  const fixtures: Array<{
    name: string;
    bytes: Buffer;
    pattern: RegExp;
    tarPattern: RegExp;
  }> = [
    {
      name: "gnu-longpath-linkname",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry("././@LongLink", "longname.txt\0", {
              type: "L",
              linkname: "whatever",
            }),
          ),
          rawTarEntry("longname.txt", "content"),
        ]),
      ),
      pattern: /metadata header carries a link target/i,
      tarPattern: /linkpath forbidden/,
    },
    {
      name: "gnu-longlink-linkname",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("target.txt", "content")),
          stripMarker(
            rawTarEntry("././@LongLink", "target.txt\0", {
              type: "K",
              linkname: "zzz",
            }),
          ),
          rawTarEntry("link", "", { type: "2", linkname: "target.txt" }),
        ]),
      ),
      pattern: /metadata header carries a link target/i,
      tarPattern: /linkpath forbidden/,
    },
    {
      name: "gnu-longpath-empty-name",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("", "longname.txt\0", { type: "L" })),
          rawTarEntry("stub", "content"),
        ]),
      ),
      pattern: /metadata header has an empty path/i,
      tarPattern: /path is required/,
    },
    {
      name: "gnu-longlink-empty-name",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(rawTarEntry("target.txt", "content")),
          stripMarker(rawTarEntry("", "target.txt\0", { type: "K" })),
          rawTarEntry("link", "", { type: "2", linkname: "target.txt" }),
        ]),
      ),
      pattern: /metadata header has an empty path/i,
      tarPattern: /path is required/,
    },
    {
      name: "pax-x-empty-name",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry("", rawPaxRecord("path", "renamed.txt"), {
              type: "x",
            }),
          ),
          rawTarEntry("orig.txt", "content"),
        ]),
      ),
      pattern: /metadata header has an empty path/i,
      tarPattern: /path is required/,
    },
    {
      name: "pax-g-empty-name",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry("", rawPaxRecord("comment", "inert"), { type: "g" }),
          ),
          rawTarEntry("real.txt", "content"),
        ]),
      ),
      pattern: /metadata header has an empty path/i,
      tarPattern: /path is required/,
    },
  ];

  for (const fixture of fixtures) {
    const room = await mkdtemp(join(scratch, `meta-gate-${fixture.name}-`));
    const archivePath = join(room, "a.tar.gz");
    await writeFile(archivePath, fixture.bytes);

    // The scanner mirrors the gate.
    await assert.rejects(
      scanTarGzArchive(archivePath, fixture.bytes.length),
      (error: unknown) => {
        assert.match((error as Error).message, fixture.pattern, fixture.name);
        return true;
      },
      fixture.name,
    );

    // The shipped extractor really does refuse the same bytes fatally.
    const out = join(room, "out");
    await mkdir(out);
    await assert.rejects(
      tar.extract({
        file: archivePath,
        cwd: out,
        preservePaths: false,
        strict: true,
      }),
      (error: unknown) => {
        assert.match(
          (error as Error).message,
          fixture.tarPattern,
          fixture.name,
        );
        return true;
      },
      fixture.name,
    );

    // Shipped command: no publish, no staging residue.
    const item = service.seed(
      { name: `${fixture.name}.tar.gz`, archive: "tar.gz", size: fixture.bytes.length },
      fixture.bytes,
    );
    const destination = join(room, "dest");
    const result = await cli(["down", item.id, "--extract", "-o", destination]);
    assert.equal(result.code, 1, fixture.name);
    assert.match(result.stderr.text, fixture.pattern, fixture.name);
    await assert.rejects(readFile(destination), { code: "ENOENT" }, fixture.name);
    assert.deepEqual(
      (await readdir(room)).sort(),
      ["a.tar.gz", "out"],
      `${fixture.name} left residue`,
    );
  }
});

// The rejection must be byte-identical no matter how the gzip stream is
// framed, mirroring the server's chunk-size matrix.
test("metadata-header gate rejections are stable across gzip framings", async () => {
  const { scanTarGzArchive } = await import("../src/tar-scan.js");
  const room = await mkdtemp(join(scratch, "meta-gate-chunks-"));
  const spellings: Array<{ tar: Buffer; pattern: RegExp }> = [
    {
      tar: Buffer.concat([
        stripMarker(
          rawTarEntry("././@LongLink", "longname.txt\0", {
            type: "L",
            linkname: "whatever",
          }),
        ),
        rawTarEntry("longname.txt", "content"),
      ]),
      pattern: /metadata header carries a link target/i,
    },
    {
      tar: Buffer.concat([
        stripMarker(
          rawTarEntry("", rawPaxRecord("path", "renamed.txt"), { type: "x" }),
        ),
        rawTarEntry("orig.txt", "content"),
      ]),
      pattern: /metadata header has an empty path/i,
    },
  ];
  const archivePath = join(room, "a.tar.gz");
  for (const spelling of spellings) {
    for (const chunkSize of [64, 511, 512, 513, 65536]) {
      const bytes = gzipSync(spelling.tar, { chunkSize });
      await writeFile(archivePath, bytes);
      await assert.rejects(
        scanTarGzArchive(archivePath, bytes.length),
        (error: unknown) => {
          assert.match((error as Error).message, spelling.pattern);
          return true;
        },
      );
    }
  }
});

// node-tar exempts PAX `x`/`g` from `linkpath forbidden`: those archives
// extract fine, so the mirror must keep accepting and publishing them.
test("PAX x/g headers carrying a raw linkname stay accepted and publish", async () => {
  const { scanTarGzArchive } = await import("../src/tar-scan.js");
  const { mkdir } = await import("node:fs/promises");
  const cases: Array<{ name: string; bytes: Buffer; published: string[] }> = [
    {
      name: "pax-x-linkname",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry("PaxHeader/renamed", rawPaxRecord("path", "renamed.txt"), {
              type: "x",
              linkname: "ignored",
            }),
          ),
          rawTarEntry("orig.txt", "content"),
        ]),
      ),
      published: ["renamed.txt"],
    },
    {
      name: "pax-g-linkname",
      bytes: gzipSync(
        Buffer.concat([
          stripMarker(
            rawTarEntry("GlobalHead", rawPaxRecord("comment", "inert"), {
              type: "g",
              linkname: "ignored",
            }),
          ),
          rawTarEntry("real.txt", "content"),
        ]),
      ),
      published: ["real.txt"],
    },
  ];
  for (const item of cases) {
    const room = await mkdtemp(join(scratch, `${item.name}-`));
    const archivePath = join(room, "a.tar.gz");
    await writeFile(archivePath, item.bytes);
    const manifest = await scanTarGzArchive(archivePath, item.bytes.length);
    assert.deepEqual(manifest.entries, item.published, item.name);

    // Manifest equals the tree the real extractor materializes.
    const out = join(room, "out");
    await mkdir(out);
    await tar.extract({
      file: archivePath,
      cwd: out,
      preservePaths: false,
      strict: true,
    });
    assert.deepEqual((await readdir(out)).sort(), item.published, item.name);

    // Shipped command publishes it.
    const seeded = service.seed(
      { name: `${item.name}.tar.gz`, archive: "tar.gz", size: item.bytes.length },
      item.bytes,
    );
    const destination = join(room, "dest");
    const result = await cli(["down", seeded.id, "--extract", "-o", destination]);
    assert.equal(result.code, 0, item.name);
    assert.deepEqual((await readdir(destination)).sort(), item.published, item.name);
  }
});

// node-tar performs its filesystem work in raw fs callbacks. A fault raised
// there — `fs.lstat`/`fs.mkdir` throwing ERR_INVALID_ARG_VALUE for a path
// node-tar derived that contains a NUL byte, for instance — is thrown on the
// event loop, NOT into the promise `tar.extract` returned. That promise then
// never settles: the process aborted with a raw stack trace, extraction's
// cleanup never ran, and a `.<name>.fs-XXXXXX` staging directory was left
// beside the destination. Every fault shape must instead become a truthful
// CliError with the staging tree removed.
test("an escaped extractor fault becomes a truthful CliError and cleans staging", async () => {
  const extract = await import("../src/extract.js");
  const bytes = gzipSync(rawTarEntry("inside.txt", "content"));
  const baseline = {
    uncaught: process.listenerCount("uncaughtException"),
    unhandled: process.listenerCount("unhandledRejection"),
  };

  const faults: Array<{
    name: string;
    runExtract: () => Promise<void>;
  }> = [
    {
      name: "synchronous throw",
      runExtract: () => {
        throw new TypeError("injected synchronous extractor fault");
      },
    },
    {
      name: "asynchronous rejection",
      runExtract: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new TypeError("injected asynchronous extractor fault");
      },
    },
  ];

  for (const fault of faults) {
    const room = await mkdtemp(join(scratch, "fault-"));
    const archivePath = join(room, "a.tar.gz");
    await writeFile(archivePath, bytes);
    const destination = join(room, "dest");

    await assert.rejects(
      extract.extractArchive(archivePath, destination, false, {
        runExtract: fault.runExtract,
      }),
      (error: unknown) => {
        assert.equal((error as { name?: string }).name, "CliError", fault.name);
        assert.equal((error as { code?: string }).code, "EXTRACT_FAILED");
        assert.equal((error as { exitCode?: number }).exitCode, 1);
        assert.match((error as Error).message, /injected/);
        assert.doesNotMatch((error as Error).message, /at Object|at Unpack/);
        return true;
      },
      fault.name,
    );

    // No staging residue, no backup residue, no destination.
    assert.deepEqual(
      (await readdir(room)).sort(),
      ["a.tar.gz"],
      `${fault.name} left residue`,
    );
  }

  // Containment is scoped to the extraction: no listener survives it, so no
  // later command's failure mode or exit code is masked.
  assert.deepEqual(
    {
      uncaught: process.listenerCount("uncaughtException"),
      unhandled: process.listenerCount("unhandledRejection"),
    },
    baseline,
  );

  // Ordinary exit codes still work afterwards.
  const item = service.seed(
    { name: "ok.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const room = await mkdtemp(join(scratch, "fault-after-"));
  const good = await cli(["down", item.id, "--extract", "-o", join(room, "dest")]);
  assert.equal(good.code, 0);
  const missing = await cli(["info", "0000000"]);
  assert.equal(missing.code, 4);
});

// The real vector: node-tar derives a path holding NUL bytes from a ustar
// prefix whose hidden suffix is NUL-padded. The scanner now refuses it before
// extraction, so the crash is unreachable — proven end to end through the
// shipped command, with no residue beside the destination.
test("the real NUL-in-path prefix archive fails closed with no residue", async () => {
  const prefixBytes = Buffer.alloc(155);
  Buffer.from("dir\0\nCON", "utf8").copy(prefixBytes);
  const bytes = gzipSync(rawTarEntry("inner.txt", "x", { prefixBytes }));
  const item = service.seed(
    { name: "nul-path.tar.gz", archive: "tar.gz", size: bytes.length },
    bytes,
  );
  const room = await mkdtemp(join(scratch, "nul-path-"));
  const destination = join(room, "dest");
  const result = await cli(["down", item.id, "--extract", "-o", destination]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.text, /unsafe path/i);
  assert.doesNotMatch(result.stderr.text, /ERR_INVALID_ARG_VALUE/);
  assert.deepEqual(await readdir(room), []);
});

// The fault shape that actually escapes: thrown from an fs callback, so the
// extract promise never settles. node:test installs its own uncaughtException
// handling, so this one is exercised in a real child process — which is also
// the environment the guarantee is about.
test("a fault escaping the extract promise is contained in a real process", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { pathToFileURL } = await import("node:url");
  const room = await mkdtemp(join(scratch, "escape-"));
  const archivePath = join(room, "a.tar.gz");
  await writeFile(archivePath, gzipSync(rawTarEntry("inside.txt", "content")));
  const script = join(room, "escape.mts");
  // A raw absolute path is not a valid ESM specifier on Windows (the drive
  // letter reads as a URL scheme), so the module URL is a file:// URL.
  const extractModuleUrl = pathToFileURL(join(process.cwd(), "src/extract.ts")).href;
  await writeFile(
    script,
    [
      `const { extractArchive } = await import(${JSON.stringify(extractModuleUrl)});`,
      `try {`,
      `  await extractArchive(${JSON.stringify(archivePath)}, ${JSON.stringify(join(room, "dest"))}, false, {`,
      `    runExtract: () =>`,
      `      new Promise(() => {`,
      `        setImmediate(() => {`,
      `          throw new TypeError("injected escaped extractor fault");`,
      `        });`,
      `      }),`,
      `  });`,
      `  console.log("RESOLVED");`,
      `} catch (error) {`,
      `  console.log(JSON.stringify({ name: error.name, code: error.code, exitCode: error.exitCode, message: error.message }));`,
      `}`,
    ].join("\n"),
  );

  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", script],
    { cwd: process.cwd() },
  );
  const outcome = JSON.parse(stdout.trim());
  assert.equal(outcome.name, "CliError");
  assert.equal(outcome.code, "EXTRACT_FAILED");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.message, /injected escaped extractor fault/);

  // The staging tree is gone and the destination was never published.
  assert.deepEqual((await readdir(room)).sort(), ["a.tar.gz", "escape.mts"]);
});

// node-tar's Unpack can keep materializing already-queued entries after its
// primary failure settles. Removing staging while those writes are in flight
// used to replace the truthful error with ENOTEMPTY and leave residue. Inject
// the same named fault from an ordinary portable entry on every platform;
// filesystem component limits and platform-specific errno spellings are not
// part of this lifecycle contract.
test("a mid-archive extractor failure with queued writes keeps the truthful error and cleans staging", async () => {
  const extract = await import("../src/extract.js");
  const { mkdir } = await import("node:fs/promises");
  const entries: Buffer[] = [];
  for (let index = 0; index < 20; index += 1) {
    entries.push(stripMarker(rawTarEntry(`a${index}.bin`, "x".repeat(8192))));
  }
  entries.push(stripMarker(rawTarEntry("fault.bin", "fault")));
  for (let index = 0; index < 60; index += 1) {
    entries.push(stripMarker(rawTarEntry(`z${index}.bin`, "x".repeat(8192))));
  }
  const bytes = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
  const hooks = {
    onExtractEntry: (entryPath: string) => {
      if (entryPath === "fault.bin") throw new Error("injected queued extractor fault");
    },
  };

  const isTruthful = (error: unknown, label: string): boolean => {
    assert.equal((error as { name?: string }).name, "CliError", label);
    assert.equal((error as { code?: string }).code, "EXTRACT_FAILED", label);
    assert.equal((error as { exitCode?: number }).exitCode, 1, label);
    assert.match((error as Error).message, /injected queued extractor fault/, label);
    assert.doesNotMatch((error as Error).message, /ENOTEMPTY|ENOENT|ENAMETOOLONG/, label);
    return true;
  };

  // Repeated because the failure is a race; a lucky pass must not hide it.
  for (let round = 0; round < 5; round += 1) {
    const room = await mkdtemp(join(scratch, "queued-fault-"));
    const archivePath = join(room, "a.tar.gz");
    await writeFile(archivePath, bytes);
    const destination = join(room, "dest");
    await assert.rejects(
      extract.extractArchive(archivePath, destination, false, hooks),
      (error: unknown) => isTruthful(error, `round ${round}`),
      `round ${round}`,
    );
    assert.deepEqual(
      (await readdir(room)).sort(),
      ["a.tar.gz"],
      `round ${round} left residue`,
    );
  }

  // Under --force the old destination remains untouched, with no backup or
  // staging residue.
  const forceRoom = await mkdtemp(join(scratch, "queued-fault-force-"));
  const forceArchive = join(forceRoom, "a.tar.gz");
  await writeFile(forceArchive, bytes);
  const forceDestination = join(forceRoom, "dest");
  await mkdir(forceDestination);
  await writeFile(join(forceDestination, "keep.txt"), "keep");
  await assert.rejects(
    extract.extractArchive(forceArchive, forceDestination, true, hooks),
    (error: unknown) => isTruthful(error, "force"),
    "force",
  );
  assert.equal(
    await readFile(join(forceDestination, "keep.txt"), "utf8"),
    "keep",
  );
  assert.deepEqual((await readdir(forceRoom)).sort(), ["a.tar.gz", "dest"]);
  assert.deepEqual(await readdir(forceDestination), ["keep.txt"]);
});

// The CLI decoder must be the same expression as the server's and as
// node-tar's, so a divergence can never be introduced on one side only.
test("decodeTarString mirrors node-tar decString byte for byte", async () => {
  const { decodeTarString } = await import("../src/tar-scan.js");
  // Copied verbatim from cli/node_modules/tar/dist/esm/header.js.
  const nodeTarDecString = (buffer: Buffer): string =>
    buffer.toString("utf8").replace(/\0.*/, "");

  const patterns: Buffer[] = [
    Buffer.from("plain.txt"),
    Buffer.from("plain.txt\0\0\0\0"),
    Buffer.from("a".repeat(100)),
    Buffer.alloc(0),
    Buffer.from("\0"),
    Buffer.from("\0\nCON.txt"),
    Buffer.from("good.txt\0\nCON.txt"),
    Buffer.from("good.txt\0\rCON.txt"),
    Buffer.from("good.txt\0\u2028CON.txt"),
    Buffer.from("good.txt\0\u2029CON.txt"),
    Buffer.from("good.txt\0\nCON.txt\0\0\0"),
    Buffer.from("good.txt\0\nfirst\0\nsecond"),
    Buffer.from("café.txt\0\néCON"),
    Buffer.from([0x61, 0x80, 0x2e, 0x74, 0x78, 0x74]),
    Buffer.from([0x61, 0x00, 0x0a, 0xf0, 0x9f, 0x98, 0x80]),
    Buffer.from([0x61, 0x00, 0x0a, 0xed, 0xa0, 0x80]),
  ];
  for (const pattern of patterns) {
    assert.equal(
      decodeTarString(pattern),
      nodeTarDecString(pattern),
      JSON.stringify(pattern.toString("latin1")),
    );
  }

  // Deterministic PRNG so a disagreement is always reproducible.
  let state = 0x2545f491;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state;
  };
  const alphabet = [
    0x00, 0x0a, 0x0d, 0x2f, 0x41, 0x7f, 0x80, 0xc3, 0xa9, 0xe2, 0x80, 0xa8,
    0xf0, 0x9f, 0x98, 0x80,
  ];
  for (let round = 0; round < 20_000; round += 1) {
    const field = Buffer.alloc(1 + (next() % 100));
    for (let index = 0; index < field.length; index += 1) {
      field[index] = alphabet[next() % alphabet.length]!;
    }
    assert.equal(decodeTarString(field), nodeTarDecString(field));
  }
});

// Beyond the string fields: the walker must not read any other header field
// differently from node-tar either. Failing closed is acceptable; deriving a
// meaning node-tar does not share is not.
test("adjacent header fields are read the way node-tar reads them", async () => {
  const { scanTarGzArchive } = await import("../src/tar-scan.js");
  const room = await mkdtemp(join(scratch, "adjacent-"));
  const probe = async (bytes: Buffer, label: string) => {
    const archivePath = join(room, `${label}.tar.gz`);
    await writeFile(archivePath, bytes);
    return scanTarGzArchive(archivePath, bytes.length);
  };

  // A NUL typeflag means a regular file on both sides.
  const nulType = await probe(
    gzipSync(rawTarEntry("nul-type.txt", "x", { type: "\0" })),
    "nul-type",
  );
  assert.deepEqual(nulType.entries, ["nul-type.txt"]);

  // Every other typeflag node-tar maps to Unsupported — or to a type this
  // contract does not carry, such as ContiguousFile ("7") — rejects.
  for (const type of ["\n", "\u0080", "7", "3", "6"]) {
    await assert.rejects(
      probe(
        gzipSync(rawTarEntry("t.txt", "x", { type })),
        `type-${type.charCodeAt(0)}`,
      ),
      (error: unknown) => {
        assert.match(
          (error as Error).message,
          /unsupported archive entry type/i,
        );
        return true;
      },
      `type ${type.charCodeAt(0)}`,
    );
  }

  // node-tar reads numeric fields with `/\0.*$/` + parseInt, which stops at
  // the first NUL exactly as this walker's truncation does. A field starting
  // with a NUL yields `undefined` there and 0 here, and ReadEntry turns that
  // `undefined` into 0 too, so both frame the entry at zero bytes.
  const whole = rawTarEntry("num.txt", "");
  Buffer.from("\0\n0000000012", "latin1").copy(whole, 124);
  whole.fill(0x20, 148, 156);
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += whole[index]!;
  whole.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  const numeric = await probe(gzipSync(whole), "numeric");
  assert.deepEqual(numeric.entries, ["num.txt"]);
});
