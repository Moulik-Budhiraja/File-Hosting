import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const copyInventory = join(src, "..", "docs", "ui-copy-inventory.md");

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

test("V5 decision copy is exact and narration-free", () => {
  const productionFiles = [join(src, "app"), join(src, "ui")]
    .flatMap(productionTsxFiles)
    .filter((path) => !path.endsWith(".test.tsx"));
  const sourceOwnedCopy = productionFiles
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\s+/g, " ");

  expect(productionFiles).not.toContain(expect.stringContaining(".test.tsx"));
  expect(sourceOwnedCopy).toContain("Copy now. You won’t see it again.");
  expect(sourceOwnedCopy).toContain(
    "Another user was created. Directory reloaded — start again.",
  );
  expect(sourceOwnedCopy).not.toContain(
    "request_id is already bound to another user creation",
  );
  for (const term of [
    "NEW · RECONCILED",
    "REUSED · VERIFIED",
    "focus-order",
    "admin-view explanation",
    "Share it over a secure channel",
    "This key was created but never activated",
    "Uses your current account permissions until revoked",
    "Press Esc again to discard it permanently",
    "Sign-in is temporarily locked for this address",
    "The server returned an error and did not apply the change",
    "Your session is no longer valid — it expired or was revoked",
    "changing your password signs out every session",
    "You can re-enable this account at any time",
    "Admins have full control of every file, every user, and every API key",
    "will manage only their own files, API keys, and password",
    "A new one-time temporary password will be shown to you exactly once",
    "The key was created but its secret was lost in transit",
    "a half-created key appears in the list as pending",
    "You are signed in as",
    "Every API key issued to the account stops working immediately",
    "Anyone signed in to this server",
    "Everyone else gets the same 404",

    "would lock everyone out of user management",
    "Couldn&apos;t load keys (",
    "Couldn&apos;t load users (",
    "Couldn&apos;t load files (",
  ]) {
    const needle = term.toLocaleLowerCase("en-US");
    const offenders = productionFiles.filter((path) =>
      readFileSync(path, "utf8").toLocaleLowerCase("en-US").includes(needle),
    );
    expect(
      offenders,
      `visible copy contains V5-banned narration: ${term}`,
    ).toEqual([]);
  }
});

test("copy inventory records the shipped status-free list errors", () => {
  const inventory = readFileSync(copyInventory, "utf8").replace(/\s+/gu, " ");
  for (const resource of ["files", "keys", "users"]) {
    expect(inventory).toContain(
      `→ \`Couldn't load ${resource}\` | Drops route, status, and read-only-failure narration; Retry is the recovery action. |`,
    );
    expect(inventory).not.toContain(`Couldn't load ${resource} (<status>)`);
  }
});

test("status-free list errors carry no dead HTTP status state", () => {
  for (const name of [
    "ApiKeys.tsx",
    "UsersDirectory.tsx",
    "FilesBrowser.tsx",
  ]) {
    const source = readFileSync(join(src, "ui", name), "utf8");
    expect(source).not.toMatch(/kind: "error"; status:/u);
    expect(source).not.toMatch(/setState\(\{\s*kind: "error",\s*status:/u);
  }
});
