import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const TERM_GRACE_MS = 250;
const GROUP_DEATH_WAIT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface ActiveJob {
  terminate: (error: Error) => Promise<void>;
}

const activeJobs = new Map<number, ActiveJob>();

export class AdmittedJobProcessDeadlineError extends Error {
  constructor() {
    super("admitted-job deadline exceeded");
    this.name = "AdmittedJobProcessDeadlineError";
  }
}

export class AdmittedJobProcessCancelledError extends Error {
  constructor() {
    super("admitted-job cancelled");
    this.name = "AdmittedJobProcessCancelledError";
  }
}

export interface AdmittedJobOutcome {
  processed: boolean;
  outcomeError?: string;
}

export function validateAdmittedJobOutcome(
  outcome: unknown,
): AdmittedJobOutcome {
  if (
    !outcome ||
    typeof outcome !== "object" ||
    typeof (outcome as Partial<AdmittedJobOutcome>).processed !== "boolean" ||
    ((outcome as Partial<AdmittedJobOutcome>).outcomeError !== undefined &&
      typeof (outcome as Partial<AdmittedJobOutcome>).outcomeError !== "string")
  ) {
    throw new Error("invalid admitted job outcome");
  }
  const validated = outcome as AdmittedJobOutcome;
  if (validated.outcomeError) throw new Error("admitted job reported failure");
  return validated;
}

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

async function terminateProcessGroup(pid: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  const escalationAt = Date.now() + TERM_GRACE_MS;
  while (groupAlive(pid) && Date.now() < escalationAt)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
  const deathDeadline = Date.now() + GROUP_DEATH_WAIT_MS;
  while (groupAlive(pid)) {
    if (Date.now() >= deathDeadline)
      throw new Error("admitted-job process group did not terminate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function cancelActiveAdmittedJobs(): Promise<void> {
  await Promise.allSettled(
    [...activeJobs.values()].map((job) =>
      job.terminate(new AdmittedJobProcessCancelledError()),
    ),
  );
}

export function runAdmittedJobProcess(
  entry: string,
  args: string[],
  deadlineAt: number,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  if (Date.now() >= deadlineAt)
    return Promise.reject(new AdmittedJobProcessDeadlineError());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forcedError: Error | undefined;
    let termination: Promise<void> | undefined;

    const finish = async (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await termination;
      } catch (terminationError) {
        error =
          terminationError instanceof Error
            ? terminationError
            : new Error("admitted-job process termination failed");
      }
      if (pid) activeJobs.delete(pid);
      if (error) reject(error);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    };

    const terminate = (error: Error): Promise<void> => {
      if (forcedError) return termination ?? Promise.resolve();
      forcedError = error;
      termination = pid ? terminateProcessGroup(pid) : Promise.resolve();
      void termination.then(
        () => finish(error),
        (terminationError: unknown) =>
          finish(terminationError instanceof Error ? terminationError : error),
      );
      return termination;
    };
    if (pid) activeJobs.set(pid, { terminate });

    const timer = setTimeout(
      () => void terminate(new AdmittedJobProcessDeadlineError()),
      Math.max(0, deadlineAt - Date.now()),
    );
    timer.unref();

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        void terminate(new Error("admitted-job process output exceeded limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => void finish(error));
    child.once("close", (code, signal) => {
      if (forcedError) return;
      if (pid && groupAlive(pid)) {
        void terminate(new Error("admitted-job child left live descendants"));
        return;
      }
      if (code !== 0) {
        void finish(new Error(`admitted-job child failed (${code ?? signal})`));
        return;
      }
      void finish();
    });
  });
}

export async function cleanupAdmittedAttempt(
  storageRoot: string,
  attemptId: string,
  referencedDerivativeKeys: ReadonlySet<string>,
): Promise<void> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      attemptId,
    )
  )
    throw new Error("invalid admitted attempt id");
  const visit = async (
    namespace: ".image-derivatives" | ".unfurl-job-sources",
    directory: string,
    depth: number,
  ): Promise<void> => {
    if (depth > 4) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.name === attemptId) {
        const relative = path
          .relative(storageRoot, candidate)
          .split(path.sep)
          .join("/");
        const isPublished =
          namespace === ".image-derivatives" &&
          [...referencedDerivativeKeys].some((key) =>
            key.startsWith(`${relative}/`),
          );
        if (!isPublished) await rm(candidate, { recursive: true, force: true });
        continue;
      }
      await visit(namespace, candidate, depth + 1);
    }
  };
  await Promise.all(
    ([".image-derivatives", ".unfurl-job-sources"] as const).map((namespace) =>
      visit(namespace, path.join(storageRoot, namespace), 0),
    ),
  );
}
