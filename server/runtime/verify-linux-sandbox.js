import { spawnSync } from "node:child_process";
import { linuxSandboxArguments } from "./linux-sandbox.js";

const result = spawnSync(
  "/usr/bin/bwrap",
  [
    ...linuxSandboxArguments(process.cwd(), process.cwd(), process.execPath),
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
