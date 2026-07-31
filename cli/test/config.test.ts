import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { CliError } from "../src/errors.js";

test("FS_URL rejects embedded credentials before they reach keyring metadata", () => {
  assert.throws(
    () => loadConfig({ FS_URL: "https://username:password@example.com", FS_TOKEN: "" }),
    (error: unknown) => error instanceof CliError && error.exitCode === 2 && error.code === "INVALID_URL",
  );
});

test("FS_URL rejects query strings and fragments before they reach keyring metadata", () => {
  for (const value of ["https://example.com?token=secret", "https://example.com#private"]) {
    assert.throws(
      () => loadConfig({ FS_URL: value, FS_TOKEN: "" }),
      (error: unknown) => error instanceof CliError && error.exitCode === 2 && error.code === "INVALID_URL",
    );
  }
});
