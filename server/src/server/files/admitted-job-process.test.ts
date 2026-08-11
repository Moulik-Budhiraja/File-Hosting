import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  cancelActiveAdmittedJobs,
  cleanupAdmittedAttempt,
  runAdmittedJobProcess,
  validateAdmittedJobOutcome,
} from "./admitted-job-process";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await cancelActiveAdmittedJobs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function stallingFixture(stage: string, stubborn = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `admitted-${stage}-`));
  temporaryDirectories.push(directory);
  const entry = path.join(directory, "worker.cjs");
  const pidFile = path.join(directory, "descendant.pid");
  const stubbornSource = stubborn
    ? `const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`
    : "";
  await writeFile(
    entry,
    `const {spawn}=require('node:child_process');const fs=require('node:fs');${stubbornSource}process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
  );
  return { entry, pidFile };
}

function assertDead(pid: number) {
  assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/iu);
}

async function waitForPublishedPid(file: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = Number(await readFile(file, "utf8").catch(() => ""));
    if (Number.isSafeInteger(value) && value > 0) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("descendant pid was not published within the startup bound");
}

describe("whole admitted-job process deadline", () => {
  it("rejects failed or malformed claimed-job outcomes before health can be cleared", () => {
    assert.throws(
      () =>
        validateAdmittedJobOutcome({
          processed: true,
          outcomeError: "synthetic job failure",
        }),
      /admitted job reported failure/u,
    );
    assert.throws(
      () => validateAdmittedJobOutcome({} as { processed: boolean }),
      /invalid admitted job outcome/u,
    );
    assert.deepEqual(validateAdmittedJobOutcome({ processed: false }), {
      processed: false,
    });
  });

  for (const stage of [
    "source-read-fifo",
    "source-hash",
    "unfurl-render",
    "db-publication",
  ]) {
    it(`bounds a stalled ${stage} stage`, async () => {
      const { entry } = await stallingFixture(stage);
      const started = Date.now();
      await assert.rejects(
        runAdmittedJobProcess(entry, [stage], Date.now() + 100),
        /admitted-job deadline/u,
      );
      assert.ok(Date.now() - started < 1_000);
    });
  }

  it("kills an uncooperative grandchild before deadline settlement", async () => {
    if (process.platform === "win32") return;
    const { entry, pidFile } = await stallingFixture("stubborn-tree", true);
    const rejection = assert.rejects(
      runAdmittedJobProcess(entry, [], Date.now() + 1_000),
      /admitted-job deadline/u,
    );
    const descendantPid = await waitForPublishedPid(pidFile, 600);
    await rejection;
    assertDead(descendantPid);
  });

  it("cancels and reaps admitted process trees during shutdown", async () => {
    if (process.platform === "win32") return;
    const { entry, pidFile } = await stallingFixture("shutdown", true);
    const running = runAdmittedJobProcess(entry, [], Date.now() + 30_000);
    while (!(await readFile(pidFile, "utf8").catch(() => "")))
      await new Promise((resolve) => setTimeout(resolve, 5));
    await cancelActiveAdmittedJobs();
    await assert.rejects(running, /cancelled/u);
    assertDead(Number(await readFile(pidFile, "utf8")));
  });

  it("does not expose child diagnostics in persisted runtime errors", async () => {
    const diagnosticDirectory = await mkdtemp(
      path.join(os.tmpdir(), "admitted-diagnostic-"),
    );
    temporaryDirectories.push(diagnosticDirectory);
    const entry = path.join(diagnosticDirectory, "diagnostic.cjs");
    await writeFile(
      entry,
      'process.stderr.write("synthetic-sensitive-diagnostic");process.exit(1);',
    );
    await assert.rejects(
      runAdmittedJobProcess(entry, [], Date.now() + 2_000),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.doesNotMatch(error.message, /synthetic-sensitive-diagnostic/u);
        return true;
      },
    );
  });

  it("cleans only the timed-out owner's unreferenced attempt artifacts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "attempt-cleanup-"));
    temporaryDirectories.push(directory);
    const owner = "11111111-1111-4111-8111-111111111111";
    const sibling = "22222222-2222-4222-8222-222222222222";
    const ownerDerivative = path.join(
      directory,
      ".image-derivatives",
      "Ab3dE5g",
      "stored-webp-v1",
      owner,
    );
    const siblingDerivative = path.join(
      directory,
      ".image-derivatives",
      "Ab3dE5g",
      "stored-webp-v1",
      sibling,
    );
    const ownerUnfurl = path.join(
      directory,
      ".unfurl-job-sources",
      "Ab3dE5g",
      owner,
    );
    const siblingUnfurl = path.join(
      directory,
      ".unfurl-job-sources",
      "Ab3dE5g",
      sibling,
    );
    await Promise.all(
      [ownerDerivative, siblingDerivative, ownerUnfurl, siblingUnfurl].map(
        (candidate) => mkdir(candidate, { recursive: true }),
      ),
    );
    await cleanupAdmittedAttempt(directory, owner, new Set());
    await assert.rejects(access(ownerUnfurl));
    await assert.rejects(access(ownerDerivative));
    await access(siblingUnfurl);

    await mkdir(ownerDerivative, { recursive: true });
    await cleanupAdmittedAttempt(
      directory,
      owner,
      new Set([
        `.image-derivatives/Ab3dE5g/stored-webp-v1/${owner}/small.webp`,
      ]),
    );
    await access(ownerDerivative);
  });
});
