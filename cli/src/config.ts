import { CliError, EXIT } from "./errors.js";

export interface Config {
  baseUrl: string;
  token: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.FS_URL?.trim() || "https://files.moulik.dev";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CliError(`FS_URL is not a valid URL: ${rawUrl}`, EXIT.usage, "INVALID_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("FS_URL must use http or https", EXIT.usage, "INVALID_URL");
  }
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    token: env.FS_TOKEN?.trim() || "",
  };
}
