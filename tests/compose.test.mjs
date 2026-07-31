import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("compose forwards bootstrap credentials into the server container", async () => {
  const compose = await readFile(path.join(rootDir, "compose.yaml"), "utf8");

  assert.match(
    compose,
    /^\s+FS_BOOTSTRAP_USERNAME: \$\{FS_BOOTSTRAP_USERNAME:-\}$/mu,
  );
  assert.match(
    compose,
    /^\s+FS_BOOTSTRAP_PASSWORD: \$\{FS_BOOTSTRAP_PASSWORD:-\}$/mu,
  );
});
