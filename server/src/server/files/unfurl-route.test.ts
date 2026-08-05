import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { after, before, describe, it } from "node:test";

import sharp from "sharp";

import { GET as getPreview, HEAD as headPreview } from "../../app/[id]/route";
import {
  GET as getOgImage,
  HEAD as headOgImage,
} from "../../app/og/[filename]/route";
import { layoutOgTitle, OG_RENDER_LIMITS, renderOgImage } from "./og-image";
import { PreviewBusyError } from "./preview-renderers";
import { FileService } from "./service";
import { setFileServiceForTests } from "./singleton";
import type { PublicUnfurlModel } from "./unfurl";
import type { StoredFile } from "./types";

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function ogRouteContext(id: string) {
  return { params: Promise.resolve({ filename: `${id}.png` }) };
}

async function* bytes(value: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(value);
}

async function* binaryBytes(value: Buffer): AsyncGenerator<Uint8Array> {
  yield value;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function oversizedPixelPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(50_000, 0);
  header.writeUInt32BE(50_000, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function parsedHead(html: string): Map<string, string> {
  const head = /<head>([\s\S]*?)<\/head>/u.exec(html)?.[1] ?? "";
  const values = new Map<string, string>();
  for (const match of head.matchAll(
    /<meta (?:property|name)="([^"]+)" content="([^"]*)">/gu,
  )) {
    const key = match[1]!;
    if (key.startsWith("og:") || key.startsWith("twitter:")) {
      values.set(key, match[2]!);
    }
  }
  const canonical = /<link rel="canonical" href="([^"]+)">/u.exec(head)?.[1];
  if (canonical) values.set("canonical", canonical);
  return values;
}

function privacySnapshot(response: Response, body: Buffer) {
  return {
    status: response.status,
    headers: [...response.headers.entries()],
    body: body.toString("base64"),
  };
}

describe("OG image title layout", () => {
  it("fits wide glyphs, preserves pictographs, and signals truncation", () => {
    const lines = layoutOgTitle(`${"長한".repeat(80)}${"😀".repeat(8)}`, 34, 3);
    assert.equal(lines.length, 3);
    assert.match(lines.at(-1) ?? "", /…$/u);
    assert.equal(layoutOgTitle("ship 🚀 now", 34, 3).join(" "), "ship 🚀 now");
    for (const line of lines) {
      const wideGlyphs = [...line].filter((character) =>
        /[\p{Script=Han}\p{Script=Hangul}]/u.test(character),
      ).length;
      assert.ok([...line].length + wideGlyphs <= 35);
    }
    assert.deepEqual(layoutOgTitle("annual-report-2025.pdf", 16, 3), [
      "annual-report-",
      "2025.pdf",
    ]);
    assert.deepEqual(layoutOgTitle("release notes final.pdf", 14, 3), [
      "release notes",
      "final.pdf",
    ]);
    const wideLatin = layoutOgTitle("W".repeat(60), 18, 3);
    assert.equal(wideLatin.length, 3);
    assert.match(wideLatin.at(-1) ?? "", /…$/u);
    assert.ok(
      wideLatin.every((line) => [...line.replace(/…$/u, "")].length <= 9),
    );
  });

  it("renders the approved satellite emoji as deterministic color artwork", async () => {
    const output = await renderOgImage(
      {} as FileService,
      { size: 1 } as StoredFile,
      {
        title: "研究データ📡-résumé-Δ.md",
        description: "MD · 59 B",
        ogType: "article",
        twitterCard: "summary",
        canonicalUrl: "https://example.test/Ab3dE5g",
        imageUrl: "https://example.test/og/Ab3dE5g.png",
        imageAlt: "safe",
        kind: "markdown",
      },
    );
    const { data } = await sharp(output)
      .extract({ left: 0, top: 350, width: 1100, height: 250 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let orangePixels = 0;
    for (let offset = 0; offset < data.length; offset += 3) {
      const red = data[offset] ?? 0;
      const green = data[offset + 1] ?? 0;
      const blue = data[offset + 2] ?? 0;
      if (red > 220 && green > 120 && green < 210 && blue < 100) {
        orangePixels += 1;
      }
    }
    assert.ok(orangePixels > 10, "expected Twemoji orange signal pixels");
  });

  it("fails safe when a legacy model contains XML-illegal scalars", async () => {
    const output = await renderOgImage(
      {} as FileService,
      { size: 1 } as StoredFile,
      {
        title: "legacy\uFFFFtitle",
        description: "Binary file · 1 B",
        ogType: "website",
        twitterCard: "summary",
        canonicalUrl: "https://example.test/Ab3dE5g",
        imageUrl: "https://example.test/og/Ab3dE5g.png",
        imageAlt: "safe",
        kind: "binary",
      },
    );
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, 1200);
    assert.equal(metadata.height, 630);
  });

  it("bounds the complete in-process card renderer", async () => {
    assert.deepEqual(OG_RENDER_LIMITS, {
      maxConcurrent: 1,
      maxQueued: 16,
      maxOldSpaceMiB: 256,
      maxOutputBytes: 8 * 1024 * 1024,
      queueTimeoutMs: 2_500,
      wallTimeoutMs: 2_500,
    });
    const model: PublicUnfurlModel = {
      title: "bounded-card.txt",
      description: "Text document · 1 B",
      ogType: "article",
      twitterCard: "summary",
      canonicalUrl: "https://example.test/Ab3dE5g",
      imageUrl: "https://example.test/og/Ab3dE5g.png",
      imageAlt: "safe",
      kind: "document",
    };
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () =>
        renderOgImage({} as FileService, { size: 1 } as StoredFile, model),
      ),
    );
    const fulfilled = results.filter(({ status }) => status === "fulfilled");
    const rejected = results.filter(({ status }) => status === "rejected");

    assert.equal(fulfilled.length, 17);
    assert.equal(rejected.length, 23);
    for (const result of results) {
      if (result.status === "rejected") {
        assert.match(String(result.reason), /Preview rendering is busy/u);
      }
    }
  });
});

