import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
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
        visibility:
          (url.searchParams.get("visibility") as FileMetadata["visibility"] | null) ??
          (url.searchParams.get("private") === "true" ? "private" : "public"),
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

test("upload creates protected objects atomically", async () => {
  const path = join(scratch, "protected.txt");
  await writeFile(path, "authenticated only");

  const result = await cli([path, "--protected", "--json"]);
  assert.equal(result.code, 0);
  const [item] = JSON.parse(result.stdout.text) as FileMetadata[];
  assert.equal(item.visibility, "protected");
  const request = service.requests.find((entry) => entry.path === "/api/files")!;
  assert.equal(request.query.get("visibility"), "protected");
  assert.equal(request.query.get("private"), "true");
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

test("list supports protected-only visibility filtering", async () => {
  const match = service.seed({ visibility: "protected" });
  service.seed({ visibility: "public" });

  const result = await cli(["list", "--protected", "--json"]);

  assert.equal(result.code, 0);
  assert.deepEqual(
    (JSON.parse(result.stdout.text) as FileMetadata[]).map((item) => item.id),
    [match.id],
  );
  const request = service.requests.find((entry) => entry.path === "/api/files")!;
  assert.equal(request.query.get("visibility"), "protected");

  const conflict = await cli(["list", "--protected", "--private"]);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr.text, /choose only one/iu);
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
  assert.equal((await cli(["visibility", item.id, "protected"])).code, 0);
  assert.equal(service.files.get(item.id)?.metadata.visibility, "protected");
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
