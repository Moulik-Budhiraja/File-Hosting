import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface KillableProcessOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
  /** Darwin-only escape hatch for trusted test harnesses that exercise child trees. */
  allowSubprocesses?: boolean;
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

export class ProcessExecutionError extends Error {
  constructor(message = "process execution failed") {
    super(message);
    this.name = "ProcessExecutionError";
  }
}

function killProcessTree(
  child: ReturnType<typeof spawn>,
  childExited: boolean,
): void {
  if (child.pid === undefined || childExited) return;
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

export async function runKillableProcess(
  command: string,
  arguments_: readonly string[],
  options: KillableProcessOptions,
): Promise<KillableProcessResult> {
  if (options.timeoutMs < 1 || options.maxOutputBytes < 1) {
    throw new Error("invalid process resource limits");
  }
  const restrictSubprocess = options.allowSubprocesses !== true;
  const restrictForks = process.platform === "darwin" && restrictSubprocess;
  const restrictLinux =
    process.platform === "linux" &&
    process.env.NODE_ENV === "production" &&
    restrictSubprocess;
  if (restrictLinux && !existsSync("/usr/bin/bwrap")) {
    throw new ProcessExecutionError("process sandbox unavailable");
  }
  return new Promise<KillableProcessResult>((resolve, reject) => {
    const sandboxRootArguments = [
      "--die-with-parent",
      "--unshare-all",
      "--new-session",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      process.cwd(),
      process.cwd(),
      "--bind",
      "/tmp",
      "/tmp",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--chdir",
      options.cwd ?? process.cwd(),
    ];
    if (existsSync("/lib"))
      sandboxRootArguments.push("--ro-bind", "/lib", "/lib");
    if (existsSync("/lib64"))
      sandboxRootArguments.push("--ro-bind", "/lib64", "/lib64");
    const spawnCommand = restrictForks
      ? "/usr/bin/sandbox-exec"
      : restrictLinux
        ? "/usr/bin/bwrap"
        : command;
    const spawnArguments = restrictForks
      ? [
          "-p",
          "(version 1)(allow default)(deny process-fork)(deny network*)",
          command,
          ...arguments_,
        ]
      : restrictLinux
        ? [...sandboxRootArguments, command, ...arguments_]
        : [...arguments_];
    const child = spawn(spawnCommand, spawnArguments, {
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
    let spawnError = false;
    let childExited = false;
    let treeKillAttempted = false;
    let settled = false;
    let hardSettleTimer: NodeJS.Timeout | undefined;

    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
      reject(error);
    };
    const finishResolve = (result: KillableProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
      resolve(result);
    };
    const terminateTreeOnce = (): void => {
      if (treeKillAttempted) return;
      treeKillAttempted = true;
      killProcessTree(child, childExited);
      child.stdin?.destroy();
      hardSettleTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finishReject(
          deadlineExceeded
            ? new ProcessDeadlineError()
            : new ProcessExecutionError("process output limit exceeded"),
        );
      }, 250);
    };

    const timer = setTimeout(() => {
      if (settled) return;
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
    child.once("error", () => {
      spawnError = true;
    });
    child.once("exit", () => {
      childExited = true;
    });
    child.once("close", (code) => {
      if (deadlineExceeded || outputExceeded) return;
      if (spawnError || code !== 0) {
        finishReject(new ProcessExecutionError());
        return;
      }
      finishResolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}
