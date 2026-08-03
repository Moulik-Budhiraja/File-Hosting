import { spawn } from "node:child_process";

export interface KillableProcessOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
}

export interface KillableProcessResult {
  stdout: Buffer;
  stderr: Buffer;
}

export class ProcessDeadlineError extends Error {
  constructor(message = "process deadline exceeded") {
    super(message);
    this.name = "ProcessDeadlineError";
  }
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group may have exited between the deadline and signal.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Close/reaping below is authoritative.
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs = 1_000,
): Promise<void> {
  if (process.platform === "win32") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      // On Darwin an orphaned, killed descendant can briefly leave the process
      // group unsignalable while launchd reaps it. EPERM is therefore not proof
      // that the group is gone: keep the slot occupied and continue probing.
      if (code !== "EPERM") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("process group did not exit after SIGKILL");
}

export async function runKillableProcess(
  command: string,
  arguments_: readonly string[],
  options: KillableProcessOptions,
): Promise<KillableProcessResult> {
  if (options.timeoutMs < 1 || options.maxOutputBytes < 1) {
    throw new Error("invalid process resource limits");
  }
  return new Promise<KillableProcessResult>((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      shell: false,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let deadlineExceeded = false;
    let outputExceeded = false;
    let spawnError: Error | null = null;
    let treeKillAttempted = false;

    const terminateTreeOnce = (): void => {
      if (treeKillAttempted) return;
      treeKillAttempted = true;
      killProcessTree(child);
    };

    const timer = setTimeout(() => {
      if (treeKillAttempted) return;
      deadlineExceeded = true;
      terminateTreeOnce();
    }, options.timeoutMs);
    timer.unref();

    if (options.input && child.stdin) {
      child.stdin.on("error", () => {
        // A deadline may close stdin before the buffered write completes.
      });
      child.stdin.end(options.input);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        outputExceeded = true;
        terminateTreeOnce();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        outputExceeded = true;
        terminateTreeOnce();
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    const handleClose = async (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): Promise<void> => {
      clearTimeout(timer);
      if ((deadlineExceeded || outputExceeded) && child.pid) {
        try {
          await waitForProcessGroupExit(child.pid);
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("process group reap failed"),
          );
          return;
        }
      }
      if (deadlineExceeded) {
        reject(new ProcessDeadlineError());
        return;
      }
      if (outputExceeded) {
        reject(new Error("process output limit exceeded"));
        return;
      }
      if (spawnError) {
        reject(spawnError);
        return;
      }
      const stderrBuffer = Buffer.concat(stderr);
      if (code !== 0) {
        reject(
          new Error(
            stderrBuffer.toString("utf8").trim() ||
              `process failed (${code ?? signal ?? "unknown"})`,
          ),
        );
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: stderrBuffer });
    };
    child.once("close", (code, signal) => {
      void handleClose(code, signal);
    });
  });
}
