import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PREVIEW_EXTRACTION_LIMITS,
  PreviewSourceUnavailableError,
  PreviewRendererRegistry,
  createDefaultPreviewRendererRegistry,
  derivePreview,
  getPreviewExtractionPoolState,
  type PreviewRenderer,
  type RendererInput,
} from "./preview-renderers";

function input(mimeType: string, name = "fixture.bin"): RendererInput {
  return {
    trustedMime: mimeType,
    name,
    size: 7,
    sha256: "a".repeat(64),
    sourcePath: "/synthetic/source",
  };
}

function renderer(
  id: string,
  priority: number,
  matches: (candidate: RendererInput) => boolean,
): PreviewRenderer {
  return {
    id,
    priority,
    matches,
    async probe(candidate) {
      return { rendererId: id, input: candidate, validated: {} };
    },
    async extract(probe) {
      return {
        family: id,
        label: id,
        title: probe.input.name,
        facts: [],
        sourceDigest: probe.input.sha256,
        visual: { kind: "binary" },
      };
    },
    renderMetadata(extraction) {
      return extraction;
    },
  };
}

describe("preview renderer strategy registry", () => {
  it("dispatches by explicit deterministic priority and stable registration order", () => {
    const registry = new PreviewRendererRegistry();
    registry.register(renderer("fallback", 0, () => true));
    registry.register(
      renderer("family", 100, ({ trustedMime }) =>
        trustedMime.startsWith("image/"),
      ),
    );
    registry.register(
      renderer(
        "exact",
        1000,
        ({ trustedMime }) => trustedMime === "image/avif",
      ),
    );

    assert.equal(registry.resolve(input("image/avif")).id, "exact");
    assert.equal(registry.resolve(input("image/png")).id, "family");
    assert.equal(
      registry.resolve(input("application/x-unknown")).id,
      "fallback",
    );

    registry.register(renderer("same-priority-later", 100, () => true));
    assert.equal(registry.resolve(input("image/png")).id, "family");
  });

  it("supports a new exact subtype and a new family without core-registry edits", () => {
    const registry = createDefaultPreviewRendererRegistry();
    registry.register(
      renderer(
        "image-jxl",
        1100,
        ({ trustedMime }) => trustedMime === "image/jxl",
      ),
    );
    registry.register(
      renderer("model-family", 900, ({ trustedMime }) =>
        trustedMime.startsWith("model/"),
      ),
    );

    assert.equal(
      registry.resolve(input("image/jxl", "new.jxl")).id,
      "image-jxl",
    );
    assert.equal(
      registry.resolve(input("model/gltf+json", "scene.gltf")).id,
      "model-family",
    );
    assert.equal(
      registry.resolve(input("image/png", "photo.png")).id,
      "image-raster",
    );
  });

  it("rejects duplicate ids and fails closed when no strategy matches", () => {
    const registry = new PreviewRendererRegistry();
    registry.register(renderer("only", 1, () => false));
    assert.throws(
      () => registry.register(renderer("only", 2, () => true)),
      /duplicate renderer id/u,
    );
    assert.throws(
      () => registry.resolve(input("application/x-none")),
      /no preview renderer/u,
    );
  });

  it("bounds extraction saturation and recovers after queued work completes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fs-preview-pool-"));
    try {
      const sourcePath = path.join(directory, "source.bin");
      const source = Buffer.from("payload");
      await writeFile(sourcePath, source);
      const candidate: RendererInput = {
        trustedMime: "application/octet-stream",
        name: "source.bin",
        size: source.length,
        sha256: createHash("sha256").update(source).digest("hex"),
        sourcePath,
      };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const registry = new PreviewRendererRegistry().register({
        ...renderer("blocked", 1, () => true),
        async extract(probe) {
          await gate;
          return {
            family: "binary",
            label: "Binary",
            title: probe.input.name,
            facts: [],
            sourceDigest: probe.input.sha256,
            visual: { kind: "binary" },
          };
        },
      });
      const admitted = Array.from(
        {
          length:
            PREVIEW_EXTRACTION_LIMITS.maxConcurrent +
            PREVIEW_EXTRACTION_LIMITS.maxQueued,
        },
        () => derivePreview(candidate, registry),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          getPreviewExtractionPoolState().queued ===
          PREVIEW_EXTRACTION_LIMITS.maxQueued
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual(getPreviewExtractionPoolState(), {
        active: PREVIEW_EXTRACTION_LIMITS.maxConcurrent,
        queued: PREVIEW_EXTRACTION_LIMITS.maxQueued,
      });
      await assert.rejects(
        derivePreview(candidate, registry),
        /preview extraction is busy/u,
      );
      release();
      assert.equal((await Promise.all(admitted)).length, admitted.length);
      assert.deepEqual(getPreviewExtractionPoolState(), {
        active: 0,
        queued: 0,
      });
      assert.equal((await derivePreview(candidate)).visual.kind, "binary");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds enqueue-to-completion time without releasing unfinished work", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-preview-deadline-"),
    );
    try {
      const sourcePath = path.join(directory, "source.txt");
      const source = Buffer.from("deadline payload");
      await writeFile(sourcePath, source);
      const candidate: RendererInput = {
        trustedMime: "text/plain",
        name: "source.txt",
        size: source.length,
        sha256: createHash("sha256").update(source).digest("hex"),
        sourcePath,
      };
      const registry = new PreviewRendererRegistry().register({
        ...renderer("slow", 1, () => true),
        async extract(probe) {
          await new Promise((resolve) =>
            setTimeout(resolve, PREVIEW_EXTRACTION_LIMITS.wallTimeoutMs + 200),
          );
          return {
            family: "binary",
            label: "Binary",
            title: probe.input.name,
            facts: [],
            sourceDigest: probe.input.sha256,
            visual: { kind: "binary" },
          };
        },
      });

      const started = Date.now();
      await assert.rejects(
        derivePreview(candidate, registry),
        PreviewSourceUnavailableError,
      );
      assert.ok(Date.now() - started < 2_700);
      assert.deepEqual(getPreviewExtractionPoolState(), {
        active: 1,
        queued: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(getPreviewExtractionPoolState(), {
        active: 0,
        queued: 0,
      });
      const recovered = await derivePreview(candidate);
      assert.equal(recovered.sourceDigest, candidate.sha256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
