import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const required = [
  "og-render-worker.mjs",
  "rgb-png.js",
  "font-probe-worker.mjs",
  "pdf-page-worker.mjs",
  "docx-text-worker.mjs",
  "media-command-worker.mjs",
  "media-preflight.mp4",
  "fonts/fonts.conf",
  "fonts/Inter.ttf",
  "fonts/Inter-OFL.txt",
  "fonts/JetBrainsMono.ttf",
  "fonts/JetBrainsMono-OFL.txt",
  "fonts/NotoColorEmoji.ttf",
  "fonts/NotoEmoji-OFL.txt",
  "fonts/NotoSansArabic.ttf",
  "fonts/NotoSansCJKjp-Regular.otf",
  "fonts/Noto-OFL.txt",
  "assets/twemoji/ATTRIBUTION.md",
  "assets/twemoji/LICENSE-GRAPHICS",
  "assets/unavailable.png",
];

const runtime = path.resolve(process.cwd(), "runtime");
const require = createRequire(import.meta.url);
const missing = [];
for (const relative of required) {
  try {
    await access(path.join(runtime, relative));
  } catch {
    missing.push(relative);
  }
}
const ffmpegBinary = require("ffmpeg-static");
const mediaBinaries = [ffmpegBinary, require("ffprobe-static").path];
const FFMPEG_SHA256 = Object.freeze({
  "darwin-arm64":
    "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
  "darwin-x64":
    "cfe20936c83ecf5d68e424b87e8cc45b24dd6be81787810123bb964a0df686f9",
  "linux-arm64":
    "237800b37bb65a81ad47871c6c8b7c45c0a3ca62a5b3f9d2a7a9a2dd9a338271",
  "linux-x64":
    "ed652b2f32e0851d1946894fb8333f5b677c1b2ce6b9d187910a67f8b99da028",
  "win32-x64":
    "e9fd5e711debab9d680955fc1e38a2c1160fd280b144476cc3f62bc43ef49db1",
});

async function fileSha256(filename) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

if (typeof ffmpegBinary === "string") {
  const platform = `${process.platform}-${process.arch}`;
  const expected = FFMPEG_SHA256[platform];
  if (!expected) {
    missing.push(`unsupported ffmpeg executable platform: ${platform}`);
  } else {
    try {
      if ((await fileSha256(ffmpegBinary)) !== expected) {
        missing.push("ffmpeg executable digest mismatch");
      }
    } catch {
      missing.push("ffmpeg executable digest mismatch");
    }
  }
}
for (const binary of mediaBinaries) {
  if (typeof binary !== "string") {
    missing.push("packaged media binary resolution");
    continue;
  }
  try {
    await access(binary);
    const probe = spawnSync(binary, ["-version"], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    });
    if (probe.status !== 0) {
      const detail = (probe.error?.message || probe.stderr || "unknown error")
        .replaceAll(/[\r\n]+/gu, " ")
        .slice(0, 300);
      missing.push(
        `${path.relative(process.cwd(), binary)} is not executable (${detail})`,
      );
    }
  } catch {
    missing.push(path.relative(process.cwd(), binary));
  }
}
const packageAssets = [
  "node_modules/@twemoji/svg/package.json",
  "node_modules/@twemoji/svg/1f389.svg",
  "node_modules/@twemoji/svg/2764.svg",
  "node_modules/@twemoji/svg/1f1fa-1f1f8.svg",
  "node_modules/@twemoji/svg/1f468-200d-1f469-200d-1f467-200d-1f466.svg",
  "node_modules/pdfjs-dist/standard_fonts/FoxitSerif.pfb",
  "node_modules/pdfjs-dist/standard_fonts/FoxitSerifBold.pfb",
  "node_modules/pdfjs-dist/standard_fonts/FoxitSerifItalic.pfb",
  "node_modules/pdfjs-dist/standard_fonts/FoxitSerifBoldItalic.pfb",
  "node_modules/pdfjs-dist/standard_fonts/FoxitFixed.pfb",
  "node_modules/pdfjs-dist/standard_fonts/FoxitFixedBold.pfb",
  "node_modules/pdfjs-dist/standard_fonts/FoxitFixedItalic.pfb",
  "node_modules/pdfjs-dist/standard_fonts/FoxitFixedBoldItalic.pfb",
  "node_modules/pdfjs-dist/standard_fonts/FoxitSymbol.pfb",
  "node_modules/pdfjs-dist/standard_fonts/FoxitDingbats.pfb",
];
for (const relative of packageAssets) {
  try {
    await access(path.resolve(process.cwd(), relative));
  } catch {
    missing.push(relative);
  }
}
if (missing.length > 0) {
  process.stderr.write(
    `required runtime assets missing: ${missing.join(", ")}\n`,
  );
  process.exitCode = 1;
}
