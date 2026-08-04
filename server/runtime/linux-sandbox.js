import { existsSync } from "node:fs";

/**
 * @param {string} rootCwd
 * @param {string} [childCwd]
 * @param {string} [executable]
 */
export function linuxSandboxArguments(
  rootCwd,
  childCwd = rootCwd,
  executable = process.execPath,
) {
  if (!rootCwd || !childCwd || !executable) {
    throw new TypeError("sandbox paths are required");
  }
  const args = [
    "--die-with-parent",
    "--unshare-all",
    "--new-session",
    ...["--ro-bind", "/usr", "/usr"],
  ];
  /** @type {Array<[string, string, string]>} */
  const optionalMounts = [
    ["--ro-bind", "/lib", "/lib"],
    ["--ro-bind", "/lib64", "/lib64"],
  ];
  if (executable === "/opt" || executable.startsWith("/opt/")) {
    optionalMounts.push(["--ro-bind", "/opt", "/opt"]);
  }
  for (const mount of optionalMounts) {
    if (existsSync(mount[1])) args.push(...mount);
  }
  args.push(
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    ...["--bind", "/tmp", "/tmp"],
    "--ro-bind",
    rootCwd,
    rootCwd,
    "--chdir",
    childCwd,
  );
  return args;
}
