// Completes the standalone output so `npm start` serves the full app.
// Next's standalone tracer intentionally omits static chunks and public
// assets; this cross-platform Node copy step packages them in. Runs as
// part of `npm run build` on macOS, Linux, and Windows.
import { access, cp } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const standalone = path.join(serverRoot, ".next", "standalone");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(standalone))) {
  console.error(
    "prepare-standalone: .next/standalone missing — run `next build` first",
  );
  process.exit(1);
}

const copies = [
  {
    from: path.join(serverRoot, ".next", "static"),
    to: path.join(standalone, ".next", "static"),
  },
  {
    from: path.join(serverRoot, "public"),
    to: path.join(standalone, "public"),
  },
];

for (const { from, to } of copies) {
  if (!(await exists(from))) continue;
  await cp(from, to, { recursive: true, force: true });
  console.log(
    `prepare-standalone: copied ${path.relative(serverRoot, from)} -> ${path.relative(serverRoot, to)}`,
  );
}
