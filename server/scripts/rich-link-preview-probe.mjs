import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright-core";
import sharp from "sharp";

const baseUrl = process.env.FS_PROBE_URL;
const token = process.env.FS_PROBE_TOKEN;
const outputDirectory = process.env.FS_PROBE_SCREENSHOTS;
assert(baseUrl, "FS_PROBE_URL is required");
assert(token, "FS_PROBE_TOKEN is required");
assert(outputDirectory, "FS_PROBE_SCREENSHOTS is required");
const probeUrl = new URL(baseUrl);
assert.notEqual(
  probeUrl.hostname,
  "files.moulik.dev",
  "production probing is forbidden",
);
assert(
  probeUrl.hostname === "localhost" ||
    probeUrl.hostname === "127.0.0.1" ||
    probeUrl.hostname === "::1" ||
    probeUrl.hostname.endsWith(".test") ||
    probeUrl.hostname.endsWith(".invalid"),
  "FS_PROBE_URL must be an explicitly non-production localhost/.test/.invalid target",
);

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
    // Try the next supported browser.
  }
}
assert(executablePath, "No supported Chrome/Chromium executable was found");

const authHeaders = { authorization: `Bearer ${token}` };

async function upload(name, mimeType, visibility, body, tags = []) {
  const query = new URLSearchParams({ name, visibility });
  for (const tag of tags) query.append("tag", tag);
  const response = await fetch(`${baseUrl}/api/files?${query}`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": mimeType },
    body,
  });
  const text = await response.text();
  assert.equal(
    response.status,
    201,
    `upload failed: ${response.status} ${text}`,
  );
  const file = JSON.parse(text);
  assert.match(file.id, /^[A-Za-z0-9]{7}$/u);
  return file;
}

function headValues(html) {
  const head = /<head>([\s\S]*?)<\/head>/u.exec(html)?.[1] ?? "";
  const values = new Map();
  for (const match of head.matchAll(
    /<meta (?:property|name)="([^"]+)" content="([^"]*)">/gu,
  )) {
    const key = match[1];
    if (key.startsWith("og:") || key.startsWith("twitter:")) {
      values.set(key, match[2]);
    }
  }
  const canonical = /<link rel="canonical" href="([^"]+)">/u.exec(head)?.[1];
  if (canonical) values.set("canonical", canonical);
  return { head, values };
}

async function privacySnapshot(url, method = "GET") {
  const response = await fetch(url, { method });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    nosniff: response.headers.get("x-content-type-options"),
    referrerPolicy: response.headers.get("referrer-policy"),
    body: Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
}

await mkdir(outputDirectory, { recursive: true });
const hostileBody =
  "# Release &lt;safe&gt; &amp; “quoted” \u202E report\r\n\nOwner: forbidden-owner\n\n<script>globalThis.pwned=true</script>\n\nNever quote this generated body.";
const markdown = await upload(
  "fallback-secret-name.md",
  "text/markdown",
  "public",
  hostileBody,
  ["forbidden-probe-tag"],
);

const rasterSource = await sharp({
  create: {
    width: 640,
    height: 360,
    channels: 3,
    background: { r: 204, g: 61, b: 70 },
  },
})
  .withExif({ IFD0: { Copyright: "forbidden-source-comment" } })
  .jpeg({ quality: 88 })
  .toBuffer();
const raster = await upload(
  "synthetic-raster.jpg",
  "image/jpeg",
  "public",
  rasterSource,
  ["forbidden-raster-tag"],
);
const privateFile = await upload(
  "private-probe-secret.txt",
  "text/plain",
  "private",
  "private-probe-body",
  ["private-probe-tag"],
);
const unicodeName = `${"長い名前한글Ж😀".repeat(9)}.bin`;
const unicodeFile = await upload(
  unicodeName,
  "application/octet-stream",
  "public",
  "unicode-card",
);
const wideTitleFile = await upload(
  "ANNUAL_REPORT_Q4_2024_FINAL_V3.PDF",
  "application/octet-stream",
  "public",
  "wide-title-card",
);

