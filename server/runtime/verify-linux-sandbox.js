import { spawnSync } from "node:child_process";
import { linuxSandboxArguments } from "./linux-sandbox.js";

const result = spawnSync(
  "/usr/bin/bwrap",
  [...linuxSandboxArguments(process.cwd()), "--", "/usr/bin/true"],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
