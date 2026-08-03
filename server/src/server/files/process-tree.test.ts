import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { getOgRenderPoolState, renderSvgInWorker } from "./og-image";
import { ProcessDeadlineError, runKillableProcess } from "./process-tree";

const temporaryDirectories: string[] = [];

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForPids(file: string): Promise<number[]> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const values = (await readFile(file, "utf8"))
        .trim()
        .split(/\s+/u)
        .map(Number)
        .filter(Number.isSafeInteger);
      if (values.length === 3) return values;
    } catch {
      // Launcher has not populated the probe yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("process tree did not publish all pids");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe(
  "hard OG render worker deadlines",
  { skip: process.platform === "win32" },
  () => {
    it("kills launcher, child, and grandchild before releasing the sole slot, repeatedly", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "fs-og-tree-"));
      temporaryDirectories.push(directory);
      const pidFile = path.join(directory, "pids.txt");
      const childScript = path.join(directory, "child.mjs");
      const launcherScript = path.join(directory, "launcher.mjs");
      await writeFile(
        childScript,
        `import { appendFileSync } from "node:fs";\nimport { spawn } from "node:child_process";\nconst grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\nappendFileSync(process.argv[2], \` \${process.pid} \${grandchild.pid}\`);\nsetInterval(() => {}, 1000);\n`,
      );
      await writeFile(
        launcherScript,
        `import { writeFileSync } from "node:fs";\nimport { spawn } from "node:child_process";\nwriteFileSync(process.argv[2], String(process.pid));\nspawn(process.execPath, [process.argv[3], process.argv[2]], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`,
      );

      const rssBefore = process.memoryUsage().rss;
      const unhandled: unknown[] = [];
      const recordUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", recordUnhandled);
      try {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          let pids: number[] = [];
          const run = renderSvgInWorker(Buffer.from("<svg/>"), {
            workerPath: launcherScript,
            workerArguments: [pidFile, childScript],
            timeoutMs: 150,
            allowSubprocesses: true,
          });
          const rejection = assert.rejects(run, ProcessDeadlineError);
          try {
            pids = await waitForPids(pidFile);
            await rejection;
            assert.deepEqual(getOgRenderPoolState(), { active: 0, queued: 0 });
            for (const pid of pids) {
              assert.equal(
                processExists(pid),
                false,
                `pid ${pid} survived timeout`,
              );
            }
          } finally {
            await rejection;
            for (const pid of pids) {
              if (processExists(pid)) process.kill(pid, "SIGKILL");
            }
            await rm(pidFile, { force: true });
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(
          unhandled,
          [],
          "deadline runs must stay rejection-handled",
        );
      } finally {
        process.off("unhandledRejection", recordUnhandled);
      }

      assert.ok(
        process.memoryUsage().rss - rssBefore < 64 * 1024 * 1024,
        "repeated timeouts must not cause unbounded launcher-side RSS growth",
      );

      const output = await renderSvgInWorker(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
        ),
      );
      assert.equal(output.subarray(1, 4).toString("ascii"), "PNG");
      assert.deepEqual(getOgRenderPoolState(), { active: 0, queued: 0 });
    });

    it("retains ownership when an early-exited child leaves inherited pipes with a descendant", async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "fs-og-inherited-"),
      );
      temporaryDirectories.push(directory);
      const pidFile = path.join(directory, "pids.txt");
      const launcher = path.join(directory, "launcher.mjs");
      await writeFile(
        launcher,
        `import { appendFileSync } from "node:fs";\nimport { spawn } from "node:child_process";\nappendFileSync(process.argv[2], String(process.pid));\nconst descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });\nappendFileSync(process.argv[2], \` \${descendant.pid}\`);\nprocess.exit(0);\n`,
      );

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const run = runKillableProcess(process.execPath, [launcher, pidFile], {
          timeoutMs: 400,
          maxOutputBytes: 1024,
          allowSubprocesses: true,
        });
        const rejection = assert.rejects(run, ProcessDeadlineError);
        let pids: number[] = [];
        for (let poll = 0; poll < 30 && pids.length !== 2; poll += 1) {
          try {
            pids = (await readFile(pidFile, "utf8"))
              .trim()
              .split(/\s+/u)
              .map(Number)
              .filter(Number.isSafeInteger);
          } catch {
            // Launcher has not published both identities yet.
          }
          if (pids.length !== 2)
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(pids.length, 2);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(
          processExists(pids[0] ?? 0),
          false,
          "launcher must exit early",
        );
        assert.equal(
          processExists(pids[1] ?? 0),
          true,
          "descendant must still hold the pipe",
        );
        await rejection;
        assert.equal(
          processExists(pids[1] ?? 0),
          false,
          "owned descendant survived settlement",
        );
        await rm(pidFile, { force: true });
      }
    });

    it(
      "fails closed by denying a setsid descendant before the hard bound",
      { skip: process.platform !== "darwin" },
      async () => {
        await access("/usr/bin/sandbox-exec");
        const directory = await mkdtemp(
          path.join(os.tmpdir(), "fs-og-setsid-"),
        );
        temporaryDirectories.push(directory);
        const pidFile = path.join(directory, "escaped-pid.txt");
        const launcher = path.join(directory, "launcher.mjs");
        await writeFile(
          launcher,
          `import { writeFileSync } from "node:fs";\nimport { spawn } from "node:child_process";\nconst child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });\nwriteFileSync(process.argv[2], String(child.pid));\nprocess.exit(0);\n`,
        );
        let escapedPid = 0;
        const started = Date.now();
        try {
          const run = runKillableProcess(
            process.execPath,
            [launcher, pidFile],
            {
              timeoutMs: 150,
              maxOutputBytes: 1024,
            },
          );
          await assert.rejects(
            Promise.race([
              run,
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("hard rejection bound exceeded")),
                  750,
                ),
              ),
            ]),
            /process execution failed|process deadline exceeded/u,
          );
          assert.ok(Date.now() - started < 750);
          try {
            const candidate = Number(await readFile(pidFile, "utf8"));
            if (Number.isSafeInteger(candidate)) escapedPid = candidate;
          } catch {
            // Fork denial can prevent the pid file from being created.
          }
          assert.equal(
            escapedPid,
            0,
            "Darwin process-fork sandbox must deny descendant creation",
          );
        } finally {
          if (escapedPid && processExists(escapedPid)) {
            process.kill(escapedPid, "SIGKILL");
          }
        }
      },
    );

    it("bounds the deadline from enqueue through process completion", async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "fs-og-deadline-"),
      );
      temporaryDirectories.push(directory);
      const worker = path.join(directory, "worker.mjs");
      await writeFile(
        worker,
        `const delay = Number(process.argv[2]);\nsetTimeout(() => process.exit(0), delay);\n`,
      );

      const blocker = renderSvgInWorker(Buffer.from("<svg/>"), {
        workerPath: worker,
        workerArguments: ["300"],
        timeoutMs: 1_000,
        allowSubprocesses: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const started = Date.now();
      await assert.rejects(
        renderSvgInWorker(Buffer.from("<svg/>"), {
          workerPath: worker,
          workerArguments: ["0"],
          timeoutMs: 150,
        }),
        /Preview rendering is busy/u,
      );
      assert.ok(
        Date.now() - started < 300,
        "queued work exceeded its total deadline",
      );
      await blocker;
      assert.deepEqual(getOgRenderPoolState(), { active: 0, queued: 0 });
    });

    it("returns successful binary stdout unchanged and discards diagnostics", async () => {
      const binary = Buffer.from([0, 255, 1, 254, 2, 253]);
      const result = await runKillableProcess(
        process.execPath,
        [
          "-e",
          `process.stdout.write(Buffer.from(${JSON.stringify([...binary])})); process.stderr.write("ffmpeg diagnostic");`,
        ],
        { timeoutMs: 1_000, maxOutputBytes: 1024 },
      );
      assert.deepEqual(result.stdout, binary);
      assert.deepEqual(Object.keys(result), ["stdout"]);
    });

    it("enforces one combined stdout and stderr budget without exposing stderr", async () => {
      await assert.rejects(
        runKillableProcess(
          process.execPath,
          [
            "-e",
            'process.stdout.write("123456"); process.stderr.write("abcdef");',
          ],
          { timeoutMs: 1_000, maxOutputBytes: 10 },
        ),
        /process output limit exceeded/u,
      );
    });

    it("enforces the output budget without exposing child stderr", async () => {
      await assert.rejects(
        runKillableProcess(
          process.execPath,
          [
            "-e",
            'process.stdout.write("12345678901"); process.stderr.write("sensitive diagnostic");',
          ],
          { timeoutMs: 1_000, maxOutputBytes: 10 },
        ),
        /process output limit exceeded/u,
      );
    });
  },
);
