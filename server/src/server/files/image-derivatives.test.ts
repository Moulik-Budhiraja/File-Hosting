import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import sharp from "sharp";

import {
  DERIVATIVE_PROFILES,
  DERIVATIVE_REVISION,
  generateImageDerivatives,
} from "./image-derivatives";
import { FileService } from "./service";
import { processNextDerivativeJob } from "./image-derivative-worker";
import {
  GET as getDerivativeRoute,
  HEAD as headDerivativeRoute,
} from "../../app/raw/[id]/[profile]/route";
import { setFileServiceForTests } from "./singleton";

async function* bytes(value: Buffer): AsyncGenerator<Uint8Array> {
  yield value;
}

describe("stored image derivative profiles", () => {
  it("keeps 768 in the centralized profile contract and rejects stale 750 derivative copy", async () => {
    assert.equal(DERIVATIVE_PROFILES.small.maxWidth, 768);
    const sources = await Promise.all([
      readFile(new URL("./image-derivatives.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../../README.md", import.meta.url), "utf8"),
    ]);
    assert.doesNotMatch(
      sources.join("\n"),
      /(?:small|max(?:imum)? width)[^\n]{0,40}\b750\b/iu,
    );
  });
  it("generates versioned static WebP profiles with bounded dimensions and no upscaling", async () => {
    const source = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 25, g: 90, b: 160 },
      },
    })
      .jpeg()
      .toBuffer();

    const generated = await generateImageDerivatives(source);

    assert.equal(DERIVATIVE_REVISION, "image-derivatives-v1");
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(DERIVATIVE_PROFILES).map(([name, profile]) => [
          name,
          [profile.maxWidth, profile.quality, profile.maxBytes],
        ]),
      ),
      {
        thumbnail: [320, 68, 256 * 1024],
        small: [768, 80, 1024 * 1024],
        standard: [1920, 88, 2 * 1024 * 1024],
      },
    );
    for (const [name, output] of Object.entries(generated)) {
      const metadata = await sharp(output.bytes).metadata();
      assert.equal(metadata.format, "webp", name);
      assert.ok(
        metadata.width! <=
          DERIVATIVE_PROFILES[name as keyof typeof DERIVATIVE_PROFILES]
            .maxWidth,
      );
      assert.ok(Math.abs(metadata.width! / metadata.height! - 1.5) < 0.01);
      assert.ok(
        output.bytes.length <=
          DERIVATIVE_PROFILES[name as keyof typeof DERIVATIVE_PROFILES]
            .maxBytes,
      );
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.icc, undefined);
    }
  });

  it("auto-orients, uses the first animation frame, strips metadata, and never enlarges tiny images", async () => {
    const oriented = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 3,
        background: "red",
      },
    })
      .withMetadata({
        orientation: 6,
        exif: { IFD0: { Copyright: "private fixture" } },
      })
      .jpeg()
      .toBuffer();

    const generated = await generateImageDerivatives(oriented);
    for (const output of Object.values(generated)) {
      const metadata = await sharp(output.bytes).metadata();
      assert.equal(metadata.width, 20);
      assert.equal(metadata.height, 40);
      assert.equal(metadata.pages ?? 1, 1);
      assert.equal(
        output.bytes.includes(Buffer.from("private fixture")),
        false,
      );
    }
  });

  it("enforces the standard hard cap on deterministic noisy input", async () => {
    const width = 2400;
    const height = 1600;
    const pixels = Buffer.allocUnsafe(width * height * 3);
    for (let index = 0; index < pixels.length; index += 1) {
      pixels[index] = (index * 73 + (index >>> 7) * 29) & 0xff;
    }
    const source = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 1 })
      .toBuffer();
    const standard = (await generateImageDerivatives(source)).standard;
    const metadata = await sharp(standard.bytes).metadata();
    assert.ok(standard.bytes.length <= 2 * 1024 * 1024);
    assert.ok(metadata.width! <= 1920);
    assert.ok(metadata.height! <= 1600);
  });

  it("rejects unsupported, malformed, oversized, and decoded-pixel-bomb inputs without unbounded fallback", async () => {
    await assert.rejects(
      () => generateImageDerivatives(Buffer.from("<svg/>")),
      /unsupported|decode/i,
    );
    await assert.rejects(
      () => generateImageDerivatives(Buffer.from("not an image")),
      /unsupported|decode/i,
    );
    await assert.rejects(
      () => generateImageDerivatives(Buffer.alloc(64), { inputBytes: 63 }),
      /input.*limit/i,
    );
    const wide = await sharp({
      create: { width: 2000, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await assert.rejects(
      () => generateImageDerivatives(wide, { maxDimension: 1000 }),
      /dimension.*limit/i,
    );
  });
});

describe("durable derivative upload boundary", { concurrency: false }, () => {
  let directory: string;
  let service: FileService;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fs-derivatives-test-"));
    service = await FileService.create({
      token: "fixture-token-with-sufficient-entropy",
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: path.join(directory, "objects"),
      publicUrl: "https://files.example.test",
      maxUploadBytes: 16 * 1024 * 1024,
      minFreeBytes: 0,
    });
  });

  after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("atomically enqueues eligible originals without decoding or generating during upload", async () => {
    const source = await sharp({
      create: { width: 16, height: 8, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    let called = false;
    const internal = service as unknown as {
      generateDerivatives?: () => never;
    };
    internal.generateDerivatives = () => {
      called = true;
      throw new Error("request path invoked image generation");
    };

    const started = performance.now();
    const uploaded = await service.upload(bytes(source), {
      name: "eligible.png",
      tags: [],
      visibility: "private",
      archive: null,
      mimeType: "image/png",
      contentLength: source.length,
    });
    const acknowledgementMs = performance.now() - started;

    assert.equal(called, false);
    assert.ok(
      acknowledgementMs < 1_000,
      `upload acknowledgement took ${acknowledgementMs}ms`,
    );
    assert.equal(
      (await service.repository.getDerivativeJob(uploaded.id))?.status,
      "pending",
    );
    assert.equal(await service.getDerivative(uploaded.id, "small"), null);
  });

  it("does not enqueue non-images", async () => {
    const uploaded = await service.upload(bytes(Buffer.from("plain")), {
      name: "plain.txt",
      tags: [],
      visibility: "private",
      archive: null,
      mimeType: "text/plain",
      contentLength: 5,
    });
    assert.equal(await service.repository.getDerivativeJob(uploaded.id), null);
    assert.equal(
      await readFile(service.storagePath(uploaded), "utf8"),
      "plain",
    );
  });

  it("claims once, stores namespaced bytes, survives restart, and cascades cleanup", async () => {
    while (await processNextDerivativeJob(service, "fixture-drain")) {
      // Isolate this claim race from eligible uploads created by earlier tests.
    }
    const source = await sharp({
      create: { width: 1000, height: 500, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const uploaded = await service.upload(bytes(source), {
      name: "worker.png",
      tags: [],
      visibility: "private",
      archive: null,
      mimeType: "image/png",
      contentLength: source.length,
    });

    const claims = await Promise.all([
      service.repository.claimDerivativeJob("worker-a", new Date(), 30_000),
      service.repository.claimDerivativeJob("worker-b", new Date(), 30_000),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(
      await service.repository.requeueDerivativeJob(uploaded.id),
      false,
    );
    const owner = claims.find(Boolean)!.leaseOwner!;
    await service.repository.failDerivativeJob(
      uploaded.id,
      owner,
      "synthetic interrupted attempt",
    );
    assert.equal(
      await service.repository.requeueDerivativeJob(uploaded.id),
      true,
    );
    assert.equal(await processNextDerivativeJob(service, "worker-c"), true);

    const small = await service.getDerivative(uploaded.id, "small");
    assert.ok(small);
    assert.match(
      small.storageKey,
      /^\.image-derivatives\/[0-9A-Za-z]{7}\/image-derivatives-v1\/small\.webp$/u,
    );
    const storedBytes = await readFile(
      path.join(service.config.storageDir, small.storageKey),
    );
    assert.equal((await sharp(storedBytes).metadata()).width, 768);

    await service.update(uploaded.id, { visibility: "public" });
    setFileServiceForTests(service);
    const context = {
      params: Promise.resolve({ id: uploaded.id, profile: "small" }),
    };
    const full = await getDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`),
      context,
    );
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "image/webp");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), storedBytes);
    const head = await headDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`, {
        method: "HEAD",
      }),
      context,
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const partial = await getDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`, {
        headers: { range: "bytes=0-9" },
      }),
      context,
    );
    assert.equal(partial.status, 206);
    assert.deepEqual(
      Buffer.from(await partial.arrayBuffer()),
      storedBytes.subarray(0, 10),
    );
    await service.update(uploaded.id, { visibility: "private" });
    const hidden = await getDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`),
      context,
    );
    const missing = await getDerivativeRoute(
      new Request("https://files.example.test/raw/0000000/small"),
      { params: Promise.resolve({ id: "0000000", profile: "small" }) },
    );
    assert.equal(hidden.status, 404);
    assert.equal(await hidden.text(), await missing.text());

    await service.close();
    service = await FileService.create({
      token: "fixture-token-with-sufficient-entropy",
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: path.join(directory, "objects"),
      publicUrl: "https://files.example.test",
      maxUploadBytes: 16 * 1024 * 1024,
      minFreeBytes: 0,
    });
    const restarted = await service.getDerivative(uploaded.id, "small");
    assert.ok(restarted);
    assert.deepEqual(
      await readFile(
        path.join(service.config.storageDir, restarted.storageKey),
      ),
      storedBytes,
    );
    await service.delete(uploaded.id);
    assert.equal(await service.repository.getDerivativeJob(uploaded.id), null);
    await assert.rejects(
      access(
        path.join(service.config.storageDir, ".image-derivatives", uploaded.id),
      ),
      { code: "ENOENT" },
    );
  });

  it("retries malformed sources to terminal failure and permits an explicit safe requeue", async () => {
    const malformed = await service.upload(bytes(Buffer.from("not-a-raster")), {
      name: "malformed.png",
      tags: [],
      visibility: "private",
      archive: null,
      mimeType: "image/png",
      contentLength: 12,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.repository.requeueDerivativeJob(malformed.id);
      assert.equal(
        await processNextDerivativeJob(service, `failure-${attempt}`),
        true,
      );
    }
    assert.equal(
      (await service.repository.getDerivativeJob(malformed.id))?.status,
      "failed",
    );
    assert.equal(
      await service.repository.requeueDerivativeJob(malformed.id),
      true,
    );
    assert.equal(
      (await service.repository.getDerivativeJob(malformed.id))?.status,
      "pending",
    );
  });

  it("enqueues legacy raster backfill in a bounded low-priority batch", async () => {
    const source = await sharp({
      create: { width: 8, height: 4, channels: 3, background: "yellow" },
    })
      .png()
      .toBuffer();
    const now = new Date().toISOString();
    for (const id of ["LegacyA", "LegacyB", "LegacyC"]) {
      await writeFile(path.join(service.config.storageDir, id), source);
      await service.repository.insert(
        {
          id,
          name: `${id}.png`,
          size: source.length,
          mimeType: "image/png",
          sha256: "a".repeat(64),
          visibility: "private",
          ownerId: null,
          storageKey: id,
          archive: null,
          createdAt: now,
          updatedAt: now,
        },
        [],
        false,
      );
    }
    assert.equal(await service.repository.enqueueDerivativeBackfill(2), 2);
    const jobs = await Promise.all(
      ["LegacyA", "LegacyB", "LegacyC"].map((id) =>
        service.repository.getDerivativeJob(id),
      ),
    );
    assert.equal(jobs.filter(Boolean).length, 2);
    assert.ok(jobs.filter(Boolean).every((job) => job!.priority < 0));
  });
});
