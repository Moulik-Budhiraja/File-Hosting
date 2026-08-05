import { spawnSync } from "node:child_process";
import path from "node:path";

const selector = process.argv[2];
const executable =
  selector === "ffprobe"
    ? path.resolve(
        process.cwd(),
        "node_modules/ffprobe-static/bin",
        process.platform,
        process.arch,
        process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
      )
    : selector === "ffmpeg"
      ? path.resolve(
          process.cwd(),
          "node_modules/ffmpeg-static",
          process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
        )
      : null;
if (!executable) process.exit(64);

const result = spawnSync(executable, process.argv.slice(3), {
  env: process.env,
  maxBuffer: 8 * 1024 * 1024,
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 20_000,
});
if (result.error || result.status !== 0 || !result.stdout) process.exit(1);
process.stdout.write(result.stdout);
