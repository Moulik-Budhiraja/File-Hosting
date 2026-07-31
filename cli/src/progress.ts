import { Transform, type Readable } from "node:stream";
import { formatBytes } from "./output.js";

export interface ProgressScheduler {
  now(): number;
  setTimeout(callback: () => void, delay: number): object;
  clearTimeout(handle: object): void;
  setInterval(callback: () => void, delay: number): object;
  clearInterval(handle: object): void;
}

export interface ProgressSignals {
  on(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
  forward(signal: NodeJS.Signals): void;
}

function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}

const processSignals: ProgressSignals = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
  forward: (signal) => process.kill(process.pid, signal),
};

const scheduler: ProgressScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export class TransferProgress {
  private transferred = 0;
  private readonly startedAt: number;
  private readonly delay?: object;
  private updates?: object;
  private readonly enabled: boolean;
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();
  private visible = false;
  private finished = false;

  constructor(private readonly options: {
    label: string;
    name: string;
    total?: number;
    stderr: NodeJS.WritableStream;
    scheduler?: ProgressScheduler;
    signals?: ProgressSignals;
    enabled?: boolean;
  }) {
    this.options.scheduler ??= scheduler;
    this.options.signals ??= processSignals;
    this.startedAt = this.options.scheduler.now();
    this.enabled = (this.options.enabled ?? true) && Boolean((this.options.stderr as NodeJS.WritableStream & { isTTY?: boolean }).isTTY);
    if (!this.enabled) return;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        this.cancel();
        this.options.signals!.forward(signal);
      };
      this.signalHandlers.set(signal, handler);
      this.options.signals.on(signal, handler);
    }
    this.delay = this.options.scheduler.setTimeout(() => {
      if (this.finished) return;
      this.visible = true;
      this.render();
      this.updates = this.options.scheduler!.setInterval(() => this.render(), 250);
    }, 2_500);
  }

  add(bytes: number): void {
    this.transferred += bytes;
  }

  track(): Transform {
    return new Transform({
      transform: (chunk: Buffer | string, encoding, callback) => {
        this.add(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding));
        callback(null, chunk);
      },
    });
  }

  trackReadable(source: Readable): Readable {
    const tracker = this.track();
    source.once("error", (error) => tracker.destroy(error));
    tracker.once("end", () => this.complete());
    tracker.once("error", () => this.fail());
    return source.pipe(tracker);
  }

  complete(): void {
    if (this.finished) return;
    this.stopTimers();
    if (this.visible) this.render(" done\n");
    this.finished = true;
  }

  fail(): void { this.clear(); }

  cancel(): void { this.clear(); }

  private clear(): void {
    if (this.finished) return;
    this.stopTimers();
    if (this.visible) this.options.stderr.write("\r\x1b[2K");
    this.finished = true;
  }

  private stopTimers(): void {
    if (this.delay) this.options.scheduler!.clearTimeout(this.delay);
    if (this.updates) this.options.scheduler!.clearInterval(this.updates);
    for (const [signal, handler] of this.signalHandlers) this.options.signals!.off(signal, handler);
    this.signalHandlers.clear();
  }

  private render(suffix = ""): void {
    if (this.finished) return;
    const elapsed = Math.max((this.options.scheduler!.now() - this.startedAt) / 1_000, 0.001);
    const rate = this.transferred / elapsed;
    const total = this.options.total;
    const percentage = total === undefined ? undefined : total === 0 ? 100 : Math.min(100, Math.floor((this.transferred / total) * 100));
    const amount = total === undefined
      ? formatBytes(this.transferred)
      : `${formatBytes(this.transferred)} / ${formatBytes(total)} (${percentage}%)`;
    const eta = total !== undefined && rate > 0
      ? ` ETA ${Math.max(0, Math.ceil((total - this.transferred) / rate))}s`
      : "";
    this.options.stderr.write(`\r\x1b[2K${terminalText(this.options.label)} ${terminalText(this.options.name)}: ${amount} ${formatBytes(Math.round(rate))}/s${eta}${suffix}`);
  }
}
