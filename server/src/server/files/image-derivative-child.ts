import { spawn } from "node:child_process";

import type { GeneratedDerivative } from "./image-derivatives";

const MAX_STDOUT_BYTES = 24 * 1024 * 1024;
const KILL_WAIT_MS = 5_000;
const activeChildren = new Set<number>();

export function cancelActiveRenderChildren(): void {
  for (const pid of activeChildren) terminateGroup(pid);
}

export class AdmittedJobDeadlineError extends Error {
  constructor() {
    super("image derivative admitted-job deadline exceeded");
    this.name = "AdmittedJobDeadlineError";
  }
}

function terminateGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch {}
  }, KILL_WAIT_MS).unref();
}

export async function generateDerivativesInChild(
  workerEntry: string,
  sourcePath: string,
  deadlineAt: number,
): Promise<Record<string, GeneratedDerivative>> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new AdmittedJobDeadlineError();
  return new Promise<Record<string, GeneratedDerivative>>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=384", workerEntry, "--render-child"],
      {
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    if (child.pid) activeChildren.add(child.pid);
    let size = 0;
    let settled = false;
    let deadlineError: Error | undefined;
    const finish = (
      error?: Error,
      value?: Record<string, GeneratedDerivative>,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const timer = setTimeout(() => {
      deadlineError = new AdmittedJobDeadlineError();
      terminateGroup(child.pid);
    }, remaining);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) {
        terminateGroup(child.pid);
        finish(new Error("image derivative child output exceeded limit"));
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (child.pid) activeChildren.delete(child.pid);
      if (settled) return;
      if (deadlineError) {
        finish(deadlineError);
        return;
      }
      if (code !== 0) {
        finish(new Error(`image derivative child failed (${code ?? signal})`));
        return;
      }
      try {
        const parsed = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Record<
          string,
          Omit<GeneratedDerivative, "bytes"> & { bytes: string }
        >;
        finish(
          undefined,
          Object.fromEntries(
            Object.entries(parsed).map(([profile, item]) => [
              profile,
              { ...item, bytes: Buffer.from(item.bytes, "base64") },
            ]),
          ),
        );
      } catch {
        finish(new Error("image derivative child returned invalid output"));
      }
    });
    child.stdin.end(JSON.stringify({ sourcePath, deadlineAt }));
  });
}
