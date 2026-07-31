import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { GET as systemInfo } from "../../app/api/system/route";
import { FileService } from "./service";
import { setFileServiceForTests } from "./singleton";
import { TransferRegistry } from "./transfers";

const TOKEN = "a-test-secret-with-enough-entropy";

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

describe("transfer registry", () => {
  it("tracks concurrent transfers and clears them on end", () => {
    const registry = new TransferRegistry();
    const up = registry.begin("upload", "a.bin", 100);
    const down = registry.begin("download", "b.bin", null);
    assert.equal(registry.list().length, 2);
    registry.progress(up, 40);
    const active = registry
      .list()
      .find((entry) => entry.direction === "upload");
    assert.equal(active?.bytes, 40);
    assert.equal(active?.totalBytes, 100);
    registry.end(up);
    registry.end(down);
    assert.deepEqual(registry.list(), []);
    // Ending twice or progressing a finished transfer must not throw or leak.
    registry.end(up);
    registry.progress(up, 10);
    assert.deepEqual(registry.list(), []);
  });
});

describe("service transfer instrumentation", () => {
  let directory: string;
  let service: FileService;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fs-transfers-test-"));
    service = await FileService.create({
      token: TOKEN,
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: path.join(directory, "objects"),
      publicUrl: "https://files.example.test",
      maxUploadBytes: 4096,
      minFreeBytes: 0,
    });
    setFileServiceForTests(service);
  });

  after(async () => {
    setFileServiceForTests(null);
    await service.repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("registers an upload while it streams and clears it afterwards", async () => {
    let midFlight: ReturnType<FileService["activeTransfers"]> = [];
    async function* observing(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("first ");
      midFlight = service.activeTransfers();
      yield Buffer.from("second");
    }
    await service.upload(observing(), {
      name: "observed.txt",
      tags: [],
      visibility: "public",
      archive: null,
      contentLength: 12,
    });
    assert.equal(midFlight.length, 1);
    assert.equal(midFlight[0]?.direction, "upload");
    assert.equal(midFlight[0]?.name, "observed.txt");
    assert.equal(midFlight[0]?.totalBytes, 12);
    assert.deepEqual(service.activeTransfers(), []);
  });

  it("clears the upload entry when the stream errors", async () => {
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("partial");
      throw new Error("client aborted");
    }
    await assert.rejects(
      service.upload(failing(), {
        name: "broken.txt",
        tags: [],
        visibility: "public",
        archive: null,
      }),
    );
    assert.deepEqual(service.activeTransfers(), []);
  });

  it("tracks a download stream and clears it on early cancellation", async () => {
    const file = await service.upload(chunks("0123456789"), {
      name: "download-me.bin",
      tags: [],
      visibility: "public",
      archive: null,
    });
    const iterator = service
      .trackedDownloadStream(file)
      [Symbol.asyncIterator]();
    await iterator.next();
    assert.equal(service.activeTransfers().length, 1);
    assert.equal(service.activeTransfers()[0]?.direction, "download");
    // Simulate the client disconnecting before the stream is drained.
    await iterator.return?.(undefined);
    assert.deepEqual(service.activeTransfers(), []);
  });

  it("exposes current transfers through /api/system", async () => {
    const response = await systemInfo(
      new Request("http://localhost/api/system", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      transfers: { direction: string }[];
    };
    assert.deepEqual(body.transfers, []);
  });
});
