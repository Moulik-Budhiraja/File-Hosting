import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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
import { FileRepository } from "./database";
import { generateDerivativesInChild } from "./image-derivative-child";
import { nativeAdmissionState, withNativeAdmission } from "./native-admission";
import { runKillableProcess } from "./process-tree";
import { processNextUnfurlArtifactJob } from "./unfurl-artifact-worker";
import { processNextDerivativeJob } from "./image-derivative-worker";
import { removeImageDerivatives } from "./image-derivative-storage";
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

  it("keeps stored route profile imports encoder-free", async () => {
    const route = await readFile(
      new URL("../../app/raw/[id]/[profile]/route.ts", import.meta.url),
      "utf8",
    );
    assert.match(route, /image-derivative-contract/u);
    assert.doesNotMatch(
      route,
      /from\s+["']@\/server\/files\/image-derivatives["']/u,
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
        thumbnail: [320, 78, 256 * 1024],
        small: [768, 82, 1024 * 1024],
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

  it("auto-orients, strips metadata, and never enlarges tiny images", async () => {
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

  it("uses the first frame of a real two-frame animation", async () => {
    const first = await sharp({
      create: { width: 2, height: 1, channels: 4, background: "red" },
    })
      .gif()
      .toBuffer();
    const second = await sharp({
      create: { width: 2, height: 1, channels: 4, background: "blue" },
    })
      .gif()
      .toBuffer();
    const animated = Buffer.concat([
      first.subarray(0, first.length - 1),
      second.subarray(19, second.length - 1),
      Buffer.from([0x3b]),
    ]);
    const generated = await generateImageDerivatives(animated);
    for (const output of Object.values(generated)) {
      const metadata = await sharp(output.bytes).metadata();
      const decoded = await sharp(output.bytes).ensureAlpha().raw().toBuffer();
      assert.equal(metadata.pages ?? 1, 1);
      assert.ok(decoded[0]! > decoded[2]!, "first red frame wins");
    }
    assert.equal(
      createHash("sha256").update(animated).digest("hex").length,
      64,
    );
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

  it("kills the complete native process group at the admitted-job deadline", async () => {
    const fixtureDir = await mkdtemp(
      path.join(os.tmpdir(), "derivative-deadline-"),
    );
    try {
      const childScript = path.join(fixtureDir, "stall.cjs");
      const pidFile = path.join(fixtureDir, "descendant.pid");
      await writeFile(
        childScript,
        `const {spawn}=require("node:child_process");const fs=require("node:fs");const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`,
      );
      await assert.rejects(
        () =>
          generateDerivativesInChild(
            childScript,
            path.join(fixtureDir, "unused"),
            Date.now() + 200,
          ),
        /deadline/u,
      );
      const descendantPid = Number(await readFile(pidFile, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.throws(
        () => process.kill(descendantPid, 0),
        /ESRCH|no such process/i,
      );
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("reaps a stubborn descendant when the native launcher exits early", async () => {
    const fixtureDir = await mkdtemp(
      path.join(os.tmpdir(), "derivative-early-exit-"),
    );
    const childScript = path.join(fixtureDir, "early-exit.cjs");
    const pidFile = path.join(fixtureDir, "descendant.pid");
    let descendantPid = 0;
    try {
      await writeFile(
        childScript,
        `const {spawn}=require("node:child_process");const fs=require("node:fs");const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore",detached:false});child.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
      );
      await assert.rejects(
        () =>
          generateDerivativesInChild(
            childScript,
            path.join(fixtureDir, "unused"),
            Date.now() + 10_000,
          ),
        /invalid output/u,
      );
      descendantPid = Number(await readFile(pidFile, "utf8"));
      assert.throws(
        () => process.kill(descendantPid, 0),
        /ESRCH|no such process/i,
      );
    } finally {
      if (descendantPid > 0)
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      await rm(fixtureDir, { recursive: true, force: true });
    }
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
      visibility: "public",
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
    assert.equal(
      (await service.repository.getUnfurlArtifactJob(uploaded.id))?.status,
      "pending",
    );
    assert.equal(await service.getDerivative(uploaded.id, "small"), null);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let renderEntered = false;
    const processing = processNextUnfurlArtifactJob(
      service,
      "blocked-upload-proof",
      {
        onlyFileId: uploaded.id,
        generate: async () => {
          renderEntered = true;
          await blocked;
        },
      },
    );
    while (!renderEntered)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(uploaded.id, "upload response precedes blocked rendering");
    await service.update(uploaded.id, { visibility: "private" });
    release();
    assert.equal(await processing, true);
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

  it("fails unfurl work that exceeds the admitted whole-job deadline", async () => {
    const uploaded = await service.upload(bytes(Buffer.from("deadline")), {
      name: "deadline.txt",
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "text/plain",
      contentLength: 8,
    });
    assert.equal(
      await processNextUnfurlArtifactJob(service, "deadline-worker", {
        onlyFileId: uploaded.id,
        deadlineMs: 1,
        generate: async () => new Promise((resolve) => setTimeout(resolve, 10)),
      }),
      true,
    );
    const job = await service.repository.getUnfurlArtifactJob(uploaded.id);
    assert.equal(job?.status, "retry");
    assert.match(job?.lastError ?? "", /deadline/u);
  });

  it("commits a valid unfurl artifact after controlled native host contention", async () => {
    const workerSource = await readFile(
      new URL("./unfurl-artifact-worker.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      workerSource,
      /renderOgImage\(service,\s*retainedFile,\s*model,\s*\{\s*deadlineAt,?\s*\}\)/u,
      "durable rendering must receive the admitted job's remaining deadline",
    );
    const uploaded = await service.upload(
      bytes(Buffer.from("valid artifact")),
      {
        name: "contention.txt",
        tags: [],
        visibility: "public",
        archive: null,
        mimeType: "text/plain",
        contentLength: 14,
      },
    );
    const contention = withNativeAdmission(1_000, () =>
      runKillableProcess(
        process.execPath,
        ["-e", "setTimeout(() => process.exit(0), 3000)"],
        {
          timeoutMs: 6_000,
          maxOutputBytes: 1024,
          allowSandboxForks: true,
        },
      ),
    );
    while (nativeAdmissionState().active !== 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      assert.equal(
        await processNextUnfurlArtifactJob(service, "contention-worker", {
          onlyFileId: uploaded.id,
          deadlineMs: 8_000,
        }),
        true,
      );
      const job = await service.repository.getUnfurlArtifactJob(uploaded.id);
      assert.equal(job?.status, "complete", job?.lastError ?? "missing job");
    } finally {
      await contention;
    }
  });

  it("fails async unfurl jobs closed when visibility or deletion changes during rendering", async () => {
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();

    for (const transition of ["private", "delete"] as const) {
      const uploaded = await service.upload(bytes(source), {
        name: `${transition}.png`,
        tags: [],
        visibility: "public",
        archive: null,
        mimeType: "image/png",
        contentLength: source.length,
      });
      let release!: () => void;
      let started!: () => void;
      const renderStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const renderRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      const processing = processNextUnfurlArtifactJob(
        service,
        `transition-${transition}`,
        {
          onlyFileId: uploaded.id,
          generate: async () => {
            started();
            await renderRelease;
          },
        },
      );
      await renderStarted;
      if (transition === "private")
        await service.update(uploaded.id, { visibility: "private" });
      else await service.delete(uploaded.id);
      release();
      assert.equal(await processing, true);
      assert.equal(
        await service.repository.getUnfurlArtifactJob(uploaded.id),
        null,
      );
    }
  });

  it("fails closed on same-size source replacement and symlinked derivative parents", async () => {
    for (const invalidId of [
      "short",
      "12345678",
      "../evil",
      "abc/def",
      "abc\\def",
      "ＡＢＣ１２３４",
      "abc:def",
    ])
      await assert.rejects(removeImageDerivatives(service, invalidId));
    while (await processNextDerivativeJob(service, "fixture-drain-security")) {
      // Drain unrelated jobs from prior slices.
    }
    const redPixels = Buffer.alloc(20 * 10 * 3, 0);
    const bluePixels = Buffer.alloc(20 * 10 * 3, 0);
    for (let index = 0; index < redPixels.length; index += 3) {
      redPixels[index] = 255;
      bluePixels[index + 2] = 255;
    }
    const red = await sharp(redPixels, {
      raw: { width: 20, height: 10, channels: 3 },
    })
      .tiff({ compression: "none" })
      .toBuffer();
    const blue = await sharp(bluePixels, {
      raw: { width: 20, height: 10, channels: 3 },
    })
      .tiff({ compression: "none" })
      .toBuffer();
    assert.equal(red.length, blue.length);
    const uploaded = await service.upload(bytes(red), {
      name: "identity.tiff",
      tags: [],
      visibility: "private",
      archive: null,
      mimeType: "image/tiff",
      contentLength: red.length,
    });
    await writeFile(service.storagePath(uploaded), blue);
    assert.equal(await processNextDerivativeJob(service, "source-fence"), true);
    assert.equal(await service.getDerivative(uploaded.id, "small"), null);

    const safe = await service.upload(bytes(red), {
      name: "symlink.tiff",
      tags: [],
      visibility: "private",
      archive: null,
      mimeType: "image/tiff",
      contentLength: red.length,
    });
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await mkdir(path.join(service.config.storageDir, ".image-derivatives"), {
      recursive: true,
    });
    await symlink(
      outside,
      path.join(service.config.storageDir, ".image-derivatives", safe.id),
    );
    assert.equal(
      await processNextDerivativeJob(service, "symlink-fence"),
      true,
    );
    assert.deepEqual(
      await (await import("node:fs/promises")).readdir(outside),
      [],
    );
    assert.equal(await service.getDerivative(safe.id, "small"), null);
  });

  it("rejects an original replaced by a byte-identical outside symlink", async () => {
    while (await processNextDerivativeJob(service, "source-symlink-drain")) {
      // Isolate this source-path attack from earlier jobs.
    }
    const source = await sharp({
      create: { width: 20, height: 10, channels: 3, background: "purple" },
    })
      .png()
      .toBuffer();
    const uploaded = await service.upload(bytes(source), {
      name: "outside-source.png",
      tags: [],
      visibility: "private",
      archive: null,
      mimeType: "image/png",
      contentLength: source.length,
    });
    const outside = path.join(directory, "outside-source.png");
    await writeFile(outside, source);
    await unlink(service.storagePath(uploaded));
    await symlink(outside, service.storagePath(uploaded));

    assert.equal(
      await processNextDerivativeJob(service, "source-symlink-worker"),
      true,
    );
    assert.equal(await service.getDerivative(uploaded.id, "small"), null);
    assert.match(
      (await service.repository.getDerivativeJob(uploaded.id))?.lastError ?? "",
      /symlink|regular|safe|storage/u,
    );
  });

  it("keeps immutable attempt bytes unpublished and cleans them after DB commit failure", async () => {
    while (await processNextDerivativeJob(service, "db-failure-drain")) {
      // Isolate the injected commit failure from earlier jobs.
    }
    const source = await sharp({
      create: { width: 20, height: 10, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const uploaded = await service.upload(bytes(source), {
      name: "db-failure.png",
      tags: [],
      visibility: "private",
      archive: null,
      mimeType: "image/png",
      contentLength: source.length,
    });
    const originalComplete = service.repository.completeDerivativeJob.bind(
      service.repository,
    );
    service.repository.completeDerivativeJob = async () => {
      throw new Error("synthetic DB commit failure");
    };
    try {
      assert.equal(await processNextDerivativeJob(service, "db-failure"), true);
    } finally {
      service.repository.completeDerivativeJob = originalComplete;
    }
    assert.equal(await service.getDerivative(uploaded.id, "small"), null);
    const revisionDirectory = path.join(
      service.config.storageDir,
      ".image-derivatives",
      uploaded.id,
      DERIVATIVE_REVISION,
    );
    const remaining = await (
      await import("node:fs/promises")
    )
      .readdir(revisionDirectory, { recursive: true })
      .catch(() => []);
    assert.deepEqual(remaining, []);
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
      service.repository.claimDerivativeJob(
        "worker-a",
        new Date(),
        30_000,
        uploaded.id,
      ),
      service.repository.claimDerivativeJob(
        "worker-b",
        new Date(),
        30_000,
        uploaded.id,
      ),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(
      await service.repository.requeueDerivativeJob(uploaded.id),
      false,
    );
    const owner = claims.find(Boolean)!.leaseOwner!;
    const claimedAt = new Date(claims.find(Boolean)!.updatedAt);
    assert.equal(
      await service.repository.completeDerivativeJob(
        uploaded.id,
        owner,
        [],
        new Date(claimedAt.getTime() + 31_000),
      ),
      false,
      "expired owners cannot complete",
    );
    await service.repository.failDerivativeJob(
      uploaded.id,
      owner,
      "expired failure must be fenced",
      1,
      new Date(claimedAt.getTime() + 31_000),
    );
    assert.equal(
      (await service.repository.getDerivativeJob(uploaded.id))?.status,
      "processing",
      "expired owners cannot fail the job",
    );
    assert.equal(
      await service.repository.renewDerivativeLease(
        uploaded.id,
        owner,
        new Date(claimedAt.getTime() + 1_000),
        30_000,
      ),
      true,
      "current owner renews the lease",
    );
    const renewedExpiry = new Date(
      (await service.repository.getDerivativeJob(uploaded.id))!.leaseExpiresAt!,
    );
    const reclaimed = await service.repository.claimDerivativeJob(
      "worker-reclaimed",
      new Date(renewedExpiry.getTime() + 1),
      30_000,
      uploaded.id,
    );
    assert.equal(reclaimed?.leaseOwner, "worker-reclaimed");
    await service.repository.failDerivativeJob(
      uploaded.id,
      "worker-reclaimed",
      "synthetic interrupted attempt",
      1,
      new Date(claimedAt.getTime() + 32_000),
    );
    const failedReclaim = await service.repository.getDerivativeJob(
      uploaded.id,
    );
    assert.equal(
      failedReclaim?.status,
      "failed",
      JSON.stringify(failedReclaim),
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
      /^\.image-derivatives\/[0-9A-Za-z]{7}\/image-derivatives-v1\/[0-9a-f-]{36}\/small\.webp$/u,
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
    const etag = full.headers.get("etag")!;
    const notModified = await getDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`, {
        headers: { "if-none-match": etag },
      }),
      context,
    );
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), "");
    const preconditionFailed = await getDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`, {
        headers: { "if-match": '"different"' },
      }),
      context,
    );
    assert.equal(preconditionFailed.status, 412);
    assert.equal(await preconditionFailed.text(), "");
    for (const method of ["GET", "HEAD"] as const) {
      const request = new Request(
        `https://files.example.test/raw/${uploaded.id}/small`,
        {
          method,
          headers: {
            "if-unmodified-since": "Wed, 01 Jan 2020 00:00:00 GMT",
            range: "bytes=0-9",
          },
        },
      );
      const stale =
        method === "HEAD"
          ? await headDerivativeRoute(request, context)
          : await getDerivativeRoute(request, context);
      assert.equal(stale.status, 412);
      assert.equal(await stale.text(), "");
    }
    const modifiedSince = await getDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`, {
        headers: { "if-modified-since": "Wed, 31 Dec 2099 23:59:59 GMT" },
      }),
      context,
    );
    assert.equal(modifiedSince.status, 304);
    const ignoredRange = await getDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`, {
        headers: { range: "bytes=0-9", "if-range": '"different"' },
      }),
      context,
    );
    assert.equal(ignoredRange.status, 200);
    assert.deepEqual(
      Buffer.from(await ignoredRange.arrayBuffer()),
      storedBytes,
    );
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
    const unsatisfiableHead = await headDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`, {
        method: "HEAD",
        headers: { range: `bytes=${storedBytes.length + 1}-` },
      }),
      context,
    );
    assert.equal(unsatisfiableHead.status, 416);
    assert.equal(unsatisfiableHead.headers.get("accept-ranges"), "bytes");
    assert.equal(
      unsatisfiableHead.headers.get("content-range"),
      `bytes */${storedBytes.length}`,
    );
    assert.equal(await unsatisfiableHead.text(), "");
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
    const objectPath = path.join(
      service.config.storageDir,
      restarted.storageKey,
    );
    await service.update(uploaded.id, { visibility: "public" });
    setFileServiceForTests(service);
    await (await import("node:fs/promises")).unlink(objectPath);
    const unavailableGet = await getDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`),
      context,
    );
    const unavailableHead = await headDerivativeRoute(
      new Request(`https://files.example.test/raw/${uploaded.id}/small`, {
        method: "HEAD",
      }),
      context,
    );
    const unavailableMissing = await getDerivativeRoute(
      new Request("https://files.example.test/raw/0000000/small"),
      { params: Promise.resolve({ id: "0000000", profile: "small" }) },
    );
    assert.equal(unavailableGet.status, 404);
    assert.equal(unavailableHead.status, 404);
    assert.equal(await unavailableGet.text(), await unavailableMissing.text());
    assert.equal(await unavailableHead.text(), "");
    const corrupted = Buffer.from(storedBytes);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    await writeFile(objectPath, corrupted);
    assert.equal(
      (
        await getDerivativeRoute(
          new Request(`https://files.example.test/raw/${uploaded.id}/small`),
          context,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await headDerivativeRoute(
          new Request(`https://files.example.test/raw/${uploaded.id}/small`, {
            method: "HEAD",
          }),
          context,
        )
      ).status,
      404,
    );
    await writeFile(objectPath, storedBytes);
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

  it("exposes bounded pause and resume operator commands in the standalone worker", async () => {
    const [workerSource, packageSource] = await Promise.all([
      readFile(
        new URL("../../../scripts/image-derivative-worker.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ]);
    const packageJson = JSON.parse(packageSource) as {
      scripts?: Record<string, string>;
    };
    assert.match(workerSource, /BACKFILL_BATCH = 2/u);
    assert.match(workerSource, /--backfill-pause/u);
    assert.match(workerSource, /--backfill-resume/u);
    assert.equal(
      packageJson.scripts?.["backfill:pause"],
      "node .next/standalone/image-derivative-worker.cjs --backfill-pause",
    );
    assert.equal(
      packageJson.scripts?.["backfill:resume"],
      "node .next/standalone/image-derivative-worker.cjs --backfill-resume",
    );
  });

  it("supports durable operator pause and resume without bypassing cadence", async () => {
    const source = await sharp({
      create: { width: 8, height: 4, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const now = new Date("2029-01-01T00:00:00.000Z");
    await writeFile(path.join(service.config.storageDir, "LgCtl01"), source);
    await service.repository.insert(
      {
        id: "LgCtl01",
        name: "legacy-control.png",
        size: source.length,
        mimeType: "image/png",
        sha256: "c".repeat(64),
        visibility: "public",
        ownerId: null,
        storageKey: "LgCtl01",
        archive: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      [],
      false,
      false,
    );
    await service.repository.setArtifactBackfillEnabled(false, now);
    assert.equal(
      await service.repository.enqueueArtifactBackfill(
        2,
        new Date(now.getTime() + 60_000),
      ),
      0,
    );
    await service.repository.setArtifactBackfillEnabled(
      true,
      new Date(now.getTime() + 60_000),
    );
    assert.equal(
      await service.repository.enqueueArtifactBackfill(
        2,
        new Date(now.getTime() + 60_000),
      ),
      2,
      "one public image consumes the two-job canary grant",
    );
  });

  it("backfills derivative and public unfurl jobs through one durable global budget", async () => {
    const source = await sharp({
      create: { width: 8, height: 4, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const now = new Date().toISOString();
    for (const [id, visibility] of [
      ["LgPub01", "public"],
      ["LgPri01", "private"],
    ] as const) {
      await writeFile(path.join(service.config.storageDir, id), source);
      await service.repository.insert(
        {
          id,
          name: `${id}.png`,
          size: source.length,
          mimeType: "image/png",
          sha256: "b".repeat(64),
          visibility,
          ownerId: null,
          storageKey: id,
          archive: null,
          createdAt: now,
          updatedAt: now,
        },
        [],
        false,
        false,
      );
    }
    const cadenceStart = new Date("2031-01-01T00:00:00.000Z");
    await service.repository.setArtifactBackfillEnabled(true, cadenceStart);
    assert.equal(
      await service.repository.enqueueArtifactBackfill(4, cadenceStart),
      3,
      "two derivative jobs plus one public-only unfurl consume one global grant",
    );
    assert.ok(await service.repository.getDerivativeJob("LgPub01"));
    assert.ok(await service.repository.getDerivativeJob("LgPri01"));
    assert.ok(await service.repository.getUnfurlArtifactJob("LgPub01"));
    assert.equal(
      await service.repository.getUnfurlArtifactJob("LgPri01"),
      null,
      "private artifacts must never enter the unfurl queue",
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
    const cadenceStart = new Date("2032-01-01T00:00:00.000Z");
    await service.repository.setArtifactBackfillEnabled(true, cadenceStart);
    const peers = await Promise.all([
      FileRepository.create(service.config.databaseUrl),
      FileRepository.create(service.config.databaseUrl),
    ]);
    const grants = await Promise.all([
      service.repository.enqueueDerivativeBackfill(
        4,
        new Date(cadenceStart.getTime() + 60_000),
      ),
      peers[0].enqueueDerivativeBackfill(
        4,
        new Date(cadenceStart.getTime() + 60_000),
      ),
      peers[1].enqueueDerivativeBackfill(
        4,
        new Date(cadenceStart.getTime() + 60_000),
      ),
    ]);
    assert.equal(
      grants.reduce((sum, value) => sum + value, 0),
      3,
    );
    assert.equal(
      await service.repository.enqueueDerivativeBackfill(
        4,
        new Date(cadenceStart.getTime() + 61_000),
      ),
      0,
    );
    const jobs = await Promise.all(
      ["LegacyA", "LegacyB", "LegacyC"].map((id) =>
        service.repository.getDerivativeJob(id),
      ),
    );
    assert.equal(jobs.filter(Boolean).length, 3);
    assert.ok(jobs.filter(Boolean).every((job) => job!.priority < 0));
    const preferredUpload = await service.upload(bytes(source), {
      name: "new-upload.png",
      tags: [],
      visibility: "private",
      archive: null,
      mimeType: "image/png",
      contentLength: source.length,
    });
    const aged = await service.repository.claimDerivativeJob(
      "fairness-worker",
      new Date(cadenceStart.getTime() + 6 * 60_000),
    );
    assert.ok(aged);
    assert.ok(
      aged.priority < 0,
      `aged legacy job must outrank sustained upload ${preferredUpload.id}`,
    );
    await Promise.all(peers.map((peer) => peer.close()));
  });
});
