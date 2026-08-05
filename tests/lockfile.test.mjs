import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("every production server lockfile node is registry-resolved with sha512 integrity", async () => {
  const lock = JSON.parse(
    await readFile(path.join(rootDir, "server", "package-lock.json"), "utf8"),
  );
  const failures = Object.entries(lock.packages)
    .filter(
      ([location, metadata]) =>
        Boolean(location) && !metadata.link && metadata.dev !== true,
    )
    .filter(
      ([, metadata]) =>
        !/^https:\/\/registry\.npmjs\.org\//u.test(metadata.resolved ?? "") ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(metadata.integrity ?? ""),
    )
    .map(([location]) => location);

  assert.deepEqual(
    failures,
    [],
    `production lockfile nodes missing registry provenance: ${failures.join(", ")}`,
  );
});
