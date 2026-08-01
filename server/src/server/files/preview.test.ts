import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import type { FileService } from "./service";
import type { StoredFile } from "./types";
import { renderPreview } from "./preview";

const temporaryDirectories: string[] = [];

function storedFile(overrides: Partial<StoredFile> = {}): StoredFile {
  return {
    id: "Ab3dE5g",
    name: "reader.md",
    size: 0,
    mimeType: "text/markdown",
    sha256: "a".repeat(64),
    visibility: "public",
    ownerId: null,
    storageKey: "object",
    archive: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    tags: ["docs", "preview"],
    ...overrides,
  };
}

function mainContent(html: string): string {
  return /<main[^>]*>([\s\S]*)<\/main>/u.exec(html)?.[1] ?? "";
}

async function render(
  contents: string | Buffer,
  overrides: Partial<StoredFile> = {},
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fs-preview-test-"));
  temporaryDirectories.push(directory);
  const objectPath = path.join(directory, "object");
  await writeFile(objectPath, contents);
  const file = storedFile({
    size: Buffer.byteLength(contents),
    ...overrides,
  });
  const service = {
    storagePath: () => objectPath,
  } as unknown as FileService;
  return renderPreview(service, file);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Markdown preview rendering", () => {
  it("renders core and GFM document semantics instead of source markers", async () => {
    const html = await render(`# Heading one

A paragraph with *emphasis*, **strength**, ~~removed~~, [safe](https://example.test/path), and <https://example.test/auto>.

Bare https://example.test/bare.

1. ordered
   - nested
   - [x] complete
   - [ ] pending

> quoted

---

| Name | Value |
| --- | ---: |
| alpha | 1 |

Inline \`const answer = 42\`.

\`\`\`ts
const value = "safe";
\`\`\`
`);

    assert.match(html, /<article class="markdown-body"/u);
    assert.match(html, /<h1[^>]*>Heading one<\/h1>/u);
    assert.doesNotMatch(html, /># Heading one</u);
    assert.match(html, /<em>emphasis<\/em>/u);
    assert.match(html, /<strong>strength<\/strong>/u);
    assert.match(html, /<s>removed<\/s>/u);
    assert.match(html, /<ol>/u);
    assert.match(html, /<ul[^>]*>/u);
    assert.match(html, /type="checkbox"[^>]*checked/u);
    assert.match(html, /type="checkbox"[^>]*disabled/u);
    assert.match(html, /<blockquote>/u);
    assert.match(html, /<hr>/u);
    assert.match(html, /<code>const answer = 42<\/code>/u);
    assert.match(html, /<div class="code-scroll"[^>]*tabindex="0"/u);
    assert.match(html, /<div class="table-scroll"[^>]*tabindex="0"/u);
    assert.match(
      html,
      /\.markdown-body th, \.markdown-body td \{[^}]*min-width:\s*8rem;[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*normal;/u,
    );
    assert.match(html, /<a href="https:\/\/example\.test\/path"/u);
    assert.match(html, /<a href="https:\/\/example\.test\/bare"/u);
  });

  it("never turns hostile raw HTML or event attributes into executable markup", async () => {
    const html = await render(`<script>globalThis.pwned = true</script>
<img src=x onerror="globalThis.pwned = true">
<style>body{display:none}</style>
<iframe srcdoc="<script>alert(1)</script>"></iframe>
<svg onload="alert(1)"><script>alert(2)</script></svg>
<div id="__proto__">clobber</div>`);

    const preview = mainContent(html);
    assert.doesNotMatch(preview, /<script(?:\s|>)/iu);
    assert.doesNotMatch(preview, /<style(?:\s|>)/iu);
    assert.doesNotMatch(preview, /<iframe(?:\s|>)/iu);
    assert.doesNotMatch(preview, /<svg(?:\s|>)/iu);
    assert.doesNotMatch(preview, /<img(?:\s|>)/iu);
  });

  it("sanitizes dangerous, obfuscated, encoded, and protocol-relative links", async () => {
    const html = await render(`[js](javascript:alert(1))
[data](data:text/html;base64,PHNjcmlwdD4=)
[vb](vbscript:msgbox(1))
[file](file:///etc/passwd)
[network](//tracking.example/pixel)
[entities](java&#x73;cript:alert(1))
[controls](java%0ascript:alert(1))
[encoded](%6a%61%76%61%73%63%72%69%70%74:alert(1))
[relative](/docs/readme)
[fragment](#section)
[mail](mailto:reader@example.test)
[https](https://example.test/ok)`);

    for (const value of [
      "javascript:",
      "data:",
      "vbscript:",
      "file:",
      "//tracking.example",
      "java%0ascript:",
      "%6a%61%76%61%73%63%72%69%70%74:",
    ]) {
      assert.doesNotMatch(html, new RegExp(`href=["'][^"']*${value}`, "iu"));
    }
    assert.match(html, /href="\/docs\/readme"/u);
    assert.match(html, /href="#section"/u);
    assert.match(html, /href="mailto:reader@example\.test"/u);
    assert.match(html, /href="https:\/\/example\.test\/ok"/u);
    assert.match(html, /rel="(?:nofollow )?noopener noreferrer"/u);
  });

  it("disables Markdown images so remote and same-origin sources cannot beacon", async () => {
    const html =
      await render(`![remote tracking pixel](https://tracking.example/pixel.gif)
![same origin private object](/raw/Private)`);

    assert.doesNotMatch(html, /<img(?:\s|>)/iu);
    assert.doesNotMatch(html, /src="https:\/\/tracking\.example/u);
    assert.doesNotMatch(html, /src="\/raw\/Private/u);
    assert.match(html, /remote tracking pixel/u);
    assert.match(html, /same origin private object/u);
  });

  it("contains malformed Markdown, deep nesting, and long unbroken strings", async () => {
    const malformed = `${"> ".repeat(80)}deep\n\n[unfinished](https://example.test\n\n\`\`\`js\n${"a".repeat(20_000)}`;
    const html = await render(malformed);

    assert.match(html, /class="markdown-shell"/u);
    assert.match(html, /overflow-wrap:\s*anywhere/u);
    assert.match(html, /word-break:\s*break-word/u);
    assert.doesNotMatch(html, /<script(?:\s|>)/iu);
  });

  it("adds responsive metadata, readable measure, touch, focus, and forced-colors hooks", async () => {
    const html = await render("# Reader", {
      name: `<reader & "notes">.md`,
      tags: [`<tag>`, "x".repeat(120)],
      sha256: "f".repeat(64),
    });

    assert.match(
      html,
      /<h1[^>]*>&lt;reader &amp; &quot;notes&quot;&gt;\.md<\/h1>/u,
    );
    assert.doesNotMatch(html, /<tag>/u);
    assert.match(html, /class="metadata"/u);
    assert.match(html, /class="metadata-value metadata-break"/u);
    assert.match(html, /class="raw-action"/u);
    assert.match(html, /min-height:\s*44px/u);
    assert.match(html, /max-width:\s*70ch/u);
    assert.match(html, /@media\s*\(max-width:\s*480px\)/u);
    assert.match(html, /@media\s*\(forced-colors:\s*active\)/u);
    assert.match(html, /:focus-visible/u);
    assert.match(html, /overflow-x:\s*clip/u);
  });

  it("retains a visible truncation disclosure at the 256 KiB read cap", async () => {
    const html = await render(Buffer.alloc(256 * 1024 + 1, 0x61));

    assert.match(html, /Preview truncated at 256 KiB\./u);
    assert.match(html, /class="notice truncation-notice"/u);
    assert.equal(html.includes("a".repeat(256 * 1024 + 1)), false);
  });

  it("preserves non-Markdown text source previews", async () => {
    const html = await render("# not a heading\n<script>no</script>", {
      name: "plain.txt",
      mimeType: "text/plain",
    });

    assert.doesNotMatch(html, /class="markdown-body"/u);
    assert.match(html, /<pre class="text-preview"># not a heading/u);
    assert.match(html, /&lt;script&gt;no&lt;\/script&gt;/u);
  });
});
