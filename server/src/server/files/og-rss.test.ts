import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import sharp from "sharp";

import { nativeAdmissionState } from "./native-admission";
import { renderOgImage } from "./og-image";
import { runKillableProcess } from "./process-tree";
import type { FileService } from "./service";
import type { StoredFile } from "./types";
import { buildUnfurlModel } from "./unfurl";

const RSS_FILL_CHUNK_BYTES = 64 * 1024;

function transitiveRssKiB(): number {
  if (process.platform === "win32") return process.memoryUsage().rss / 1024;
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      return match
        ? {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rss: Number(match[3]),
            command: match[4] ?? "",
          }
        : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const owned = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!owned.has(row.pid) && owned.has(row.ppid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  return rows
    .filter((row) => owned.has(row.pid) && !/(?:^|\/)ps$/u.test(row.command))
    .reduce((total, row) => total + row.rss, 0);
}

test(
  "keeps concurrent 6324px raster extraction and OG rendering below the transitive RSS envelope",
  { skip: process.platform === "win32" },
  async () => {
    sharp.cache(false);
    setFlagsFromString("--expose_gc");
    const collectGarbage = runInNewContext("gc") as () => void;
    collectGarbage();
    collectGarbage();
    setFlagsFromString("--no-expose_gc");

    const generated = await runKillableProcess(
      path.resolve(process.cwd(), "node_modules/ffmpeg-static/ffmpeg"),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=#4b78a8:s=6324x6324",
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-f",
        "image2pipe",
        "pipe:1",
      ],
      {
        timeoutMs: 10_000,
        maxOutputBytes: 8 * 1024 * 1024,
        allowSubprocesses: true,
      },
    );
    const targetBytes = 20 * 1024 * 1024;
    assert.ok(generated.stdout.length <= targetBytes);
    const directory = await mkdtemp(path.join(os.tmpdir(), "fs-og-rss-"));
    const sourcePath = path.join(directory, "large.jpg");
    try {
      const handle = await open(sourcePath, "wx");
      const sourceHash = createHash("sha256");
      try {
        await handle.writeFile(generated.stdout);
        sourceHash.update(generated.stdout);
        const fillChunk = Buffer.alloc(RSS_FILL_CHUNK_BYTES, 0x5a);
        let remaining = targetBytes - generated.stdout.length;
        while (remaining > 0) {
          const chunk = fillChunk.subarray(
            0,
            Math.min(remaining, fillChunk.length),
          );
          await handle.writeFile(chunk);
          sourceHash.update(chunk);
          remaining -= chunk.length;
        }
      } finally {
        await handle.close();
      }
      const sourceSha256 = sourceHash.digest("hex");
      const file: StoredFile = {
        id: "RsS6324",
        name: "large.jpg",
        size: targetBytes,
        mimeType: "image/jpeg",
        sha256: sourceSha256,
        visibility: "public",
        ownerId: null,
        storageKey: "rss-probe",
        archive: null,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
        tags: [],
      };
      const service = {
        config: { publicUrl: "https://files.example.test" },
        storagePath: () => sourcePath,
      } as unknown as FileService;
      let peakKiB = transitiveRssKiB();
      const sampler = setInterval(() => {
        peakKiB = Math.max(peakKiB, transitiveRssKiB());
      }, 25);
      try {
        const cards = await Promise.all(
          Array.from({ length: 3 }, async () => {
            const model = await buildUnfurlModel(service, file);
            return renderOgImage(service, file, model);
          }),
        );
        for (const card of cards)
          assert.equal(card.subarray(1, 4).toString("ascii"), "PNG");
      } finally {
        clearInterval(sampler);
      }
      const peakMiB = peakKiB / 1024;
      process.stdout.write(
        `# transitive RSS probe peak: ${peakMiB.toFixed(1)} MiB\n`,
      );
      assert.ok(
        peakMiB < 360,
        `transitive RSS ${peakMiB.toFixed(1)} MiB exceeded 360 MiB`,
      );
      assert.deepEqual(nativeAdmissionState(), {
        active: 0,
        queued: 0,
        budgetMiB: 384,
      });

      const recoveryPath = path.join(directory, "recovery.txt");
      await writeFile(recoveryPath, "recovery");
      const recoveryFile: StoredFile = {
        ...file,
        id: "Bc4dF6h",
        name: "recovery.txt",
        size: 8,
        mimeType: "text/plain",
        sha256: createHash("sha256").update("recovery").digest("hex"),
        storageKey: "recovery",
      };
      const recoveryService = {
        ...service,
        storagePath: () => recoveryPath,
      } as unknown as FileService;
      const recoveryModel = await buildUnfurlModel(
        recoveryService,
        recoveryFile,
      );
      const recovery = await renderOgImage(
        recoveryService,
        recoveryFile,
        recoveryModel,
      );
      assert.equal(recovery.subarray(1, 4).toString("ascii"), "PNG");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