const crawlerResponse = await fetch(`${baseUrl}/${markdown.id}`, {
  headers: {
    "user-agent": "SyntheticSocialCrawler/1.0",
    forwarded: "host=attacker.invalid;proto=https",
    "x-forwarded-host": "attacker.invalid",
    "x-forwarded-proto": "https",
  },
});
assert.equal(crawlerResponse.status, 200);
assert.equal(crawlerResponse.headers.get("cache-control"), "no-store");
assert.equal(crawlerResponse.headers.get("x-content-type-options"), "nosniff");
assert.equal(crawlerResponse.headers.get("referrer-policy"), "no-referrer");
assert.match(
  crawlerResponse.headers.get("content-security-policy") ?? "",
  /frame-ancestors 'none'/u,
);
const html = await crawlerResponse.text();
const { head, values } = headValues(html);
const exactKeys = [
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
].sort();
assert.deepEqual([...values.keys()].sort(), exactKeys);
assert.equal(values.get("canonical"), `${baseUrl}/${markdown.id}`);
assert.equal(values.get("og:url"), `${baseUrl}/${markdown.id}`);
assert.equal(values.get("og:image"), `${baseUrl}/og/${markdown.id}.png`);
assert.equal(values.get("og:title"), "fallback-secret-name.md");
assert.match(values.get("og:description") ?? "", /^Markdown · \d+ B$/u);
assert.equal(values.get("og:type"), "article");
assert.equal(values.get("twitter:card"), "summary_large_image");
assert.equal(values.get("twitter:title"), values.get("og:title"));
assert.equal(values.get("twitter:description"), values.get("og:description"));
assert.equal(values.get("twitter:image"), values.get("og:image"));
assert.doesNotMatch(
  head,
  /attacker\.invalid|forbidden|Owner:|Never quote|\/raw\//u,
);
assert.doesNotMatch(head, /<script(?:\s|>)/iu);

const rasterPage = await fetch(`${baseUrl}/${raster.id}`);
const rasterValues = headValues(await rasterPage.text()).values;
assert.equal(rasterValues.get("twitter:card"), "summary_large_image");
assert.match(
  rasterValues.get("og:description") ?? "",
  /^JPEG · \d+(?:\.\d+)? (?:B|KB) · 640×360$/u,
);

const imageResponse = await fetch(`${baseUrl}/og/${raster.id}.png`);
const secondImageResponse = await fetch(`${baseUrl}/og/${raster.id}.png`);
assert.equal(imageResponse.status, 200);
assert.equal(imageResponse.headers.get("content-type"), "image/png");
assert.equal(imageResponse.headers.get("cache-control"), "no-store");
assert.equal(imageResponse.headers.get("x-content-type-options"), "nosniff");
assert.equal(imageResponse.headers.get("referrer-policy"), "no-referrer");
assert.match(
  imageResponse.headers.get("content-security-policy") ?? "",
  /default-src 'none'.*frame-ancestors 'none'/u,
);
const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
const secondImageBytes = Buffer.from(await secondImageResponse.arrayBuffer());
assert.deepEqual(imageBytes, secondImageBytes);
const imageMetadata = await sharp(imageBytes).metadata();
assert.equal(imageMetadata.format, "png");
assert.equal(imageMetadata.width, 1200);
assert.equal(imageMetadata.height, 630);
assert.equal(imageMetadata.hasAlpha, false);
assert.equal(imageMetadata.exif, undefined);
assert.equal(imageMetadata.icc, undefined);
assert.equal(imageMetadata.xmp, undefined);
assert.equal(imageMetadata.iptc, undefined);
assert.doesNotMatch(
  imageBytes.toString("latin1"),
  /forbidden|private-probe|owner|token|authorization|\/raw\//iu,
);
await writeFile(
  path.join(outputDirectory, "generated-raster-card.png"),
  imageBytes,
);

