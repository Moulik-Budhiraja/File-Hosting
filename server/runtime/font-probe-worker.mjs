import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fontDirectory = fileURLToPath(new URL("./fonts/", import.meta.url));
process.env.FONTCONFIG_FILE = fileURLToPath(
  new URL("./fonts/fonts.conf", import.meta.url),
);
process.env.FONTCONFIG_PATH = fontDirectory;
const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (
    typeof input?.text !== "string" ||
    typeof input?.family !== "string" ||
    (input.file !== undefined && typeof input.file !== "string")
  ) {
    throw new Error("invalid font probe input");
  }
  if (input.file) {
    const fontfile = fileURLToPath(
      new URL(`./fonts/${input.file}`, import.meta.url),
    );
    if (!GlobalFonts.registerFromPath(fontfile, input.family))
      throw new Error("bundled font registration failed");
  }
  const canvas = createCanvas(800, 120);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(0, 0, 800, 120);
  context.fillStyle = "#ffffff";
  context.font = `56px '${input.family}'`;
  context.textBaseline = "top";
  context.direction = "ltr";
  context.fillText(input.text, 4, 8, 792);
  writeSync(1, canvas.toBuffer("image/png"));
} catch (error) {
  writeSync(2, error instanceof Error ? error.message : "font probe failed");
  process.exitCode = 1;
}
