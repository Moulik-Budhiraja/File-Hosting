import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { CLI_EXAMPLES } from "./cli-examples";

const CLI_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../cli/dist/index.js",
);

const FILE_METADATA = {
  id: "9f2c41d",
  name: "batch.parquet",
  size: 4,
  mime_type: "application/octet-stream",
  sha256: "0".repeat(64),
  visibility: "public",
  tags: ["ingest"],
  preview_url: "http://127.0.0.1/9f2c41d",
  raw_url: "http://127.0.0.1/raw/9f2c41d",
  archive: null,
  created_at: "2026-07-31T00:00:00.000Z",
  updated_at: "2026-07-31T00:00:00.000Z",
};

function fakeApiServer(): Server {
  return createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // Drain any request body before responding.
    request.on("data", () => undefined);
    request.on("end", () => {
      if (request.method === "POST") return send(201, FILE_METADATA);
      if (url.pathname === "/api/files")
        return send(200, { items: [FILE_METADATA], next_cursor: null });
      if (request.method === "DELETE") return send(200, { ok: true });
      return send(200, FILE_METADATA);
    });
  });
}

// Every CLI command surfaced on the System page must execute cleanly through
// the real CLI parser and contract — no invented flags, no wrong-length IDs.
describe("system-page CLI examples", () => {
  let directory: string;
  let server: Server;
  let baseUrl = "";

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fs-cli-examples-"));
    await writeFile(path.join(directory, "batch.parquet"), "PAR1");
    server = fakeApiServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  it("displays commands whose argv matches their display strings", () => {
    for (const example of CLI_EXAMPLES) {
      const shellQuoted = example.argv
        .map((argument) =>
          argument.includes("*") ? `'${argument}'` : argument,
        )
        .join(" ");
      assert.equal(example.display, `$ fs ${shellQuoted}`);
      // Any ID used in an example must be a valid 7-character base62 ID.
      for (const argument of example.argv) {
        if (/^[A-Za-z0-9]{7,8}$/.test(argument) && !argument.includes(".")) {
          assert.match(argument, /^[A-Za-z0-9]{7}$/);
        }
      }
    }
  });

  for (const example of CLI_EXAMPLES) {
    it(`executes cleanly: ${example.display}`, async () => {
      const result = await new Promise<{
        code: number | null;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [CLI_ENTRY, ...example.argv, "--no-input"],
          {
            cwd: directory,
            env: {
              ...process.env,
              FS_URL: baseUrl,
              FS_TOKEN: "example-check-token",
            },
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      });
      assert.equal(
        result.code,
        0,
        `expected exit 0 for "${example.display}", stderr: ${result.stderr}`,
      );
      assert.doesNotMatch(result.stderr, /INVALID_ARGUMENTS|Usage:/);
    });
  }
});
