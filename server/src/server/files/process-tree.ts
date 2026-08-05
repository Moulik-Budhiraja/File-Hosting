import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { linuxSandboxArguments } from "../../../runtime/linux-sandbox.js";

export interface KillableProcessOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
  /** Darwin-only escape hatch for trusted test harnesses that exercise child trees. */
  allowSubprocesses?: boolean;
  /** Darwin sandbox mode for native codecs that require worker threads. */
  allowSandboxForks?: boolean;
}

export interface KillableProcessResult {
  stdout: Buffer;
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

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const taskkill = path.win32.join(
      process.env.SystemRoot ?? String.raw`C:\Windows`,
      "System32",
      "taskkill.exe",
    );
    const result = spawnSync(
      taskkill,
      ["/PID", String(child.pid), "/T", "/F"],
      {
        shell: false,
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      },
    );
    if (result.status === 0) return;
  }
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

// The direct child is an identity-safe ownership sentinel. It cannot exit while
// the command or any descendant still holds an inherited output pipe, so its
// detached process-group remains live and owned until settlement.
const SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const spec = JSON.parse(process.argv[1]);
const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  shell: false,
  stdio: [spec.hasInput ? "pipe" : "ignore", "pipe", "pipe"],
  windowsHide: true,
});
if (spec.hasInput) process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("error", () => {
  process.exitCode = 127;
});
child.once("close", (code, signal) => {
  if (spec.hasInput) process.stdin.unpipe(child.stdin);
  process.stdin.destroy();
  const exitCode = typeof code === "number" ? code : signal ? 128 : 1;
  process.stdout.write("", () => process.exit(exitCode));
});
`;

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
    const sandboxRootArguments = linuxSandboxArguments(
      process.cwd(),
      options.cwd ?? process.cwd(),
      process.execPath,
    );
    const spawnCommand = restrictForks
      ? "/usr/bin/sandbox-exec"
      : restrictLinux
        ? "/usr/bin/bwrap"
        : command;
    const spawnArguments = restrictForks
      ? [
          "-p",
          options.allowSandboxForks
            ? "(version 1)(allow default)(deny network*)"
            : "(version 1)(allow default)(deny process-fork)(deny network*)",
          command,
          ...arguments_,
        ]
      : restrictLinux
        ? [...sandboxRootArguments, command, ...arguments_]
        : [...arguments_];
    const supervised =
      process.platform !== "win32" || !options.allowSandboxForks;
    const child = spawn(
      supervised ? process.execPath : spawnCommand,
      supervised
        ? [
            "-e",
            SUPERVISOR_SOURCE,
            JSON.stringify({
              command: spawnCommand,
              args: spawnArguments,
              cwd: options.cwd,
              env: options.env,
              hasInput: Boolean(options.input),
            }),
          ]
        : spawnArguments,
      {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.env,
        shell: false,
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let deadlineExceeded = false;
    let outputExceeded = false;
    let spawnError = false;
    let spawnErrorCode: string | undefined;
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
      killProcessTree(child);
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
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = true;
      spawnErrorCode = error.code;
    });
    child.once("close", (code, signal) => {
      if (deadlineExceeded || outputExceeded) return;
      if (spawnError || code !== 0) {
        const reason = spawnError
          ? `spawn ${spawnErrorCode ?? "error"}`
          : typeof code === "number"
            ? `exit ${code}`
            : `signal ${signal ?? "unknown"}`;
        finishReject(
          new ProcessExecutionError(`process execution failed (${reason})`),
        );
        return;
      }
      finishResolve({ stdout: Buffer.concat(stdout) });
    });
  });
}
