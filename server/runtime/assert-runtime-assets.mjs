import { access } from "node:fs/promises";
import path from "node:path";

const required = [
  "og-render-worker.mjs",
  "pdf-page-worker.mjs",
  "docx-text-worker.mjs",
  "fonts/fonts.conf",
  "fonts/Inter.ttf",
  "fonts/Inter-OFL.txt",
  "fonts/JetBrainsMono.ttf",
  "fonts/JetBrainsMono-OFL.txt",
  "fonts/NotoColorEmoji.ttf",
  "fonts/NotoEmoji-OFL.txt",
  "assets/twemoji/1f4e1.svg",
  "assets/twemoji/1f600.svg",
  "assets/twemoji/1f680.svg",
  "assets/twemoji/ATTRIBUTION.md",
  "assets/twemoji/LICENSE-GRAPHICS",
  "assets/unavailable.png",
];

const runtime = path.resolve(process.cwd(), "runtime");
const missing = [];
for (const relative of required) {
  try {
    await access(path.join(runtime, relative));
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
