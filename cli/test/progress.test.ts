import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { TransferProgress, type ProgressScheduler, type ProgressSignals } from "../src/progress.js";

class TtyCapture extends Writable {
  isTTY = true;
  readonly chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  get text(): string { return this.chunks.join(""); }
  get byteLength(): number { return this.chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0); }
}

class FakeScheduler implements ProgressScheduler {
  nowMs = 0;
  private sequence = 0;
  private readonly tasks = new Map<number, { at: number; every?: number; callback: () => void }>();

  now(): number { return this.nowMs; }

  setTimeout(callback: () => void, delay: number): object {
    const id = ++this.sequence;
    this.tasks.set(id, { at: this.nowMs + delay, callback });
    return { id };
  }

  clearTimeout(handle: object): void { this.tasks.delete((handle as { id: number }).id); }

  setInterval(callback: () => void, delay: number): object {
    const id = ++this.sequence;
    this.tasks.set(id, { at: this.nowMs + delay, every: delay, callback });
    return { id };
  }

  clearInterval(handle: object): void { this.tasks.delete((handle as { id: number }).id); }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.nowMs = task.at;
      if (task.every === undefined) this.tasks.delete(id);
      else task.at += task.every;
      task.callback();
    }
    this.nowMs = target;
  }
}

class FakeSignals implements ProgressSignals {
  readonly listeners = new Map<NodeJS.Signals, () => void>();
  readonly forwarded: NodeJS.Signals[] = [];

  on(signal: NodeJS.Signals, listener: () => void): void { this.listeners.set(signal, listener); }
  off(signal: NodeJS.Signals, listener: () => void): void {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
  }
  forward(signal: NodeJS.Signals): void { this.forwarded.push(signal); }
  emit(signal: NodeJS.Signals): void { this.listeners.get(signal)?.(); }
}

test("does not render progress before 2.5 seconds", () => {
  const stderr = new TtyCapture();
  const scheduler = new FakeScheduler();
  const progress = new TransferProgress({ label: "Uploading", name: "report.pdf", total: 100, stderr, scheduler });

  progress.add(25);
  scheduler.advance(2_499);
  progress.complete();

  assert.equal(stderr.text, "");
});

test("renders useful progress at 2.5 seconds and keeps updating", () => {
  const stderr = new TtyCapture();
  const scheduler = new FakeScheduler();
  const progress = new TransferProgress({ label: "Uploading", name: "report.pdf", total: 1_000, stderr, scheduler });

  progress.add(250);
  scheduler.advance(2_500);
  assert.match(stderr.text, /Uploading report\.pdf:/);
  assert.match(stderr.text, /250 B \/ 1000 B \(25%\)/);
  assert.match(stderr.text, /100 B\/s/);
  assert.match(stderr.text, /ETA 8s/);

  const firstRender = stderr.text;
  progress.add(250);
  scheduler.advance(250);
  assert.notEqual(stderr.text, firstRender);
  assert.match(stderr.text, /500 B \/ 1000 B \(50%\)/);
});

test("finalizes visible progress on completion and stops updates", () => {
  const stderr = new TtyCapture();
  const scheduler = new FakeScheduler();
  const progress = new TransferProgress({ label: "Downloading", name: "archive.zip", total: 1_000, stderr, scheduler });

  progress.add(500);
  scheduler.advance(2_500);
  progress.add(500);
  progress.complete();
  const completed = stderr.text;

  assert.match(completed, /1000 B \/ 1000 B \(100%\).*done\n$/);
  scheduler.advance(1_000);
  assert.equal(stderr.text, completed);
});

test("clears visible progress on errors and cancellation", () => {
  for (const finish of ["fail", "cancel"] as const) {
    const stderr = new TtyCapture();
    const scheduler = new FakeScheduler();
    const progress = new TransferProgress({ label: "Uploading", name: "file.bin", total: 100, stderr, scheduler });
    progress.add(50);
    scheduler.advance(2_500);

    progress[finish]();
    const cleaned = stderr.text;

    assert.match(cleaned, /\r\x1b\[2K$/);
    scheduler.advance(1_000);
    assert.equal(stderr.text, cleaned);
  }
});

test("suppresses non-TTY and explicitly disabled progress", () => {
  for (const options of [{ isTTY: false, enabled: true }, { isTTY: true, enabled: false }]) {
    const stderr = new TtyCapture();
    stderr.isTTY = options.isTTY;
    const scheduler = new FakeScheduler();
    const progress = new TransferProgress({
      label: "Uploading",
      name: "file.bin",
      total: 100,
      stderr,
      scheduler,
      enabled: options.enabled,
    });
    progress.add(50);
    scheduler.advance(3_000);
    progress.complete();
    assert.equal(stderr.text, "");
  }
});

test("clears progress and restores signal behavior before forwarding signals", () => {
  const stderr = new TtyCapture();
  const scheduler = new FakeScheduler();
  const signals = new FakeSignals();
  const progress = new TransferProgress({ label: "Downloading", name: "file.bin", stderr, scheduler, signals });
  progress.add(50);
  scheduler.advance(2_500);

  signals.emit("SIGINT");

  assert.match(stderr.text, /\r\x1b\[2K$/);
  assert.deepEqual(signals.forwarded, ["SIGINT"]);
  assert.equal(signals.listeners.size, 0);
});

test("tracks stream fixtures and handles unknown totals", async () => {
  const stderr = new TtyCapture();
  const scheduler = new FakeScheduler();
  const progress = new TransferProgress({ label: "Downloading", name: "stream.bin", stderr, scheduler });
  const sink = new TtyCapture();

  await pipeline(Readable.from([Buffer.alloc(400), Buffer.alloc(600)]), progress.track(), sink);
  scheduler.advance(2_500);

  assert.equal(sink.byteLength, 1_000);
  assert.match(stderr.text, /Downloading stream\.bin: 1000 B 400 B\/s/);
  assert.doesNotMatch(stderr.text, /%|ETA| \/ /);
  progress.complete();
});

test("sanitizes untrusted names before writing terminal controls", () => {
  const stderr = new TtyCapture();
  const scheduler = new FakeScheduler();
  const progress = new TransferProgress({ label: "Uploading", name: "bad\r\n\x1b[31m.bin", total: 0, stderr, scheduler });

  scheduler.advance(2_500);
  progress.complete();

  const rendered = stderr.text.replaceAll("\r\x1b[2K", "");
  assert.doesNotMatch(rendered, /[\r\x1b]/);
  assert.match(rendered, /bad\?\?\?\[31m\.bin: 0 B \/ 0 B \(100%\)/);
});

test("propagates upload source errors through the tracked stream", async () => {
  const stderr = new TtyCapture();
  const scheduler = new FakeScheduler();
  const progress = new TransferProgress({ label: "Uploading", name: "broken.bin", stderr, scheduler });
  const source = new Readable({
    read() {
      this.push(Buffer.alloc(10));
      this.destroy(new Error("read failed"));
    },
  });

  await assert.rejects(async () => {
    for await (const _chunk of progress.trackReadable(source)) { /* consume */ }
  }, /read failed/);
  progress.fail();
});

test("finishes upload tracking when the source ends before the delay", async () => {
  const stderr = new TtyCapture();
  const scheduler = new FakeScheduler();
  const progress = new TransferProgress({ label: "Uploading", name: "fast.bin", total: 10, stderr, scheduler });

  for await (const _chunk of progress.trackReadable(Readable.from([Buffer.alloc(10)]))) { /* consume */ }
  scheduler.advance(2_500);

  assert.equal(stderr.text, "");
});
