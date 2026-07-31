// Finding 6: permanent deletion must be a managed two-phase protocol —
// stage the object into an ID-linked tombstone, transactionally remove
// metadata, then clean the tombstone — with explicit recovery. The core
// invariant, under ANY single fault: never metadata-less bytes in the live
// store, and never a metadata row whose bytes are unrecoverable.
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { AppError } from "./errors";
import { FileService } from "./service";

const TOKEN = "a-test-secret-with-enough-entropy";

// Fault-injection access to the protected phase methods and repository.
interface Phases {
  stageObject: (live: string, tombstone: string) => Promise<void>;
  restoreObject: (tombstone: string, live: string) => Promise<void>;
  removeTombstone: (tombstone: string) => Promise<void>;
  repository: { delete: (id: string) => Promise<unknown> };
}

function phases(service: FileService): Phases {
  return service as unknown as Phases;
}

async function* bytes(value: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(value);
}

describe("deletion protocol", { concurrency: false }, () => {
  let directory: string;
  let objectsDir: string;
  let service: FileService;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fs-delete-test-"));
    objectsDir = path.join(directory, "objects");
    service = await FileService.create({
      token: TOKEN,
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: objectsDir,
      publicUrl: "https://files.example.test",
      maxUploadBytes: 1024 * 1024,
      minFreeBytes: 0,
    });
  });

  after(async () => {
    await service.repository.close();
    await chmod(objectsDir, 0o755).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  afterEach(async () => {
    await chmod(objectsDir, 0o755).catch(() => undefined);
  });

  async function upload(name: string) {
    return service.upload(bytes(`payload of ${name}`), {
      name,
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "application/octet-stream",
    });
  }

  async function liveObjects(): Promise<string[]> {
    const entries = await readdir(objectsDir);
    return entries.filter((entry) => !entry.startsWith(".")).sort();
  }

  it("never strands untracked bytes in the live store when the object cannot be removed", async () => {
    const file = await upload("stranded.bin");
    // Fault injection: the store directory becomes immutable, so any rename
    // or unlink inside it fails with EACCES.
    await chmod(objectsDir, 0o555);
    await assert.rejects(service.delete(file.id));
    await chmod(objectsDir, 0o755);

    const row = await service.get(file.id);
    const live = await liveObjects();
    if (row === null) {
      // Metadata is gone — the live store must not still hold the bytes.
      assert.ok(
        !live.includes(file.storageKey),
        `untracked bytes left in live store: ${live.join(", ")}`,
      );
    } else {
      // Metadata survived — the object must still be readable.
      assert.equal(
        await readFile(service.storagePath(row), "utf8"),
        "payload of stranded.bin",
      );
    }
    // Either way the entry must still be deletable afterwards (retry works).
    if (row) {
      const again = await service.delete(file.id);
      assert.equal(again?.id, file.id);
    }
    assert.equal(await service.get(file.id), null);
  });

  it("keeps the entry fully intact when staging fails", async () => {
    const file = await upload("stage-fail.bin");
    const original = phases(service).stageObject;
    phases(service).stageObject = async () => {
      throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" });
    };
    try {
      await assert.rejects(service.delete(file.id), /EPERM/);
    } finally {
      phases(service).stageObject = original;
    }
    const row = await service.get(file.id);
    assert.ok(row);
    assert.equal(row.id, file.id);
    assert.equal(
      await readFile(service.storagePath(row), "utf8"),
      "payload of stage-fail.bin",
    );
    assert.deepEqual(await readdir(service.trashDir), []);
    await service.delete(file.id);
  });

  it("restores the staged object when the metadata delete fails", async () => {
    const file = await upload("db-fail.bin");
    const original = phases(service).repository.delete;
    phases(service).repository.delete = async () => {
      throw new Error("injected database failure");
    };
    try {
      await assert.rejects(service.delete(file.id), /injected database/);
    } finally {
      phases(service).repository.delete = original;
    }
    // Entry intact: metadata present AND bytes back in the live store.
    const row = await service.get(file.id);
    assert.ok(row);
    assert.equal(row.id, file.id);
    assert.equal(
      await readFile(service.storagePath(row), "utf8"),
      "payload of db-fail.bin",
    );
    assert.deepEqual(await readdir(service.trashDir), []);
    // Retry succeeds once the fault clears.
    const retried = await service.delete(file.id);
    assert.equal(retried?.id, file.id);
    assert.equal(await service.get(file.id), null);
    assert.ok(!(await liveObjects()).includes(file.storageKey));
  });

  it("keeps a discoverable tombstone when both the DB delete and the restore fail, and startup recovery restores it", async () => {
    const file = await upload("restore-fail.bin");
    const originalDelete = phases(service).repository.delete;
    const originalRestore = phases(service).restoreObject;
    phases(service).repository.delete = async () => {
      throw new Error("injected database failure");
    };
    phases(service).restoreObject = async () => {
      throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
    };
    try {
      await assert.rejects(service.delete(file.id), /injected database/);
    } finally {
      phases(service).repository.delete = originalDelete;
      phases(service).restoreObject = originalRestore;
    }
    // The row survived and the bytes are safe in the tombstone — nothing
    // is lost, and the record is discoverable for recovery.
    assert.equal((await service.get(file.id))?.id, file.id);
    assert.deepEqual(await readdir(service.trashDir), [file.storageKey]);
    assert.ok(!(await liveObjects()).includes(file.storageKey));

    // Startup recovery restores staged-but-uncommitted objects.
    await service.recoverPendingDeletions();
    assert.deepEqual(await readdir(service.trashDir), []);
    assert.equal(
      await readFile(service.storagePath(file), "utf8"),
      "payload of restore-fail.bin",
    );
    await service.delete(file.id);
  });

  it("retains a retryable tombstone when final cleanup fails, and startup recovery completes it", async () => {
    const file = await upload("cleanup-fail.bin");
    const original = phases(service).removeTombstone;
    phases(service).removeTombstone = async () => {
      throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
    };
    let outcome;
    try {
      outcome = await service.delete(file.id);
    } finally {
      phases(service).removeTombstone = original;
    }
    // The deletion is committed (API semantics preserved) …
    assert.equal(outcome?.id, file.id);
    assert.equal(await service.get(file.id), null);
    // … the live store holds no untracked bytes, and the tombstone remains
    // as the retryable cleanup record.
    assert.ok(!(await liveObjects()).includes(file.storageKey));
    assert.deepEqual(await readdir(service.trashDir), [file.storageKey]);

    // Startup recovery retries the cleanup for committed deletions.
    await service.recoverPendingDeletions();
    assert.deepEqual(await readdir(service.trashDir), []);
  });

  it("recovers a crash between staging and the metadata delete", async () => {
    const file = await upload("crash-window.bin");
    // Simulate the crash window: object staged, row still present, process
    // gone before the DB delete.
    await rename(
      service.storagePath(file),
      service.tombstonePath(file.storageKey),
    );

    // A restart on the same directories restores the object.
    const restarted = await FileService.create({
      token: TOKEN,
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: objectsDir,
      publicUrl: "https://files.example.test",
      maxUploadBytes: 1024 * 1024,
      minFreeBytes: 0,
    });
    try {
      assert.deepEqual(await readdir(restarted.trashDir), []);
      assert.equal(
        await readFile(restarted.storagePath(file), "utf8"),
        "payload of crash-window.bin",
      );
      assert.equal((await restarted.get(file.id))?.id, file.id);
      await restarted.delete(file.id);
    } finally {
      await restarted.repository.close();
    }
  });

  it("treats an ambiguous post-commit DB failure as committed — never a live orphan", async () => {
    // The repository performs the REAL committed delete and then throws
    // (e.g. the connection drops after the transaction landed). Restoring
    // the tombstone here would recreate metadata-less live bytes.
    const file = await upload("post-commit.bin");
    const original = phases(service).repository.delete;
    phases(service).repository.delete = async (id: string) => {
      await original.call(service.repository, id);
      throw new Error("connection lost after commit");
    };
    let outcome: unknown;
    let failure: unknown = null;
    try {
      outcome = await service.delete(file.id);
    } catch (error) {
      failure = error;
    } finally {
      phases(service).repository.delete = original;
    }
    // The row is verifiably gone, so this must surface as a committed
    // deletion (success or a retained retryable tombstone) — never bytes in
    // the live store.
    assert.equal(await service.get(file.id), null);
    assert.ok(
      !(await liveObjects()).includes(file.storageKey),
      "committed delete must not restore bytes into the live store",
    );
    if (failure !== null) {
      // If it still reports failure, the tombstone must stay discoverable.
      assert.deepEqual(await readdir(service.trashDir), [file.storageKey]);
    } else {
      assert.ok((outcome as { id?: string })?.id === file.id);
    }
    await service.recoverPendingDeletions();
    assert.deepEqual(await readdir(service.trashDir), []);
  });

  it("leaves the tombstone unrestored when post-failure verification itself fails", async () => {
    const file = await upload("verify-fail.bin");
    const originalDelete = phases(service).repository.delete;
    const repo = service.repository as unknown as {
      get: (id: string) => Promise<unknown>;
    };
    const originalGet = repo.get;
    phases(service).repository.delete = async () => {
      // From this point the DB is unreachable: the delete fails AND the
      // verification read fails.
      repo.get = async () => {
        throw new Error("database unreachable");
      };
      throw new Error("database unreachable");
    };
    try {
      await assert.rejects(service.delete(file.id), /database unreachable/);
    } finally {
      phases(service).repository.delete = originalDelete;
      repo.get = originalGet;
    }
    // Unverifiable state: the object must NOT be restored into the live
    // store; the tombstone stays discoverable and the row is intact, so
    // startup recovery restores it once the DB is reachable again.
    assert.ok(!(await liveObjects()).includes(file.storageKey));
    assert.deepEqual(await readdir(service.trashDir), [file.storageKey]);
    assert.equal((await service.get(file.id))?.id, file.id);
    await service.recoverPendingDeletions();
    assert.deepEqual(await readdir(service.trashDir), []);
    assert.equal(
      await readFile(service.storagePath(file), "utf8"),
      "payload of verify-fail.bin",
    );
    await service.delete(file.id);
  });

  it("serves complete bytes to a read that begins mid-deletion, and a privacy 404 after commit", async () => {
    const file = await upload("concurrent-read.bin");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const originalStage = phases(service).stageObject;
    // Hold deletion AFTER the object is staged, while metadata still exists.
    phases(service).stageObject = async (live: string, tombstone: string) => {
      await originalStage.call(service, live, tombstone);
      await held;
    };
    let deletion: Promise<unknown>;
    try {
      deletion = service.delete(file.id);
      const tombstone = service.tombstonePath(file.storageKey);
      const deadline = Date.now() + 5_000;
      for (;;) {
        try {
          await access(tombstone);
          break;
        } catch {
          assert.ok(Date.now() < deadline, "object was never staged");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      // A request that already resolved the metadata row must acquire its
      // file descriptor BEFORE the response — from live or tombstone — and
      // an in-flight deletion must not invalidate it.
      const stream = await service.trackedDownloadStream(file);
      release();
      await deletion;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      assert.equal(
        Buffer.concat(chunks).toString("utf8"),
        "payload of concurrent-read.bin",
      );
    } finally {
      phases(service).stageObject = originalStage;
      release();
    }
    // The deletion committed: a NEW read from the same stale metadata must
    // be a privacy-preserving 404 — never ENOENT or a 500.
    await assert.rejects(
      (async () => {
        const late = await service.trackedDownloadStream(file);
        for await (const chunk of late) void chunk;
      })(),
      (error: unknown) => {
        assert.ok(
          error instanceof AppError,
          `expected AppError, got ${String(error)}`,
        );
        assert.equal(error.status, 404);
        return true;
      },
    );
    // Retry semantics: a second delete of the committed entry is a clean
    // not-found, and nothing lingers.
    assert.equal(await service.delete(file.id), null);
    assert.deepEqual(await readdir(service.trashDir), []);
    assert.ok(!(await liveObjects()).includes(file.storageKey));
  });

  it("deletes idempotently and preserves read semantics", async () => {
    const file = await upload("plain-delete.bin");
    const deleted = await service.delete(file.id);
    assert.equal(deleted?.id, file.id);
    // Success cleanup: no tombstone, no live object, no metadata.
    assert.deepEqual(await readdir(service.trashDir), []);
    assert.ok(!(await liveObjects()).includes(file.storageKey));
    assert.equal(await service.get(file.id), null);
    // A second delete reports not-found (maps to the privacy-preserving 404).
    assert.equal(await service.delete(file.id), null);
    // The object bytes are no longer accessible.
    await assert.rejects(access(service.storagePath(file)), {
      code: "ENOENT",
    });
  });
});
