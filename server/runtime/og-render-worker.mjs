import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { encodeRgbPng, validateOpaquePng } from "./rgb-png.js";

const { GlobalFonts, createCanvas } = await import("@napi-rs/canvas");
const { default: sharp } = await import("sharp");

// Anonymous renders are short-lived, serialized work. Disable libvips' process-local
// SIMD alpha-compositing rounds edge channels differently across arm64 and x64.
// Keep the byte-derived card raster architecture-independent before PNG encoding.
sharp.cache(false);
sharp.concurrency(1);
sharp.simd(false);

const bundledFonts = [
  ["Inter.ttf", "Inter"],
  ["JetBrainsMono.ttf", "JetBrains Mono"],
  ["NotoSansCJKjp-Regular.otf", "Noto Sans CJK JP"],
  ["NotoSansArabic.ttf", "Noto Sans Arabic"],
  ["NotoColorEmoji.ttf", "Noto Color Emoji"],
];
for (const [filename, family] of bundledFonts) {
  const registered = GlobalFonts.registerFromPath(
    fileURLToPath(new URL(`./fonts/${filename}`, import.meta.url)),
    family,
  );
  if (!registered)
    throw new Error(`failed to register bundled font: ${family}`);
}

const MAX_SVG_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const OUTPUT_WIDTH = 1200;
const OUTPUT_HEIGHT = 630;
const MAX_OUTPUT_PIXELS = OUTPUT_WIDTH * OUTPUT_HEIGHT;
const PRIMARY_RENDER_SECONDS = 2;
const chunks = [];
let bytes = 0;

function attribute(markup, name) {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "u").exec(markup)?.[1];
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function rasterizeBundledText(svg) {
  return svg.replace(
    /<text\s+([^>]*)>([^<]*)<\/text>/gu,
    (_match, attrs, raw) => {
      const x = Number(attribute(attrs, "x") ?? 0);
      const y = Number(attribute(attrs, "y") ?? 0);
      const size = Number(attribute(attrs, "font-size") ?? 16);
      const weight = attribute(attrs, "font-weight") ?? "400";
      const family = attribute(attrs, "font-family") ?? "Inter,sans-serif";
      const fill = attribute(attrs, "fill") ?? "#000000";
      const anchor = attribute(attrs, "text-anchor") ?? "start";
      const letterSpacing = Number(attribute(attrs, "letter-spacing") ?? 0);
      if (![x, y, size, letterSpacing].every(Number.isFinite) || size <= 0) {
        throw new Error("invalid text geometry");
      }
      const text = decodeXml(raw);
      const maxWidth = Number(attribute(attrs, "data-max-width") ?? 0);
      const ellipsis = attribute(attrs, "data-ellipsis") === "true";
      const configure = (context) => {
        context.fillStyle = fill;
        context.font = `${weight} ${size}px ${family}`;
        context.textAlign =
          anchor === "end" ? "right" : anchor === "middle" ? "center" : "left";
        context.textBaseline = "alphabetic";
        context.direction = /[\u0590-\u08ff]/u.test(text) ? "rtl" : "ltr";
        if ("letterSpacing" in context)
          context.letterSpacing = `${letterSpacing}px`;
      };
      const measuring = createCanvas(1, 1).getContext("2d");
      configure(measuring);
      const segmenter = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      });
      const widthOf = (value) => {
        const metrics = measuring.measureText(value);
        const count = [...segmenter.segment(value)].length;
        const positiveTracking =
          Math.max(0, letterSpacing) * Math.max(0, count - 1);
        // Negative tracking must never shrink the backing raster below the font's
        // measured glyph extent. @napi-rs/canvas does not include tracking in
        // measureText(), so subtracting it cropped the final grapheme.
        return (
          Math.max(
            metrics.width,
            metrics.actualBoundingBoxRight +
              Math.max(0, metrics.actualBoundingBoxLeft),
          ) + positiveTracking
        );
      };
      let fittedText = text;
      if (
        Number.isFinite(maxWidth) &&
        maxWidth > 0 &&
        widthOf(text) > maxWidth
      ) {
        const graphemes = [...segmenter.segment(text)].map(
          ({ segment }) => segment,
        );
        const suffix = ellipsis ? "…" : "";
        while (
          graphemes.length > 0 &&
          widthOf(`${graphemes.join("")}${suffix}`) > maxWidth
        ) {
          graphemes.pop();
        }
        fittedText = `${graphemes.join("").replace(/[\s.…-]+$/u, "")}${suffix}`;
      }
      const metrics = measuring.measureText(fittedText);
      const textWidth = Math.max(1, Math.ceil(widthOf(fittedText)));
      const ascent = Math.max(
        1,
        Math.ceil(metrics.actualBoundingBoxAscent || size),
      );
      const descent = Math.max(
        1,
        Math.ceil(metrics.actualBoundingBoxDescent || size * 0.25),
      );
      const padding = 4;
      const baseRasterWidth = textWidth + padding * 2;
      const baseDrawX =
        anchor === "end"
          ? textWidth + padding
          : anchor === "middle"
            ? textWidth / 2 + padding
            : padding;
      const inkLeft = baseDrawX - (metrics.actualBoundingBoxLeft || 0);
      const inkRight = baseDrawX + (metrics.actualBoundingBoxRight || 0);
      const extraLeft = Math.max(0, Math.ceil(padding - inkLeft));
      const extraRight = Math.max(
        0,
        Math.ceil(inkRight - (baseRasterWidth - padding)),
      );
      const rasterWidth = baseRasterWidth + extraLeft + extraRight;
      const rasterHeight = ascent + descent + padding * 2;
      const canvas = createCanvas(rasterWidth, rasterHeight);
      const context = canvas.getContext("2d");
      configure(context);
      const drawX = baseDrawX + extraLeft;
      context.fillText(fittedText, drawX, ascent + padding);
      const baseImageX =
        anchor === "end"
          ? x - textWidth - padding
          : anchor === "middle"
            ? x - textWidth / 2 - padding
            : x - padding;
      // Expanding the temporary raster must not move the SVG alignment point.
      const imageX = baseImageX - extraLeft;
      const imageY = y - ascent - padding;
      const data = canvas.toBuffer("image/png").toString("base64");
      return `<image href="data:image/png;base64,${data}" x="${imageX}" y="${imageY}" width="${rasterWidth}" height="${rasterHeight}"/>`;
    },
  );
}

