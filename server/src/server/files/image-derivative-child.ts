import { spawn } from "node:child_process";

import type { GeneratedDerivative } from "./image-derivatives";

const MAX_STDOUT_BYTES = 24 * 1024 * 1024;
const TERM_GRACE_MS = 250;
const GROUP_DEATH_WAIT_MS = 5_000;
const activeChildren = new Map<number, Promise<void>>();

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForGroupDeath(
  pid: number,
  deadlineAt: number,
): Promise<void> {
  while (groupAlive(pid)) {
    if (Date.now() >= deadlineAt)
      throw new Error("image derivative process group did not terminate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function terminateGroupAndWait(pid: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  const escalationAt = Date.now() + TERM_GRACE_MS;
  while (groupAlive(pid) && Date.now() < escalationAt)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
  await waitForGroupDeath(pid, Date.now() + GROUP_DEATH_WAIT_MS);
}

export async function cancelActiveRenderChildren(): Promise<void> {
  await Promise.allSettled(
    [...activeChildren.entries()].map(async ([pid, existing]) => {
      await Promise.race([existing, terminateGroupAndWait(pid)]);
    }),
  );
}

export class AdmittedJobDeadlineError extends Error {
  constructor() {
    super("image derivative admitted-job deadline exceeded");
    this.name = "AdmittedJobDeadlineError";
  }
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
        detached:
          process.platform !== "win32" &&
          process.env.FS_ADMITTED_JOB_CHILD !== "1",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    const pid = child.pid;
    let size = 0;
    let settled = false;
    let deadlineError: Error | undefined;
    let termination: Promise<void> | undefined;
    let terminationRequested = false;
    if (pid) {
      termination = new Promise<void>((resolveTermination) => {
        child.once("close", () => resolveTermination());
      }).then(async () => {
        if (
          !terminationRequested &&
          process.platform !== "win32" &&
          groupAlive(pid)
        )
          await terminateGroupAndWait(pid);
      });
      activeChildren.set(pid, termination);
      void termination.finally(() => activeChildren.delete(pid));
    }
    const finish = async (
      error?: Error,
      value?: Record<string, GeneratedDerivative>,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await termination;
      } catch (terminationError) {
        error =
          terminationError instanceof Error
            ? terminationError
            : new Error("image derivative process group termination failed");
      }
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const terminateThenFinish = (error: Error) => {
      if (!pid) {
        void finish(error);
        return;
      }
      terminationRequested = true;
      const killed = terminateGroupAndWait(pid);
      termination = killed;
      activeChildren.set(pid, killed);
      void killed.then(
        () => finish(error),
        (terminationError: unknown) =>
          finish(terminationError instanceof Error ? terminationError : error),
      );
    };
    const timer = setTimeout(() => {
      deadlineError = new AdmittedJobDeadlineError();
      terminateThenFinish(deadlineError);
    }, remaining);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) {
        terminateThenFinish(
          new Error("image derivative child output exceeded limit"),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error) => void finish(error));
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (deadlineError) return;
      if (code !== 0) {
        void finish(
          new Error(`image derivative child failed (${code ?? signal})`),
        );
        return;
      }
      try {
        const parsed = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Record<
          string,
          Omit<GeneratedDerivative, "bytes"> & { bytes: string }
        >;
        void finish(
          undefined,
          Object.fromEntries(
            Object.entries(parsed).map(([profile, item]) => [
              profile,
              { ...item, bytes: Buffer.from(item.bytes, "base64") },
            ]),
          ),
        );
      } catch {
        void finish(
          new Error("image derivative child returned invalid output"),
        );
      }
    });
    child.stdin.end(JSON.stringify({ sourcePath, deadlineAt }));
  });
}
