import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright-core";

const baseUrl = process.env.FS_PROBE_URL;
const token = process.env.FS_PROBE_TOKEN;
const outputDirectory = process.env.FS_PROBE_SCREENSHOTS;
assert(baseUrl, "FS_PROBE_URL is required");
assert(token, "FS_PROBE_TOKEN is required");
assert(outputDirectory, "FS_PROBE_SCREENSHOTS is required");

const executableCandidates = [
  process.env.CHROME_PATH,
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Helium.app/Contents/MacOS/Helium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
let executablePath;
for (const candidate of executableCandidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {
    // Try the next supported local browser.
  }
}
assert(executablePath, "No supported Chrome/Chromium executable was found");

const markdown = `# Production Markdown probe

[x] top-level marker remains

A normal paragraph with **strong**, *emphasis*, ~~removed~~, [safe link](https://example.test/path), and https://example.test/autolink.

- nested list
  - child item
  - [x] completed task
  - [ ] pending task
  - **[x]** formatted marker remains

> A readable blockquote.

| Column one | Column two | Column three | Column four | Column five |
| --- | --- | --- | --- | --- |
| alpha | beta | gamma | delta | ${"wide-table-value-".repeat(12)} |

\`inline code\`

\`\`\`text
${"wide-code-value-".repeat(30)}
\`\`\`

![remote beacon](https://tracking.invalid/pixel.gif)

<script>globalThis.markdownProbePwned = true</script>

[unsafe](javascript:alert(1))

${"longhash".repeat(80)}
`;

const upload = await fetch(
  `${baseUrl}/api/files?name=production-markdown-probe.md&visibility=public&tag=browser-probe`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/markdown",
    },
    body: markdown,
  },
);
const uploadBody = await upload.text();
assert.equal(
  upload.status,
  201,
  `upload failed: ${upload.status} ${uploadBody}`,
);
const file = JSON.parse(uploadBody);
assert.match(file.id, /^[A-Za-z0-9]{7}$/u);

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
try {
  for (const viewport of [
    { name: "desktop-1280", width: 1280, height: 900 },
    { name: "mobile-360", width: 360, height: 800 },
    { name: "mobile-390", width: 390, height: 844 },
    { name: "mobile-430", width: 430, height: 932 },
  ]) {
    const context = await browser.newContext({
      colorScheme: "dark",
      deviceScaleFactor: 1,
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    const response = await page.goto(`${baseUrl}/${file.id}`, {
      waitUntil: "networkidle",
    });
    assert(response);
    assert.equal(response.status(), 200);
    const headers = response.headers();
    assert.equal(headers["cache-control"], "no-store");
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["referrer-policy"], "no-referrer");
    assert.match(
      headers["content-security-policy"] ?? "",
      /default-src 'none'/u,
    );
    assert.match(
      headers["content-security-policy"] ?? "",
      /frame-ancestors 'none'/u,
    );

    assert.equal(
      await page.locator("article.markdown-body h1").textContent(),
      "Production Markdown probe",
    );
    assert.equal(await page.locator("article.markdown-body strong").count(), 2);
    assert.equal(await page.locator("article.markdown-body table").count(), 1);
    assert.equal(
      await page.locator("article.markdown-body input[type=checkbox]").count(),
      2,
    );
    assert.equal(
      await page
        .locator("article.markdown-body")
        .getByText("[x] top-level marker remains", { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator("article.markdown-body strong")
        .getByText("[x]", { exact: true })
        .count(),
      1,
    );
    assert.equal(await page.locator("article.markdown-body img").count(), 0);
    assert.equal(await page.locator("script").count(), 0);
    assert.equal(
      await page.evaluate(() => globalThis.markdownProbePwned),
      undefined,
    );
    assert.equal(
      await page
        .locator('article.markdown-body a[href^="javascript:"]')
        .count(),
      0,
    );
    assert.equal(
      await page
        .locator("article.markdown-body")
        .getByText("# Production Markdown probe", { exact: true })
        .count(),
      0,
    );

    const raw = page.locator("a.raw-action");
    await raw.focus();
    const focus = await raw.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    assert(focus.height >= 44, `raw action is only ${focus.height}px tall`);
    assert.notEqual(focus.outlineStyle, "none");
    assert(focus.outlineWidth >= 2);

    const layout = await page.evaluate(() => {
      const tableScroller = document.querySelector(".table-scroll");
      const codeScroller = document.querySelector(".code-scroll");
      return {
        bodyClientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.documentElement.scrollWidth,
        codeClientWidth: codeScroller?.clientWidth ?? 0,
        codeScrollWidth: codeScroller?.scrollWidth ?? 0,
        tableClientWidth: tableScroller?.clientWidth ?? 0,
        tableScrollWidth: tableScroller?.scrollWidth ?? 0,
        tableMaxRowHeight: Math.max(
          0,
          ...Array.from(
            document.querySelectorAll("article.markdown-body tr"),
            (row) => row.getBoundingClientRect().height,
          ),
        ),
      };
    });
    assert.equal(layout.bodyScrollWidth, layout.bodyClientWidth);
    assert(layout.tableScrollWidth >= layout.tableClientWidth);
    assert(layout.codeScrollWidth >= layout.codeClientWidth);
    assert(
      layout.tableMaxRowHeight <= 80,
      `table row is ${layout.tableMaxRowHeight}px tall`,
    );
    if (viewport.width <= 430) {
      assert(layout.tableScrollWidth > layout.tableClientWidth);
      assert(layout.codeScrollWidth > layout.codeClientWidth);
    }

    const screenshot = path.join(outputDirectory, `${viewport.name}.png`);
    await page.screenshot({ fullPage: true, path: screenshot });

    await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
    const forcedColorFocus = await raw.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    assert.notEqual(forcedColorFocus.outlineStyle, "none");
    assert(forcedColorFocus.outlineWidth >= 2);
    assert.deepEqual(errors, []);

    results.push({ viewport, layout, screenshot });
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(
  JSON.stringify(
    {
      fileId: file.id,
      previewUrl: `${baseUrl}/${file.id}`,
      results,
      verdict: "pass",
    },
    null,
    2,
  ),
);
