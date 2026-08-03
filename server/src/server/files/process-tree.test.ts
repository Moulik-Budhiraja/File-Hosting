import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const run = renderSvgInWorker(Buffer.from("<svg/>"), {
          workerPath: launcherScript,
          workerArguments: [pidFile, childScript],
          timeoutMs: 150,
        });
        const pids = await waitForPids(pidFile);
        await assert.rejects(run, ProcessDeadlineError);
        assert.deepEqual(getOgRenderPoolState(), { active: 0, queued: 0 });
        for (const pid of pids) {
          assert.equal(
            processExists(pid),
            false,
            `pid ${pid} survived timeout`,
          );
        }
        await rm(pidFile, { force: true });
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

    it("enforces one combined stdout and stderr output budget", async () => {
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
  },
);
