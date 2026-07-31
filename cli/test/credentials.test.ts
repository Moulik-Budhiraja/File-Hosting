import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { readSecret } from "../src/credentials.js";
import type { Streams } from "../src/types.js";

class Capture extends Writable {
  readonly chunks: Buffer[] = [];
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
  get text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
}

test("readSecret hides interactive input", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(mode: boolean): PassThrough };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  const stdout = new Capture();
  const stderr = new Capture();
  Object.assign(stderr, { isTTY: true });
  const streams: Streams = { stdin, stdout, stderr };

  const reading = readSecret(streams);
  setImmediate(() => stdin.write("hidden-token\n"));

  assert.equal(await reading, "hidden-token");
  assert.match(stderr.text, /token/i);
  assert.doesNotMatch(stderr.text, /hidden-token/);
  assert.equal(stdout.text, "");
});