describe("rich unfurl routes", { concurrency: false }, () => {
  let directory: string;
  let service: FileService;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fs-rich-unfurl-route-"));
    service = await FileService.create({
      token: "synthetic-test-token-with-enough-entropy",
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: path.join(directory, "objects"),
      publicUrl: "https://canonical.example.test",
      maxUploadBytes: 25 * 1024 * 1024,
      minFreeBytes: 0,
    });
    setFileServiceForTests(service);
  });

  after(async () => {
    setFileServiceForTests(null);
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("emits complete initial metadata from configured origin despite spoofed hosts", async () => {
    const file = await service.upload(
      bytes("# Canonical title\n\nNever quote this hostile body."),
      {
        name: "fallback.md",
        tags: ["forbidden-tag"],
        visibility: "public",
        archive: null,
        mimeType: "text/markdown",
      },
    );
    const response = await getPreview(
      new Request(`https://evil.example/${file.id}`, {
        headers: {
          host: "evil.example",
          forwarded: "host=attacker.invalid;proto=http",
          "x-forwarded-host": "attacker.invalid",
          "x-forwarded-proto": "http",
        },
      }),
      routeContext(file.id),
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    const tags = parsedHead(html);
    assert.deepEqual(Object.fromEntries(tags), {
      "og:site_name": "File-Hosting",
      "og:title": "fallback.md",
      "og:description": `Markdown · ${file.size} B`,
      "og:type": "article",
      "og:url": `https://canonical.example.test/${file.id}`,
      "og:image": `https://canonical.example.test/og/${file.id}.png`,
      "og:image:width": "1200",
      "og:image:height": "630",
      "og:image:type": "image/png",
      "og:image:alt": `File-Hosting preview card: fallback.md, Markdown · ${file.size} B`,
      "twitter:card": "summary_large_image",
      "twitter:title": "fallback.md",
      "twitter:description": `Markdown · ${file.size} B`,
      "twitter:image": `https://canonical.example.test/og/${file.id}.png`,
      "twitter:image:alt": `File-Hosting preview card: fallback.md, Markdown · ${file.size} B`,
      canonical: `https://canonical.example.test/${file.id}`,
    });
    const head = /<head>([\s\S]*?)<\/head>/u.exec(html)?.[1] ?? "";
    assert.match(
      head,
      /<meta name="robots" content="index,follow,max-image-preview:large">/u,
    );
    assert.equal(response.headers.get("x-robots-tag"), null);
    assert.doesNotMatch(html, /evil\.example|attacker\.invalid/u);
    assert.doesNotMatch(head, /forbidden-tag|Never quote this hostile body/u);
    assert.doesNotMatch(head, /<script(?:\s|>)/iu);
  });

  it("serves stable precomputed metadata across a transient artifact read failure", async () => {
    const file = await service.upload(bytes("busy source bytes"), {
      name: "busy-public.txt",
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "text/plain",
    });
    const originalStoragePath = service.storagePath.bind(service);
    const request = async (head: boolean): Promise<Response> => {
      let targetCalls = 0;
      service.storagePath = (candidate: StoredFile) => {
        if (candidate.id === file.id && ++targetCalls === 2) {
          throw new PreviewBusyError();
        }
        return originalStoragePath(candidate);
      };
      try {
        return head
          ? await headPreview(
              new Request(`https://canonical.example.test/${file.id}`, {
                method: "HEAD",
              }),
              routeContext(file.id),
            )
          : await getPreview(
              new Request(`https://canonical.example.test/${file.id}`),
              routeContext(file.id),
            );
      } finally {
        service.storagePath = originalStoragePath;
      }
    };

    const get = await request(false);
    assert.equal(get.status, 200);
    const html = await get.text();
    assert.doesNotMatch(html, /File unavailable/u);
    assert.match(
      html,
      new RegExp(
        `property="og:image" content="https://canonical\\.example\\.test/og/${file.id}\\.png"`,
        "u",
      ),
    );
    assert.match(html, /busy-public\.txt/u);
    assert.match(html, new RegExp(file.sha256, "u"));
    const head = await request(true);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.deepEqual([...head.headers.entries()], [...get.headers.entries()]);
  });

  it("emits the exact allowlisted tag set for every public file class", async () => {
    const cases = [
      ["notes.txt", "text/plain", "TXT", "article"],
      ["audit.pdf", "application/pdf", "PDF", "article"],
      ["recording.mp3", "audio/mpeg", "MP3", "website"],
      ["clip.mp4", "video/mp4", "MP4", "website"],
      ["archive.zip", "application/zip", "ZIP", "website"],
    ] as const;
    const expectedKeys = [
      "canonical",
      "og:description",
      "og:image",
      "og:image:alt",
      "og:image:height",
      "og:image:type",
      "og:image:width",
      "og:site_name",
      "og:title",
      "og:type",
      "og:url",
      "twitter:card",
      "twitter:description",
      "twitter:image",
      "twitter:image:alt",
      "twitter:title",
    ];
    for (const [name, mimeType, label, ogType] of cases) {
      const file = await service.upload(
        bytes("synthetic body never described"),
        {
          name,
          tags: ["forbidden-exact-tag"],
          visibility: "public",
          archive: null,
          mimeType,
        },
      );
      const response = await getPreview(
        new Request(`https://spoofed.invalid/${file.id}`),
        routeContext(file.id),
      );
      const tags = parsedHead(await response.text());
      assert.deepEqual([...tags.keys()].sort(), expectedKeys);
      assert.equal(tags.get("og:title"), name);
      assert.equal(tags.get("og:type"), ogType);
      assert.equal(tags.get("twitter:card"), "summary_large_image");
      assert.equal(tags.get("og:description"), `${label} · ${file.size} B`);
      assert.equal(tags.get("twitter:description"), tags.get("og:description"));
      assert.equal(
        tags.get("og:url"),
        `https://canonical.example.test/${file.id}`,
      );
      assert.equal(tags.get("canonical"), tags.get("og:url"));
      assert.doesNotMatch(
        JSON.stringify(Object.fromEntries(tags)),
        /synthetic body|forbidden-exact-tag|\/raw\/|og:audio|og:video/u,
      );
    }
  });

  it("fails closed when the file revision disappears during metadata rendering", async () => {
    const file = await service.upload(bytes("# Race-safe title"), {
      name: "race-safe.md",
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "text/markdown",
    });
    const originalGet = service.get.bind(service);
    let targetReads = 0;
    service.get = async (id: string) => {
      if (id === file.id) {
        targetReads += 1;
        if (targetReads > 1) return null;
      }
      return originalGet(id);
    };
    try {
      const response = await getPreview(
        new Request(`https://canonical.example.test/${file.id}`),
        routeContext(file.id),
      );
      assert.equal(response.status, 200);
      assert.equal(targetReads, 2);
    } finally {
      service.get = originalGet;
    }
  });

  it("fails closed when source bytes disappear after the initial lookup", async () => {
    const file = await service.upload(bytes("# Source race"), {
      name: "source-race.md",
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "text/markdown",
    });
    const originalStoragePath = service.storagePath.bind(service);
    let pathReads = 0;
    service.storagePath = (candidate: StoredFile) => {
      if (candidate.id === file.id) {
        pathReads += 1;
        if (pathReads > 1) return path.join(directory, "missing-source");
      }
      return originalStoragePath(candidate);
    };
    try {
      const response = await getPreview(
        new Request(`https://canonical.example.test/${file.id}`),
        routeContext(file.id),
      );
      const missing = await getPreview(
        new Request("https://canonical.example.test/0000000"),
        routeContext("0000000"),
      );
      assert.deepEqual(
        privacySnapshot(response, Buffer.from(await response.arrayBuffer())),
        privacySnapshot(missing, Buffer.from(await missing.arrayBuffer())),
      );
      pathReads = 0;
      const image = await getOgImage(
        new Request(`https://canonical.example.test/og/${file.id}.png`),
        ogRouteContext(file.id),
      );
      const missingImage = await getOgImage(
        new Request("https://canonical.example.test/og/0000000.png"),
        ogRouteContext("0000000"),
      );
      assert.deepEqual(
        privacySnapshot(image, Buffer.from(await image.arrayBuffer())),
        privacySnapshot(
          missingImage,
          Buffer.from(await missingImage.arrayBuffer()),
        ),
      );
    } finally {
      service.storagePath = originalStoragePath;
    }
  });

  it("fails closed on same-size source replacement after page and image rendering", async () => {
    for (const target of ["page", "image"] as const) {
      const originalBytes = `# ${target} original`;
      const replacementBytes = `# ${target} replaced`;
      assert.equal(
        Buffer.byteLength(originalBytes),
        Buffer.byteLength(replacementBytes),
      );
      const file = await service.upload(bytes(originalBytes), {
        name: `${target}-same-size.md`,
        tags: [],
        visibility: "public",
        archive: null,
        mimeType: "text/markdown",
      });
      const originalGet = service.get.bind(service);
      let targetReads = 0;
      service.get = async (id: string) => {
        if (id === file.id) {
          targetReads += 1;
          if (targetReads === 2) {
            await writeFile(service.storagePath(file), replacementBytes);
          }
        }
        return originalGet(id);
      };
      try {
        const response =
          target === "page"
            ? await getPreview(
                new Request(`https://canonical.example.test/${file.id}`),
                routeContext(file.id),
              )
            : await getOgImage(
                new Request(`https://canonical.example.test/og/${file.id}.png`),
                ogRouteContext(file.id),
              );
        assert.equal(response.status, 200);
        assert.doesNotMatch(await response.text(), /original|replaced/u);
      } finally {
        service.get = originalGet;
      }
    }
  });

  it("serves GET and HEAD consistently without a body for HEAD", async () => {
    const file = await service.upload(bytes("binary"), {
      name: "archive.bin",
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "application/octet-stream",
    });
    const get = await getPreview(
      new Request(`https://request.invalid/${file.id}`),
      routeContext(file.id),
    );
    const head = await headPreview(
      new Request(`https://request.invalid/${file.id}`, { method: "HEAD" }),
      routeContext(file.id),
    );
    assert.equal(head.status, get.status);
    assert.deepEqual([...head.headers.entries()], [...get.headers.entries()]);
    assert.equal(await head.text(), "");
  });

  it("keeps private, protected, unauthorized, missing, and deleted byte-identical", async () => {
    const privateFile = await service.upload(bytes("private secret bytes"), {
      name: "private-secret.txt",
      tags: ["private-tag"],
      visibility: "private",
      archive: null,
      mimeType: "text/plain",
    });
    const protectedFile = await service.upload(
      bytes("protected secret bytes"),
      {
        name: "protected-secret.txt",
        tags: ["protected-tag"],
        visibility: "protected",
        archive: null,
        mimeType: "text/plain",
      },
    );
    const deletedFile = await service.upload(bytes("deleted secret bytes"), {
      name: "deleted-secret.txt",
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "text/plain",
    });
    await service.delete(deletedFile.id);
    const unreadableFile = await service.upload(
      bytes("unreadable secret bytes"),
      {
        name: "unreadable-secret.txt",
        tags: [],
        visibility: "public",
        archive: null,
        mimeType: "text/plain",
      },
    );
    await chmod(service.storagePath(unreadableFile), 0);

    const ids = [
      privateFile.id,
      protectedFile.id,
      "0000000",
      deletedFile.id,
      unreadableFile.id,
    ];
    const pageSnapshots = [];
    const imageSnapshots = [];
    for (const id of ids) {
      const page = await getPreview(
        new Request(`https://canonical.example.test/${id}`),
        routeContext(id),
      );
      pageSnapshots.push(
        privacySnapshot(page, Buffer.from(await page.arrayBuffer())),
      );
      const image = await getOgImage(
        new Request(`https://canonical.example.test/og/${id}.png`),
        ogRouteContext(id),
      );
      imageSnapshots.push(
        privacySnapshot(image, Buffer.from(await image.arrayBuffer())),
      );
    }
    const originalGet = service.get.bind(service);
    service.get = async (id: string) => {
      if (id === "BUSY000") throw new PreviewBusyError();
      return originalGet(id);
    };
    try {
      const busyPage = await getPreview(
        new Request("https://canonical.example.test/BUSY000"),
        routeContext("BUSY000"),
      );
      const busyImage = await getOgImage(
        new Request("https://canonical.example.test/og/BUSY000.png"),
        ogRouteContext("BUSY000"),
      );
      pageSnapshots.push(
        privacySnapshot(busyPage, Buffer.from(await busyPage.arrayBuffer())),
      );
      imageSnapshots.push(
        privacySnapshot(busyImage, Buffer.from(await busyImage.arrayBuffer())),
      );
    } finally {
      service.get = originalGet;
    }
    for (const snapshot of pageSnapshots.slice(1))
      assert.deepEqual(snapshot, pageSnapshots[0]);
    for (const snapshot of imageSnapshots.slice(1))
      assert.deepEqual(snapshot, imageSnapshots[0]);
    assert.equal(pageSnapshots[0]?.status, 200);
    assert.equal(imageSnapshots[0]?.status, 200);
    const pageBody = Buffer.from(pageSnapshots[0].body, "base64").toString(
      "utf8",
    );
    assert.match(pageBody, /File unavailable/u);
    assert.match(pageBody, /Preview unavailable/u);
    const imageBody = Buffer.from(imageSnapshots[0].body, "base64");
    assert.equal(imageBody.subarray(1, 4).toString("ascii"), "PNG");
    for (const snapshot of pageSnapshots) {
      const headers = new Headers(snapshot.headers);
      assert.equal(headers.get("referrer-policy"), "same-origin");
    }
    for (const snapshot of imageSnapshots) {
      const headers = new Headers(snapshot.headers);
      assert.equal(headers.get("referrer-policy"), "no-referrer");
    }
    for (const snapshot of [...pageSnapshots, ...imageSnapshots]) {
      const headers = new Headers(snapshot.headers);
      assert.equal(headers.get("x-content-type-options"), "nosniff");
      assert.match(
        headers.get("content-security-policy") ?? "",
        /frame-ancestors 'none'/u,
      );
      const decoded = Buffer.from(snapshot.body, "base64").toString("utf8");
      assert.doesNotMatch(
        decoded,
        /private-secret|protected-secret|deleted-secret|private-tag|protected-tag/u,
      );
    }

    for (const id of ids) {
      const pageHead = await headPreview(
        new Request(`https://canonical.example.test/${id}`, { method: "HEAD" }),
        routeContext(id),
      );
      const imageHead = await headOgImage(
        new Request(`https://canonical.example.test/og/${id}.png`, {
          method: "HEAD",
        }),
        ogRouteContext(id),
      );
      assert.equal(pageHead.status, 200);
      assert.equal(imageHead.status, 200);
      assert.equal(await pageHead.text(), "");
      assert.equal(await imageHead.text(), "");
      assert.deepEqual(
        [...pageHead.headers.entries()],
        pageSnapshots[0]?.headers,
      );
      assert.deepEqual(
        [...imageHead.headers.entries()],
        imageSnapshots[0]?.headers,
      );
    }
  });

  it("omits social metadata for authenticated private and protected page views", async () => {
    for (const visibility of ["private", "protected"] as const) {
      const file = await service.upload(bytes("authorized secret bytes"), {
        name: `${visibility}-authorized-secret.txt`,
        tags: ["authorized-secret-tag"],
        visibility,
        archive: null,
        mimeType: "text/plain",
      });
      const page = await getPreview(
        new Request(`https://canonical.example.test/${file.id}`, {
          headers: {
            authorization: "Bearer synthetic-test-token-with-enough-entropy",
          },
        }),
        routeContext(file.id),
      );
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.equal(parsedHead(html).size, 0);
      assert.match(html, new RegExp(`${visibility}-authorized-secret`, "u"));
      const image = await getOgImage(
        new Request(`https://canonical.example.test/og/${file.id}.png`, {
          headers: {
            authorization: "Bearer synthetic-test-token-with-enough-entropy",
          },
        }),
        ogRouteContext(file.id),
      );
      assert.equal(image.status, 200);
      assert.doesNotMatch(
        await image.text(),
        /authorized secret|authorized-secret/u,
      );
    }
  });

  it("rechecks public visibility and deletion on every no-store image request", async () => {
    const file = await service.upload(bytes("public bytes"), {
      name: "transition.bin",
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "application/octet-stream",
    });
    const first = await getOgImage(
      new Request(`https://canonical.example.test/og/${file.id}.png`),
      ogRouteContext(file.id),
    );
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    await service.update(file.id, { visibility: "private" });
    assert.equal(
      (
        await getOgImage(
          new Request(`https://canonical.example.test/og/${file.id}.png`),
          ogRouteContext(file.id),
        )
      ).status,
      200,
    );
    await service.update(file.id, { visibility: "public" });
    assert.equal(
      (
        await getOgImage(
          new Request(`https://canonical.example.test/og/${file.id}.png`),
          ogRouteContext(file.id),
        )
      ).status,
      200,
    );
    await service.delete(file.id);
    assert.equal(
      (
        await getOgImage(
          new Request(`https://canonical.example.test/og/${file.id}.png`),
          ogRouteContext(file.id),
        )
      ).status,
      200,
    );
  });

  it("fails closed when the file revision disappears during image generation", async () => {
    const file = await service.upload(bytes("race-safe public bytes"), {
      name: "race-safe.bin",
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "application/octet-stream",
    });
    const originalGet = service.get.bind(service);
    let targetReads = 0;
    service.get = async (id: string) => {
      if (id === file.id) {
        targetReads += 1;
        if (targetReads > 1) return null;
      }
      return originalGet(id);
    };
    try {
      const response = await getOgImage(
        new Request(`https://canonical.example.test/og/${file.id}.png`),
        ogRouteContext(file.id),
      );
      assert.equal(response.status, 200);
      assert.equal(targetReads, 2);
    } finally {
      service.get = originalGet;
    }
  });

  it("returns a deterministic 1200 by 630 PNG with defensive GET and HEAD headers", async () => {
    const file = await service.upload(bytes("card"), {
      name: "typography-card.bin",
      tags: ["not-in-pixels"],
      visibility: "public",
      archive: null,
      mimeType: "application/octet-stream",
    });
    const first = await getOgImage(
      new Request(`https://canonical.example.test/og/${file.id}.png`),
      ogRouteContext(file.id),
    );
    const second = await getOgImage(
      new Request(`https://spoofed.invalid/og/${file.id}.png`),
      ogRouteContext(file.id),
    );
    const firstBytes = Buffer.from(await first.arrayBuffer());
    const secondBytes = Buffer.from(await second.arrayBuffer());
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/png");
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(first.headers.get("x-content-type-options"), "nosniff");
    assert.equal(first.headers.get("referrer-policy"), "no-referrer");
    assert.match(
      first.headers.get("content-security-policy") ?? "",
      /default-src 'none'.*frame-ancestors 'none'/u,
    );
    assert.equal(firstBytes.readUInt32BE(16), 1200);
    assert.equal(firstBytes.readUInt32BE(20), 630);
    const imageMetadata = await sharp(firstBytes).metadata();
    assert.equal(imageMetadata.hasAlpha, false);
    const corner = await sharp(firstBytes)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    assert.deepEqual([...corner], [0x0d, 0x0e, 0x10]);
    assert.deepEqual(firstBytes, secondBytes);
    const persisted = JSON.parse(
      await readFile(
        path.join(
          service.config.storageDir,
          ".unfurl-artifacts",
          `${file.id}-${file.sha256}-og-v2-881d043.json`,
        ),
        "utf8",
      ),
    ) as { cardBase64?: string };
    assert.deepEqual(
      Buffer.from(persisted.cardBase64 ?? "", "base64"),
      firstBytes,
    );
    for (const forbidden of [
      file.id,
      file.sha256,
      file.storageKey,
      "not-in-pixels",
      "/raw/",
      "Bearer",
    ]) {
      assert.equal(firstBytes.includes(Buffer.from(forbidden)), false);
    }

    const head = await headOgImage(
      new Request(`https://canonical.example.test/og/${file.id}.png`, {
        method: "HEAD",
      }),
      ogRouteContext(file.id),
    );
    assert.equal(head.status, first.status);
    assert.deepEqual([...head.headers.entries()], [...first.headers.entries()]);
    assert.equal(await head.text(), "");
  });

  it("derives eligible JPEG, PNG, and WebP safely and strips source metadata", async () => {
    const formats = [
      ["jpeg", "image/jpeg", "photo.jpg"],
      ["png", "image/png", "photo.png"],
      ["webp", "image/webp", "photo.webp"],
    ] as const;
    for (const [format, mimeType, name] of formats) {
      let sourcePipeline = sharp({
        create: {
          width: 80,
          height: 40,
          channels: 3,
          background: { r: 210, g: 20, b: 30 },
        },
      });
      if (format === "jpeg") {
        sourcePipeline = sourcePipeline.jpeg({ quality: 90 }).withExif({
          IFD0: { Copyright: "synthetic-forbidden-copyright" },
          IFD3: { GPSLatitude: "51/1 30/1 0/1" },
        });
      } else if (format === "png") {
        sourcePipeline = sourcePipeline.png();
      } else {
        sourcePipeline = sourcePipeline.webp({ quality: 90 });
      }
      const source = await sourcePipeline.toBuffer();
      const file = await service.upload(binaryBytes(source), {
        name,
        tags: ["forbidden-raster-tag"],
        visibility: "public",
        archive: null,
        mimeType,
      });
      const page = await getPreview(
        new Request(`https://canonical.example.test/${file.id}`),
        routeContext(file.id),
      );
      assert.equal(
        parsedHead(await page.text()).get("twitter:card"),
        "summary_large_image",
      );
      const response = await getOgImage(
        new Request(`https://canonical.example.test/og/${file.id}.png`),
        ogRouteContext(file.id),
      );
      assert.equal(response.status, 200);
      const output = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.width, 1200);
      assert.equal(metadata.height, 630);
      assert.equal(metadata.format, "png");
      assert.equal(metadata.hasAlpha, false);
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.icc, undefined);
      assert.equal(metadata.iptc, undefined);
      assert.equal(metadata.xmp, undefined);
      assert.equal(metadata.comments, undefined);
      const pixel = await sharp(output)
        .extract({ left: 900, top: 300, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer();
      assert.ok((pixel[0] ?? 0) > 150);
      assert.ok((pixel[1] ?? 255) < 80);
      assert.ok((pixel[2] ?? 255) < 100);
      const corner = await sharp(output)
        .extract({ left: 720, top: 114, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer();
      assert.ok((corner[0] ?? 0) > 150);
      assert.ok((corner[1] ?? 255) < 80);
      assert.ok((corner[2] ?? 255) < 100);
      for (const forbidden of [
        "synthetic-forbidden-copyright",
        "forbidden-raster-tag",
        file.id,
        file.storageKey,
        file.sha256,
      ]) {
        assert.equal(output.includes(Buffer.from(forbidden)), false);
      }
    }
  });

  it("reports auto-oriented raster dimensions truthfully", async () => {
    const oriented = await sharp({
      create: {
        width: 120,
        height: 60,
        channels: 3,
        background: "red",
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const file = await service.upload(binaryBytes(oriented), {
      name: "portrait.jpg",
      tags: [],
      visibility: "public",
      archive: null,
      mimeType: "image/jpeg",
      contentLength: oriented.length,
    });
    const response = await getPreview(
      new Request(`https://canonical.example.test/${file.id}`),
      routeContext(file.id),
    );
    assert.equal(
      parsedHead(await response.text()).get("og:description"),
      `JPEG · ${file.size} B · 60×120`,
    );
  });

  it("falls back safely for malformed, bomb, oversized, SVG, and GIF sources", async () => {
    const gif = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "#ff0000",
      },
    })
      .gif()
      .toBuffer();
    const cases: Array<{ name: string; mimeType: string; source: Buffer }> = [
      {
        name: "malformed.png",
        mimeType: "image/png",
        source: Buffer.from("not a png"),
      },
      {
        name: "pixel-bomb.png",
        mimeType: "image/png",
        source: oversizedPixelPng(),
      },
      {
        name: "active.svg",
        mimeType: "image/svg+xml",
        source: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>forbidden-script</script></svg>',
        ),
      },
      { name: "animated.gif", mimeType: "image/gif", source: gif },
      {
        name: "oversized.png",
        mimeType: "image/png",
        source: Buffer.alloc(20 * 1024 * 1024 + 1, 0x41),
      },
    ];
    for (const fixture of cases) {
      const file = await service.upload(binaryBytes(fixture.source), {
        name: fixture.name,
        tags: ["fallback-forbidden-tag"],
        visibility: "public",
        archive: null,
        mimeType: fixture.mimeType,
      });
      const page = await getPreview(
        new Request(`https://canonical.example.test/${file.id}`),
        routeContext(file.id),
      );
      assert.equal(
        parsedHead(await page.text()).get("twitter:card"),
        "summary_large_image",
      );
      const first = await getOgImage(
        new Request(`https://canonical.example.test/og/${file.id}.png`),
        ogRouteContext(file.id),
      );
      const second = await getOgImage(
        new Request(`https://canonical.example.test/og/${file.id}.png`),
        ogRouteContext(file.id),
      );
      assert.equal(first.status, 200);
      const firstBytes = Buffer.from(await first.arrayBuffer());
      const secondBytes = Buffer.from(await second.arrayBuffer());
      assert.deepEqual(firstBytes, secondBytes);
      const metadata = await sharp(firstBytes).metadata();
      assert.equal(metadata.width, 1200);
      assert.equal(metadata.height, 630);
      assert.equal(metadata.format, "png");
      for (const forbidden of [
        "forbidden-script",
        "fallback-forbidden-tag",
        file.id,
        file.sha256,
        file.storageKey,
      ]) {
        assert.equal(firstBytes.includes(Buffer.from(forbidden)), false);
      }
    }
  });
});
