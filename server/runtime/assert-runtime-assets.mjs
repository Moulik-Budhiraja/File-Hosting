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
const mediaBinaries = [
  require("ffmpeg-static"),
  require("ffprobe-static").path,
];
for (const binary of mediaBinaries) {
  if (typeof binary !== "string") {
    missing.push("packaged media binary resolution");
    continue;
  }
  try {
    await access(binary);
    const probe = spawnSync(binary, ["-version"], {
      encoding: "utf8",
      timeout: 5_000,
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
