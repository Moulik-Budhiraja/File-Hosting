import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  DELETE as deleteFile,
  GET as getFile,
  PATCH as patchFile,
} from "../../app/api/files/[id]/route";
import { GET as listFiles, POST as postFile } from "../../app/api/files/route";
import { GET as previewFile } from "../../app/[id]/route";
import { GET as health } from "../../app/healthz/route";
import { GET as rawFile, HEAD as headRawFile } from "../../app/raw/[id]/route";
import { isAuthorized } from "./auth";
import { decodeCursor, encodeCursor } from "./database";
import { AppError } from "./errors";
import { generateFileId } from "./id";
import { parseRangeHeader } from "./range";
import { FileService } from "./service";
import { setFileServiceForTests } from "./singleton";
import { parseArchive, validateFilename, validateTags } from "./validation";

const TOKEN = "a-test-secret-with-enough-entropy";
const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` };

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

describe("pure file helpers", () => {
  it("generates unique unbiased-looking 7-character base62 IDs", () => {
    const ids = new Set(Array.from({ length: 2_000 }, generateFileId));
    assert.equal(ids.size, 2_000);
    for (const id of ids) assert.match(id, /^[0-9A-Za-z]{7}$/u);
  });

  it("validates names, tags, and archive metadata", () => {
    assert.equal(validateFilename(" report.pdf "), "report.pdf");
    assert.deepEqual(validateTags(["Report", "report", " final "]), [
      "Report",
      "final",
    ]);
    assert.equal(parseArchive("tar.gz"), "tar.gz");
    assert.equal(parseArchive(null), null);
    assert.throws(() => validateFilename("../secret"), /path separators/u);
    assert.throws(() => validateFilename("replacement-�.txt"), /Unicode/u);
    assert.throws(() => validateFilename("noncharacter-￿.txt"), /Unicode/u);
    assert.throws(() => validateTags(["bad,tag"]), /cannot contain commas/u);
    assert.throws(() => parseArchive("zip"), /tar\.gz/u);
  });

  it("authenticates only an exact Bearer token", () => {
    assert.equal(
      isAuthorized(
        new Request("http://localhost", { headers: AUTHORIZATION }),
        TOKEN,
      ),
      true,
    );
    assert.equal(
      isAuthorized(
        new Request("http://localhost", {
          headers: { authorization: "Bearer wrong" },
        }),
        TOKEN,
      ),
      false,
    );
    assert.equal(isAuthorized(new Request("http://localhost"), TOKEN), false);
  });

  it("parses standard, open-ended, and suffix byte ranges", () => {
    assert.deepEqual(parseRangeHeader("bytes=2-5", 10), { start: 2, end: 5 });
    assert.deepEqual(parseRangeHeader("bytes=7-", 10), { start: 7, end: 9 });
    assert.deepEqual(parseRangeHeader("bytes=-3", 10), { start: 7, end: 9 });
    assert.equal(parseRangeHeader(null, 10), null);
    assert.throws(
      () => parseRangeHeader("bytes=11-12", 10),
      /cannot be satisfied/u,
    );
    assert.throws(
      () => parseRangeHeader("bytes=1-2,4-5", 10),
      /single byte range/u,
    );
  });

  it("round-trips opaque pagination cursors and rejects malformed values", () => {
    const cursor = { createdAt: "2026-07-11T12:00:00.000Z", id: "aB3dE5g" };
    assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
    assert.throws(() => decodeCursor("not-a-cursor"), /Cursor is invalid/u);
  });
});

describe("file service and HTTP routes", { concurrency: false }, () => {
  let directory: string;
  let service: FileService;
  let uploadedId: string;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fs-server-test-"));
    service = await FileService.create({
      token: TOKEN,
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: path.join(directory, "objects"),
      publicUrl: "https://files.example.test",
      maxUploadBytes: 1024,
      minFreeBytes: 0,
    });
    setFileServiceForTests(service);
  });

  after(async () => {
    setFileServiceForTests(null);
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("streams an upload, hashes it, stores tags, and atomically persists bytes", async () => {
    const file = await service.upload(chunks("hello ", "world"), {
      name: "hello.txt",
      tags: ["greeting", "text"],
      visibility: "public",
      archive: null,
      mimeType: "text/plain; charset=utf-8",
      contentLength: 11,
    });
    assert.match(file.id, /^[0-9A-Za-z]{7}$/u);
    assert.equal(file.size, 11);
    assert.equal(file.mimeType, "text/plain");
    assert.equal(
      file.sha256,
      createHash("sha256").update("hello world").digest("hex"),
    );
    assert.deepEqual(file.tags, ["greeting", "text"]);
    assert.equal(
      await readFile(service.storagePath(file), "utf8"),
      "hello world",
    );
    assert.equal(service.toMetadata(file).archive, null);
  });

  it("filters by query, glob, AND tags, visibility, and cursor", async () => {
    await service.upload(chunks("one"), {
      name: "report-one.pdf",
      tags: ["report", "finance"],
      visibility: "public",
      archive: null,
      mimeType: "application/pdf",
      contentLength: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await service.upload(chunks("two"), {
      name: "report-two.pdf",
      tags: ["report", "engineering"],
      visibility: "private",
      archive: null,
      mimeType: "application/pdf",
      contentLength: 3,
    });

    const byGlob = await service.list({
      name: "report-*.pdf",
      tags: [],
      limit: 100,
    });
    assert.equal(byGlob.files.length, 2);
    const byAndTags = await service.list({
      tags: ["report", "finance"],
      limit: 100,
    });
    assert.deepEqual(
      byAndTags.files.map((file) => file.name),
      ["report-one.pdf"],
    );
    const byQuery = await service.list({
      q: "engineering",
      tags: [],
      limit: 100,
    });
    assert.deepEqual(
      byQuery.files.map((file) => file.name),
      ["report-two.pdf"],
    );
    const privateOnly = await service.list({
      tags: [],
      visibility: "private",
      limit: 100,
    });
    assert.deepEqual(
      privateOnly.files.map((file) => file.name),
      ["report-two.pdf"],
    );

    const firstPage = await service.list({ tags: [], limit: 1 });
    assert.equal(firstPage.files.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPage = await service.list({
      tags: [],
      limit: 10,
      cursor: decodeCursor(firstPage.nextCursor),
    });
    assert.ok(secondPage.files.length >= 2);
    assert.notEqual(secondPage.files[0]?.id, firstPage.files[0]?.id);
  });

  it("applies add, remove, and set tag operations with visibility changes", async () => {
    const original = await service.upload(chunks("tags"), {
      name: "tags.txt",
      tags: ["one"],
      visibility: "public",
      archive: null,
      contentLength: 4,
    });
    const added = await service.update(original.id, {
      visibility: "private",
      tags: { operation: "add", values: ["two"] },
    });
    assert.equal(added?.visibility, "private");
    assert.deepEqual(added?.tags, ["one", "two"]);
    const removed = await service.update(original.id, {
      tags: { operation: "remove", values: ["one"] },
    });
    assert.deepEqual(removed?.tags, ["two"]);
    const replaced = await service.update(original.id, {
      tags: { operation: "set", values: ["final"] },
    });
    assert.deepEqual(replaced?.tags, ["final"]);
  });

  it("rejects a streamed upload when finalize authorization is revoked", async () => {
    await assert.rejects(
      service.upload(chunks("revoked"), {
        name: "revoked-upload.txt",
        tags: [],
        visibility: "private",
        archive: null,
        mimeType: "text/plain",
        contentLength: 7,
        authorizeFinalize: () => {
          throw new AppError(401, "invalid_token", "Credential was revoked");
        },
      }),
      (error: unknown) =>
        error instanceof AppError && error.code === "invalid_token",
    );
  });

  it("rejects oversized streams and removes partial files", async () => {
    await assert.rejects(
      service.upload(chunks("x".repeat(1025)), {
        name: "large.bin",
        tags: [],
        visibility: "public",
        archive: null,
      }),
      /maximum size/u,
    );
    const tempEntries = await (
      await import("node:fs/promises")
    ).readdir(service.tempDir);
    assert.deepEqual(tempEntries, []);
  });

  it("requires auth for the API and returns the stable error envelope", async () => {
    const response = await listFiles(new Request("http://localhost/api/files"));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: {
        code: "unauthorized",
        message: "A valid bearer token is required",
      },
    });
  });

  it("uploads through the raw-body endpoint and exposes metadata routes", async () => {
    const response = await postFile(
      new Request(
        "http://localhost/api/files?name=unsafe.html&tag=web&tag=sample&archive=tar.gz",
        {
          method: "POST",
          headers: { ...AUTHORIZATION, "content-type": "text/html" },
          body: "<script>alert('no')</script><b>hello</b>",
        },
      ),
    );
    assert.equal(response.status, 201);
    const metadata = (await response.json()) as {
      id: string;
      archive: string;
      preview_url: string;
    };
    uploadedId = metadata.id;
    assert.equal(metadata.archive, "tar.gz");
    assert.equal(
      metadata.preview_url,
      `https://files.example.test/${uploadedId}`,
    );
    assert.equal(response.headers.get("location"), metadata.preview_url);

    const getResponse = await getFile(
      new Request(`http://localhost/api/files/${uploadedId}`, {
        headers: AUTHORIZATION,
      }),
      routeContext(uploadedId),
    );
    assert.equal(getResponse.status, 200);
    assert.deepEqual(((await getResponse.json()) as { tags: string[] }).tags, [
      "sample",
      "web",
    ]);

    const listResponse = await listFiles(
      new Request("http://localhost/api/files?name=*.html&tag=web&limit=5", {
        headers: AUTHORIZATION,
      }),
    );
    assert.equal(listResponse.status, 200);
    const list = (await listResponse.json()) as {
      items: Array<{ id: string }>;
      next_cursor: string | null;
    };
    assert.ok(list.items.some((item) => item.id === uploadedId));
  });

  it("renders HTML and SVG as escaped source instead of executing it", async () => {
    const response = await previewFile(
      new Request(`http://localhost/${uploadedId}`),
      routeContext(uploadedId),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert.match(html, /&lt;script&gt;alert\(&#39;no&#39;\)&lt;\/script&gt;/u);
    assert.doesNotMatch(html, /<script>alert/u);
  });

  it("renders Markdown semantically with defensive preview response headers", async () => {
    const markdown = await service.upload(
      chunks(
        "# Safe reader\n\n[link](https://example.test)\n\n<script>alert(1)</script>",
      ),
      {
        name: "reader.md",
        tags: ["markdown"],
        visibility: "public",
        archive: null,
        mimeType: "text/markdown",
      },
    );
    const response = await previewFile(
      new Request(`http://localhost/${markdown.id}`),
      routeContext(markdown.id),
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/u);
    assert.match(csp, /frame-ancestors 'none'/u);
    assert.doesNotMatch(csp, /script-src|unsafe-eval/u);
    const html = await response.text();
    assert.match(html, /<h1>Safe reader<\/h1>/u);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
    assert.doesNotMatch(html, /<script>alert/u);
  });

  it("serves raw bytes, byte ranges, HEAD, security headers, and no-store caching", async () => {
    const full = await rawFile(
      new Request(`http://localhost/raw/${uploadedId}`),
      routeContext(uploadedId),
    );
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "text/html");
    assert.equal(full.headers.get("cache-control"), "no-store");
    assert.match(full.headers.get("content-security-policy") ?? "", /sandbox/u);
    assert.equal(await full.text(), "<script>alert('no')</script><b>hello</b>");

    const partial = await rawFile(
      new Request(`http://localhost/raw/${uploadedId}`, {
        headers: { range: "bytes=0-7" },
      }),
      routeContext(uploadedId),
    );
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 0-7/40");
    assert.equal(await partial.text(), "<script>");

    const head = await headRawFile(
      new Request(`http://localhost/raw/${uploadedId}`, { method: "HEAD" }),
      routeContext(uploadedId),
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const invalid = await rawFile(
      new Request(`http://localhost/raw/${uploadedId}`, {
        headers: { range: "bytes=999-" },
      }),
      routeContext(uploadedId),
    );
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */40");
  });

  it("rejects oversized file PATCH bodies before parsing", async () => {
    const file = await service.upload(chunks("bounded"), {
      name: "bounded-patch.txt",
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "text/plain",
      contentLength: 7,
    });
    const response = await patchFile(
      new Request(`http://localhost/api/files/${file.id}`, {
        method: "PATCH",
        headers: { ...AUTHORIZATION, "content-type": "application/json" },
        body: JSON.stringify({ payload: "x".repeat(65_536) }),
      }),
      routeContext(file.id),
    );
    assert.equal(response.status, 413);
  });

  it("makes private files indistinguishable from missing files without auth", async () => {
    const patchResponse = await patchFile(
      new Request(`http://localhost/api/files/${uploadedId}`, {
        method: "PATCH",
        headers: { ...AUTHORIZATION, "content-type": "application/json" },
        body: JSON.stringify({
          visibility: "private",
          tags: { operation: "set", values: ["secret"] },
        }),
      }),
      routeContext(uploadedId),
    );
    assert.equal(patchResponse.status, 200);
    assert.equal(
      ((await patchResponse.json()) as { visibility: string }).visibility,
      "private",
    );

    const hidden = await rawFile(
      new Request(`http://localhost/raw/${uploadedId}`),
      routeContext(uploadedId),
    );
    const missing = await rawFile(
      new Request("http://localhost/raw/0000000"),
      routeContext("0000000"),
    );
    assert.equal(hidden.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await hidden.json(), await missing.json());

    const hiddenPreview = await previewFile(
      new Request(`http://localhost/${uploadedId}`),
      routeContext(uploadedId),
    );
    const missingPreview = await previewFile(
      new Request("http://localhost/0000000"),
      routeContext("0000000"),
    );
    assert.equal(hiddenPreview.status, 404);
    assert.equal(missingPreview.status, 404);
    assert.deepEqual(await hiddenPreview.json(), await missingPreview.json());

    const authenticated = await rawFile(
      new Request(`http://localhost/raw/${uploadedId}`, {
        headers: AUTHORIZATION,
      }),
      routeContext(uploadedId),
    );
    assert.equal(authenticated.status, 200);
  });

  it("enforces ownership, protected visibility, IDOR hiding, and pre-pagination filtering", async () => {
    const owner = await service.auth.createUser({
      username: "file.owner",
      password: "a sufficiently long owner password",
      role: "member",
    });
    const other = await service.auth.createUser({
      username: "file.other",
      password: "a sufficiently long other password",
      role: "member",
    });
    const ownerKey = await service.auth.createApiKey(owner.id, "owner-test");
    const otherKey = await service.auth.createApiKey(other.id, "other-test");
    const ownerAuth = { authorization: `Bearer ${ownerKey.secret}` };
    const otherAuth = { authorization: `Bearer ${otherKey.secret}` };
    const ownerSession = await service.auth.createSession(owner.id);
    const csrfRejected = await postFile(
      new Request("http://localhost/api/files?name=csrf.txt", {
        method: "POST",
        headers: {
          cookie: `fs_session=${ownerSession.token}`,
          origin: "https://evil.example",
        },
        body: "blocked",
      }),
    );
    assert.equal(csrfRejected.status, 403);

    const privateUpload = await postFile(
      new Request(
        "http://localhost/api/files?name=owned.txt&visibility=private",
        {
          method: "POST",
          headers: ownerAuth,
          body: "owned",
        },
      ),
    );
    assert.equal(privateUpload.status, 201);
    const privateMetadata = (await privateUpload.json()) as {
      id: string;
      owner_id: string | null;
    };
    const privateId = privateMetadata.id;
    assert.equal(privateMetadata.owner_id, owner.id);
    assert.equal((await service.get(privateId))?.ownerId, owner.id);

    const protectedUpload = await postFile(
      new Request(
        "http://localhost/api/files?name=shared.txt&visibility=protected",
        {
          method: "POST",
          headers: ownerAuth,
          body: "shared",
        },
      ),
    );
    assert.equal(protectedUpload.status, 201);
    const protectedId = ((await protectedUpload.json()) as { id: string }).id;
    assert.equal(
      (
        await rawFile(
          new Request(`http://localhost/raw/${protectedId}`, {
            headers: otherAuth,
          }),
          routeContext(protectedId),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await rawFile(
          new Request(`http://localhost/raw/${protectedId}`),
          routeContext(protectedId),
        )
      ).status,
      404,
    );

    for (const action of [
      () =>
        getFile(
          new Request(`http://localhost/api/files/${privateId}`, {
            headers: otherAuth,
          }),
          routeContext(privateId),
        ),
      () =>
        patchFile(
          new Request(`http://localhost/api/files/${privateId}`, {
            method: "PATCH",
            headers: { ...otherAuth, "content-type": "application/json" },
            body: JSON.stringify({ visibility: "public" }),
          }),
          routeContext(privateId),
        ),
      () =>
        deleteFile(
          new Request(`http://localhost/api/files/${privateId}`, {
            method: "DELETE",
            headers: otherAuth,
          }),
          routeContext(privateId),
        ),
    ]) {
      assert.equal((await action()).status, 404);
    }

    const page = await listFiles(
      new Request("http://localhost/api/files?limit=1", { headers: otherAuth }),
    );
    assert.equal(page.status, 200);
    const body = (await page.json()) as {
      items: Array<{ id: string }>;
      next_cursor: string | null;
    };
    assert.equal(
      body.items.some((item) => item.id === privateId),
      false,
    );
  });

  it("reports health, deletes metadata and bytes, then returns 404", async () => {
    const healthResponse = await health();
    assert.equal(healthResponse.status, 200);
    assert.equal(
      ((await healthResponse.json()) as { status: string }).status,
      "ok",
    );

    const existing = await service.get(uploadedId);
    assert.ok(existing);
    const storedPath = service.storagePath(existing);
    await stat(storedPath);

    const response = await deleteFile(
      new Request(`http://localhost/api/files/${uploadedId}`, {
        method: "DELETE",
        headers: AUTHORIZATION,
      }),
      routeContext(uploadedId),
    );
    assert.equal(response.status, 204);
    await assert.rejects(stat(storedPath), { code: "ENOENT" });

    const gone = await getFile(
      new Request(`http://localhost/api/files/${uploadedId}`, {
        headers: AUTHORIZATION,
      }),
      routeContext(uploadedId),
    );
    assert.equal(gone.status, 404);
  });

  it("cleans stale interrupted uploads but leaves fresh partial files alone", async () => {
    const stale = path.join(service.tempDir, "stale.part");
    const fresh = path.join(service.tempDir, "fresh.part");
    await writeFile(stale, "old");
    await writeFile(fresh, "new");
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await (await import("node:fs/promises")).utimes(stale, oldDate, oldDate);
    await service.cleanupTemporaryFiles();
    await assert.rejects(stat(stale), { code: "ENOENT" });
    await stat(fresh);
    await rm(fresh);
  });
});