try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_SVG_BYTES) throw new Error("render input exceeds limit");
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  const root = /<svg\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/u.exec(source);
  const width = Number(root?.[1]);
  const height = Number(root?.[2]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_OUTPUT_PIXELS
  ) {
    throw new Error("render dimensions exceed limit");
  }
  const prepared = Buffer.from(rasterizeBundledText(source));
  if (prepared.length > MAX_SVG_BYTES)
    throw new Error("prepared render exceeds limit");
  const diagnosticPrefix =
    process.env.OG_RENDER_DIAGNOSTIC === "1"
      ? Buffer.from(
          `OGDI${createHash("sha256").update(prepared).digest("hex")}\n`,
        )
      : Buffer.alloc(0);
  if (process.platform === "linux") {
    const { data: rgb, info } = await sharp(prepared, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .timeout({ seconds: PRIMARY_RENDER_SECONDS })
      .flatten({ background: "#0b0d0f" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height || info.channels !== 3) {
      throw new Error("render worker did not produce an RGB raster");
    }
    const png = encodeRgbPng(rgb, width, height);
    writeSync(1, diagnosticPrefix);
    writeSync(1, png);
  } else {
    const encoded = await sharp(prepared, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .timeout({ seconds: PRIMARY_RENDER_SECONDS })
      .flatten({ background: "#0b0d0f" })
      .removeAlpha()
      .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
      .toBuffer();
    if (!validateOpaquePng(encoded, width, height)) {
      throw new Error("render worker produced invalid PNG metadata");
    }
    writeSync(1, diagnosticPrefix);
    writeSync(1, encoded);
  }
} catch (error) {
  writeSync(
    2,
    error instanceof Error ? error.message : "OG render worker failed",
  );
  process.exitCode = 1;
}
