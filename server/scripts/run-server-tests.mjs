import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const testDirectories = ["src/server/auth", "src/server/files"];
const isolated = new Set([
  "og-rss.test.ts",
  "og-v2.test.ts",
  "preview-derivation.test.ts",
  "process-tree.test.ts",
  "unfurl-route.test.ts",
]);
const all = testDirectories.flatMap((directory) =>
  readdirSync(path.join(root, directory))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => path.join(directory, name)),
);
const previewFile = "src/server/files/preview-derivation.test.ts";
const nativePreviewPatterns = [
  "derives a real video poster",
  "derives audio waveform samples",
  "uses safe embedded audio artwork",
  "derives a real waveform and duration",
];
const groups = [
  { files: all.filter((filename) => !isolated.has(path.basename(filename))) },
  { files: ["src/server/files/og-v2.test.ts"] },
  {
    files: [previewFile],
    args: [`--test-skip-pattern=${nativePreviewPatterns.join("|")}`],
  },
  ...nativePreviewPatterns.map((pattern) => ({
    files: [previewFile],
    args: [`--test-name-pattern=${pattern}`],
  })),
  { files: ["src/server/files/unfurl-route.test.ts"] },
  { files: ["src/server/files/process-tree.test.ts"] },
  { files: ["src/server/files/og-rss.test.ts"] },
];
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
for (const group of groups) {
  const result = spawnSync(
    process.execPath,
    [
      tsx,
      "--test",
      "--test-concurrency=1",
      ...(group.args ?? []),
      ...group.files,
    ],
    { cwd: root, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
