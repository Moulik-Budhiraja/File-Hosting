import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import sharp from "sharp";

import { renderOgImage } from "./og-image";
import type { FileService } from "./service";
import type { StoredFile } from "./types";
import { buildUnfurlModel } from "./unfurl";

const temporaryDirectories: string[] = [];

async function subject(bytes: Buffer, mimeType: string, name: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fs-og-v2-"));
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, "object");
  await writeFile(sourcePath, bytes);
  const file: StoredFile = {
    id: "Ab3dE5g",
    name,
    size: bytes.length,
    mimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    visibility: "public",
    ownerId: "synthetic-owner",
    storageKey: "synthetic-storage",
    archive: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    tags: [],
  };
  const service = {
    config: { publicUrl: "https://files.example.test" },
    storagePath: () => sourcePath,
  } as unknown as FileService;
  const model = await buildUnfurlModel(service, file);
  return {
    file,
    service,
    model,
    png: await renderOgImage(service, file, model),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OG Social Cards V2 byte-derived rendering", () => {
  it("renders the actual bounded Markdown body so same-title byte changes alter pixels", async () => {
    const first = await subject(
      Buffer.from("# Same title\n\nAlpha release body\n"),
      "text/markdown",
      "runbook.md",
    );
    const second = await subject(
      Buffer.from("# Same title\n\nBravo release body\n"),
      "text/markdown",
      "runbook.md",
    );
    assert.equal(first.model.preview?.visual.kind, "markdown");
    assert.equal(second.model.preview?.visual.kind, "markdown");
    assert.notDeepEqual(first.png, second.png);
  });

  it("uses real uploaded image pixels as the hero and strips source metadata", async () => {
    const source = await sharp({
      create: { width: 120, height: 80, channels: 3, background: "#e02626" },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: "forbidden-synthetic-metadata" } })
      .toBuffer();
    const card = await subject(source, "image/jpeg", "landscape.jpg");
    assert.equal(card.model.preview?.visual.kind, "image");
    const hero = await sharp(card.png)
      .extract({ left: 600, top: 180, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    assert.ok((hero[0] ?? 0) > 160);
    assert.ok((hero[1] ?? 255) < 90);
    assert.equal(
      card.png.includes(Buffer.from("forbidden-synthetic-metadata")),
      false,
    );
  });

  it("keeps locator-like names and URLs out of public title, alt, and renderer text", async () => {
    const card = await subject(
      Buffer.from(
        "# https://secret.example/token\n\nfetch https://other.invalid/a\nSafe line\n",
      ),
      "text/markdown",
      "https-secret.example-token.md",
    );
    const serialized = JSON.stringify(
      card.model,
      (_key: string, value: unknown): unknown =>
        Buffer.isBuffer(value) ? "[buffer]" : value,
    );
    assert.doesNotMatch(
      serialized,
      /secret\.example|other\.invalid|https-secret/u,
    );
    assert.match(card.model.title, /Untitled|File/u);
  });

  it("renders byte-derived hex for generic binary and never draws a fake PDF page", async () => {
    const first = await subject(
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01]),
      "application/octet-stream",
      "firmware.bin",
    );
    const second = await subject(
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]),
      "application/octet-stream",
      "firmware.bin",
    );
    assert.notDeepEqual(first.png, second.png);

    const fallback = await subject(
      Buffer.from("%PDF-broken"),
      "application/pdf",
      "report.pdf",
    );
    assert.equal(fallback.model.preview?.visual.kind, "binary");
    const pageRegion = await sharp(fallback.png)
      .extract({ left: 700, top: 100, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    assert.ok(
      [...pageRegion].every((channel) => channel < 80),
      "type-led PDF fallback must not draw a fake white page",
    );
  });

  it("produces deterministic opaque 1200x630 PNGs for identical bytes", async () => {
    const bytes = Buffer.from("deterministic synthetic text");
    const first = await subject(bytes, "text/plain", "notes.txt");
    const second = await subject(bytes, "text/plain", "notes.txt");
    assert.deepEqual(first.png, second.png);
    const metadata = await sharp(first.png).metadata();
    assert.equal(metadata.width, 1200);
    assert.equal(metadata.height, 630);
    assert.equal(metadata.hasAlpha, false);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(metadata.icc, undefined);
  });
});
