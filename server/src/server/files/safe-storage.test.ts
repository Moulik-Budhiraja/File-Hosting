import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { openSafeSourceFile, readSafeSourceFile } from "./safe-storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "safe-source-"));
  temporaryDirectories.push(directory);
  const root = path.join(directory, "objects");
  await mkdir(path.join(root, "nested"), { recursive: true });
  await writeFile(path.join(root, "nested", "source.bin"), "inside");
  return { directory, root };
}

describe("safe source reads", () => {
  it("rejects final and parent symlinks without following outside storage", async () => {
    const { directory, root } = await fixture();
    const outside = path.join(directory, "outside.bin");
    await writeFile(outside, "inside");
    await symlink(outside, path.join(root, "final-link"));
    await assert.rejects(
      readSafeSourceFile(root, "final-link", 64),
      /symlink|regular|safe|storage/u,
    );

    const outsideDirectory = path.join(directory, "outside-directory");
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, "same.bin"), "inside");
    await symlink(outsideDirectory, path.join(root, "parent-link"));
    await assert.rejects(
      readSafeSourceFile(root, "parent-link/same.bin", 64),
      /symlink|namespace|storage/u,
    );
  });

  it("rejects an outside FIFO immediately instead of blocking on open", async () => {
    if (process.platform === "win32") return;
    const { directory, root } = await fixture();
    const fifo = path.join(directory, "outside.fifo");
    const result = await import("node:child_process").then(({ spawnSync }) =>
      spawnSync("mkfifo", [fifo]),
    );
    assert.equal(result.status, 0);
    await symlink(fifo, path.join(root, "fifo-link"));
    const started = Date.now();
    await assert.rejects(
      readSafeSourceFile(root, "fifo-link", 64),
      /symlink|regular|safe|storage/u,
    );
    assert.ok(Date.now() - started < 100, "FIFO validation blocked");
  });

  it("reads the opened object when the path is replaced and exposes fresh identity", async () => {
    const { root } = await fixture();
    const handle = await openSafeSourceFile(root, "nested/source.bin");
    const replacement = path.join(root, "nested", "replacement.bin");
    await writeFile(replacement, "same-sz");
    await rename(replacement, path.join(root, "nested", "source.bin"));
    try {
      assert.equal(await handle.readFile({ encoding: "utf8" }), "inside");
    } finally {
      await handle.close();
    }
    assert.equal(
      (
        await readSafeSourceFile(root, "nested/source.bin", 64)
      ).bytes.toString(),
      "same-sz",
    );
  });

  it("rejects a final FIFO opened with no-follow and nonblocking flags", async () => {
    if (process.platform === "win32") return;
    const { root } = await fixture();
    const fifo = path.join(root, "nested", "source.fifo");
    const fifoHandle = await open(
      fifo,
      constants.O_CREAT | constants.O_WRONLY,
    ).catch(() => undefined);
    await fifoHandle?.close();
    await rm(fifo, { force: true });
    const result = await import("node:child_process").then(({ spawnSync }) =>
      spawnSync("mkfifo", [fifo]),
    );
    assert.equal(result.status, 0);
    const started = Date.now();
    await assert.rejects(
      readSafeSourceFile(root, "nested/source.fifo", 64),
      /regular/u,
    );
    assert.ok(Date.now() - started < 100, "final FIFO open blocked");
  });
});
