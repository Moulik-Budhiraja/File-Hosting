import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const required = [
  "runtime/og-render-worker.mjs",
  "runtime/font-probe-worker.mjs",
  "runtime/pdf-page-worker.mjs",
  "runtime/docx-text-worker.mjs",
  "runtime/fonts/fonts.conf",
  "runtime/fonts/Inter.ttf",
  "runtime/fonts/Inter-OFL.txt",
  "runtime/fonts/JetBrainsMono.ttf",
  "runtime/fonts/JetBrainsMono-OFL.txt",
  "runtime/fonts/NotoColorEmoji.ttf",
  "runtime/fonts/NotoEmoji-OFL.txt",
  "runtime/fonts/NotoSansArabic.ttf",
  "runtime/fonts/NotoSansCJKjp-Regular.otf",
  "runtime/fonts/Noto-OFL.txt",
  "runtime/assets/twemoji/1f4e1.svg",
  "runtime/assets/twemoji/1f600.svg",
  "runtime/assets/twemoji/1f680.svg",
  "runtime/assets/twemoji/ATTRIBUTION.md",
  "runtime/assets/twemoji/LICENSE-GRAPHICS",
  "runtime/assets/unavailable.png",
];

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, npm_config_update_notifier: "false" },
  maxBuffer: 8 * 1024 * 1024,
});
assert.equal(result.status, 0, result.stderr || "npm pack --dry-run failed");
const report = JSON.parse(result.stdout);
assert.ok(
  Array.isArray(report) && report.length === 1,
  "invalid npm pack report",
);
const files = new Set(report[0].files.map(({ path }) => path));
for (const asset of required) {
  assert.ok(files.has(asset), `npm package missing ${asset}`);
}
