import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

function productionTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTsxFiles(path);
    return extname(entry.name) === ".tsx" && !entry.name.endsWith(".test.tsx")
      ? [path]
      : [];
  });
}

test("authenticated console source stays within the visible-copy budget", () => {
  const sourceOwnedCopy = [join(src, "app"), join(src, "ui")]
    .flatMap(productionTsxFiles)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\s+/g, " ");

  const forbidden = [
    "proposed",
    "backend in pr",
    "cli: authorization",
    "legacy service token",
    "shared fs_token",
    "who sees it",
    "secrets shown once at creation",
    "keys let the fs cli act as you without your password. create one, then run fs auth set on that machine.",
    "get /api/",
    "bcrypt password storage",
    "cookie httponly",
    "cli calls using this key",
    "stored bytes",
    "sessions expire 7 days",
    "every action here opens",
    "all accounts loaded",
    "fs auth set",
  ];

  for (const term of forbidden) {
    expect(
      sourceOwnedCopy.toLocaleLowerCase("en-US"),
      `visible copy contains forbidden term: ${term}`,
    ).not.toContain(term);
  }
});
