import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { GlobalFonts, createCanvas } = await import("@napi-rs/canvas");
const { default: sharp } = await import("sharp");

// Anonymous renders are short-lived, serialized work. Disable libvips' process-local
// caches and parallel workers so transitive RSS remains below the admission budget.
sharp.cache(false);
sharp.concurrency(1);

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
      // Width now reserves the full measured glyph extent, so a 4px anti-aliasing
      // gutter is sufficient without expanding the transitive RSS envelope.
      const padding = 4;
      const rasterWidth = textWidth + padding * 2;
      const rasterHeight = ascent + descent + padding * 2;
      const canvas = createCanvas(rasterWidth, rasterHeight);
      const context = canvas.getContext("2d");
      configure(context);
      const drawX =
        anchor === "end"
          ? textWidth + padding
          : anchor === "middle"
            ? textWidth / 2 + padding
            : padding;
      context.fillText(fittedText, drawX, ascent + padding);
      const imageX =
        anchor === "end"
          ? x - textWidth - padding
          : anchor === "middle"
            ? x - textWidth / 2 - padding
            : x - padding;
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
    width * height > MAX_INPUT_PIXELS
  ) {
    throw new Error("render dimensions exceed limit");
  }
  const prepared = Buffer.from(rasterizeBundledText(source));
  if (prepared.length > MAX_SVG_BYTES)
    throw new Error("prepared render exceeds limit");
  const encoded = await sharp(prepared, {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .timeout({ seconds: 2 })
    .flatten({ background: "#0b0d0f" })
    .removeAlpha()
    .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
    .toBuffer();
  const metadata = await sharp(encoded).metadata();
  if (
    metadata.width !== width ||
    metadata.height !== height ||
    metadata.format !== "png"
  ) {
    throw new Error("render worker produced invalid PNG metadata");
  }
  if (!metadata.hasAlpha) {
    writeSync(1, encoded);
  } else {
    // Some Linux libvips builds preserve a redundant alpha channel after
    // flatten/removeAlpha. Re-wrap explicit RGB pixels only on that platform path,
    // preserving the already-approved opaque encoding everywhere else.
    const { data: rgb, info } = await sharp(encoded)
      .flatten({ background: "#0b0d0f" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height || info.channels !== 3) {
      throw new Error("render worker did not produce an RGB raster");
    }
    const png = await sharp(rgb, {
      raw: { width, height, channels: 3 },
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .timeout({ seconds: 1 })
      .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
      .toBuffer();
    writeSync(1, png);
  }
} catch (error) {
  writeSync(
    2,
    error instanceof Error ? error.message : "OG render worker failed",
  );
  process.exitCode = 1;
}