const imageHead = await fetch(`${baseUrl}/og/${raster.id}.png`, {
  method: "HEAD",
});
assert.equal(imageHead.status, imageResponse.status);
assert.equal(
  imageHead.headers.get("content-length"),
  String(imageBytes.length),
);
assert.equal(await imageHead.text(), "");

const missingId = "0000000";
const privatePage = await privacySnapshot(`${baseUrl}/${privateFile.id}`);
const missingPage = await privacySnapshot(`${baseUrl}/${missingId}`);
assert.deepEqual(privatePage, missingPage);
const privateImage = await privacySnapshot(
  `${baseUrl}/og/${privateFile.id}.png`,
);
const missingImage = await privacySnapshot(`${baseUrl}/og/${missingId}.png`);
assert.deepEqual(privateImage, missingImage);

const transition = await fetch(`${baseUrl}/api/files/${markdown.id}`, {
  method: "PATCH",
  headers: { ...authHeaders, "content-type": "application/json" },
  body: JSON.stringify({ visibility: "private" }),
});
assert.equal(transition.status, 200, await transition.text());
assert.deepEqual(
  await privacySnapshot(`${baseUrl}/og/${markdown.id}.png`),
  missingImage,
);

const browser = await chromium.launch({ executablePath, headless: true });
const captures = [];
try {
  const scenarios = [
    {
      name: "desktop-light-raster",
      viewport: { width: 1280, height: 760 },
      colorScheme: "light",
      forcedColors: "none",
      imageUrl: `${baseUrl}/og/${raster.id}.png`,
      background: "#f5f5f7",
    },
    {
      name: "desktop-dark-raster",
      viewport: { width: 1280, height: 760 },
      colorScheme: "dark",
      forcedColors: "none",
      imageUrl: `${baseUrl}/og/${raster.id}.png`,
      background: "#090a0d",
    },
    {
      name: "desktop-light-wide-title",
      viewport: { width: 1280, height: 760 },
      colorScheme: "light",
      forcedColors: "none",
      imageUrl: `${baseUrl}/og/${wideTitleFile.id}.png`,
      background: "#f5f5f7",
    },
    {
      name: "mobile-light-unicode",
      viewport: { width: 390, height: 700 },
      colorScheme: "light",
      forcedColors: "none",
      imageUrl: `${baseUrl}/og/${unicodeFile.id}.png`,
      background: "#ffffff",
    },
    {
      name: "mobile-forced-colors-unicode",
      viewport: { width: 390, height: 700 },
      colorScheme: "dark",
      forcedColors: "active",
      imageUrl: `${baseUrl}/og/${unicodeFile.id}.png`,
      background: "Canvas",
    },
  ];
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      viewport: scenario.viewport,
      colorScheme: scenario.colorScheme,
      forcedColors: scenario.forcedColors,
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:${scenario.background}}
      body{display:grid;place-items:center;padding:20px;font-family:system-ui,sans-serif}
      main{width:min(100%,900px)}
      img{display:block;width:100%;height:auto;border:0}
    </style></head><body><main><img alt="Generated File-Hosting preview" src="${scenario.imageUrl}"></main></body></html>`);
    await page.locator("img").evaluate((image) => image.decode());
    const metrics = await page.locator("img").evaluate((image) => ({
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      width: image.getBoundingClientRect().width,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    assert.equal(metrics.naturalWidth, 1200);
    assert.equal(metrics.naturalHeight, 630);
    assert(metrics.width <= scenario.viewport.width - 40 + 0.5);
    assert.equal(metrics.documentWidth, metrics.viewportWidth);
    assert.deepEqual(errors, []);
    const screenshot = path.join(outputDirectory, `${scenario.name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    captures.push({ ...scenario, screenshot, metrics });
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(
  JSON.stringify(
    {
      metadata: Object.fromEntries(values),
      rasterMetadata: Object.fromEntries(rasterValues),
      image: {
        bytes: imageBytes.length,
        width: imageMetadata.width,
        height: imageMetadata.height,
        deterministic: true,
        metadataStripped: true,
      },
      privacy: "private/missing page and image snapshots are identical",
      captures,
    },
    null,
    2,
  ),
);
