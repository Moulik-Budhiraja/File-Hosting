import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createCanvas,
  DOMMatrix,
  GlobalFonts,
  ImageData,
  Path2D,
} from "@napi-rs/canvas";

globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;

// Parser diagnostics can include untrusted document strings; keep stdout binary-only
// and do not emit anonymous-file details to logs.
console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const USE_PACKAGED_STANDARD_FONT = process.platform === "linux";
const STANDARD_HELVETICA_FAMILY = "PdfStandardHelvetica";
if (
  USE_PACKAGED_STANDARD_FONT &&
  !GlobalFonts.registerFromPath(
    fileURLToPath(
      new URL("./fonts/NotoSansCJKjp-Regular.otf", import.meta.url),
    ),
    STANDARD_HELVETICA_FAMILY,
  )
) {
  throw new Error("standard PDF font registration failed");
}

function standardPdfFontFamily(value) {
  if (!/"Helvetica(?:-(?:Bold|Oblique|BoldOblique))?"/u.test(value)) {
    return value;
  }
  return value.replace(
    /"Helvetica(?:-(?:Bold|Oblique|BoldOblique))?"(?:,[^,]+)*$/u,
    `"${STANDARD_HELVETICA_FAMILY}"`,
  );
}

const chunks = [];
let bytes = 0;

try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_PDF_BYTES) throw new Error("pdf input limit exceeded");
    chunks.push(chunk);
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: new Uint8Array(Buffer.concat(chunks)),
    disableFontFace: true,
    disableRange: true,
    disableStream: true,
    isEvalSupported: false,
    stopEvent: true,
    useSystemFonts: false,
  });
  const document = await loadingTask.promise;
  if (document.numPages < 1 || document.numPages > 10_000)
    throw new Error("invalid page count");
  const page = await document.getPage(1);
  const base = page.getViewport({ scale: 1 });
  if (
    !Number.isFinite(base.width) ||
    !Number.isFinite(base.height) ||
    base.width <= 0 ||
    base.height <= 0
  ) {
    throw new Error("invalid page geometry");
  }
  const scale = Math.min(1200 / base.width, 1200 / base.height);
  const viewport = page.getViewport({ scale });
  if (viewport.width * viewport.height > 40_000_000)
    throw new Error("page pixel limit exceeded");
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  const context = canvas.getContext("2d");
  if (USE_PACKAGED_STANDARD_FONT) {
    const fontDescriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(context),
      "font",
    );
    if (!fontDescriptor?.get || !fontDescriptor.set) {
      throw new Error("canvas font contract unavailable");
    }
    Object.defineProperty(context, "font", {
      configurable: true,
      get() {
        return fontDescriptor.get.call(context);
      },
      set(value) {
        const requested = String(value);
        const mapped = standardPdfFontFamily(requested);
        fontDescriptor.set.call(context, mapped);
      },
    });
  }
  await page.render({ canvasContext: context, viewport }).promise;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3];
    for (let channel = 0; channel < 3; channel += 1) {
      const premultiplied = Math.round(
        (image.data[offset + channel] * alpha) / 255,
      );
      image.data[offset + channel] = Math.min(255, premultiplied + 255 - alpha);
    }
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const output = canvas.toBuffer("image/png");
  if (output.length > 8 * 1024 * 1024)
    throw new Error("pdf output limit exceeded");
  writeSync(1, output);
  await document.destroy();
} catch {
  process.exitCode = 1;
}
