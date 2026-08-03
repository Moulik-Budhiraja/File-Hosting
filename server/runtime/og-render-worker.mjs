import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fontDirectory = fileURLToPath(new URL("./fonts/", import.meta.url));
process.env.FONTCONFIG_FILE = fileURLToPath(
  new URL("./fonts/fonts.conf", import.meta.url),
);
process.env.FONTCONFIG_PATH = fontDirectory;
const { default: sharp } = await import("sharp");

const MAX_SVG_BYTES = 10 * 1024 * 1024;
const chunks = [];
let bytes = 0;

try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_SVG_BYTES) throw new Error("render input exceeds limit");
    chunks.push(chunk);
  }
  const svg = Buffer.concat(chunks);
  const png = await sharp(svg, {
    failOn: "error",
    limitInputPixels: 40_000_000,
  })
    .timeout({ seconds: 2 })
    .flatten({ background: "#0b0d0f" })
    .removeAlpha()
    .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
    .toBuffer();
  writeSync(1, png);
} catch (error) {
  writeSync(
    2,
    error instanceof Error ? error.message : "OG render worker failed",
  );
  process.exitCode = 1;
}
