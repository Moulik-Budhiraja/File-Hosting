import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { FileService } from "./service";

let directory: string;
let service: FileService;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "worker-health-"));
  service = await FileService.create({
    token: "synthetic-health-token-with-sufficient-entropy",
    databaseUrl: `file:${path.join(directory, "files.db")}`,
    storageDir: path.join(directory, "objects"),
    publicUrl: "https://files.example.test",
    maxUploadBytes: 1024,
    minFreeBytes: 0,
  });
});

after(async () => {
  await service.close();
  await rm(directory, { recursive: true, force: true });
});

describe("persisted derivative worker health", () => {
  it("does not mark a fresh restart healthy before a successful loop", async () => {
    const now = new Date("2026-08-08T08:00:00.000Z");
    await service.repository.recordWorkerHealth(
      "fresh-restart",
      { ready: true },
      now,
    );
    assert.equal(await service.repository.hasHealthyWorker(now, 90_000), false);
  });

  it("keeps runtime errors unhealthy across idle heartbeats until successful work", async () => {
    const now = new Date("2026-08-08T09:00:00.000Z");
    await service.repository.recordWorkerHealth(
      "worker-a",
      { ready: true, error: "runtime: synthetic loop failure" },
      now,
    );
    assert.equal(await service.repository.hasHealthyWorker(now, 90_000), false);
    await service.repository.recordWorkerHealth(
      "worker-a",
      { ready: true },
      new Date(now.getTime() + 1_000),
    );
    assert.equal(
      await service.repository.hasHealthyWorker(
        new Date(now.getTime() + 1_000),
        90_000,
      ),
      false,
      "idle heartbeat must preserve the persisted runtime error",
    );
    await service.repository.recordWorkerHealth(
      "worker-a",
      { ready: true, success: true },
      new Date(now.getTime() + 2_000),
    );
    assert.equal(
      await service.repository.hasHealthyWorker(
        new Date(now.getTime() + 2_000),
        90_000,
      ),
      true,
    );
  });

  it("accepts any recent usable worker and rejects stale rows", async () => {
    const now = new Date("2026-08-08T10:00:00.000Z");
    await service.repository.recordWorkerHealth(
      "failed-peer",
      { ready: true, error: "runtime: peer failure" },
      now,
    );
    await service.repository.recordWorkerHealth(
      "healthy-peer",
      { ready: true, success: true },
      now,
    );
    assert.equal(await service.repository.hasHealthyWorker(now, 90_000), true);
    assert.equal(
      await service.repository.hasHealthyWorker(
        new Date(now.getTime() + 90_001),
        90_000,
      ),
      false,
    );
  });
});
