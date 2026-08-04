import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/**
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 */
function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = (CRC_TABLE[(crc ^ (buffer[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} [data]
 */
function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk, 4, data.length + 8), data.length + 8);
  return chunk;
}

/**
 * @param {Buffer} rgb
 * @param {number} width
 * @param {number} height
 */
export function encodeRgbPng(rgb, width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("invalid RGB raster dimensions");
  }
  const rowBytes = width * 3;
  if (rgb.length !== rowBytes * height) {
    throw new Error("invalid RGB raster length");
  }
  const scanlines = Buffer.allocUnsafe((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const outputOffset = row * (rowBytes + 1);
    scanlines[outputOffset] = 0;
    rgb.copy(scanlines, outputOffset + 1, row * rowBytes, (row + 1) * rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 1 })),
    pngChunk("IEND"),
  ]);
}

/**
 * @param {Buffer} png
 * @param {number} width
 * @param {number} height
 */
export function validateOpaquePng(png, width, height) {
  if (
    png.length < 45 ||
    !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return false;
  }
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawData = false;
  while (offset <= png.length - 12) {
    const length = png.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > png.length) return false;
    const type = png.toString("ascii", offset + 4, dataStart);
    if (png.readUInt32BE(dataEnd) !== crc32(png, offset + 4, dataEnd)) {
      return false;
    }
    if (!sawHeader) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        png.readUInt32BE(dataStart) !== width ||
        png.readUInt32BE(dataStart + 4) !== height ||
        png[dataStart + 8] !== 8 ||
        png[dataStart + 9] !== 2 ||
        png[dataStart + 10] !== 0 ||
        png[dataStart + 11] !== 0 ||
        png[dataStart + 12] !== 0
      ) {
        return false;
      }
      sawHeader = true;
    } else if (type === "IDAT") {
      if (length < 1) return false;
      sawData = true;
    } else if (type === "IEND") {
      return sawData && length === 0 && chunkEnd === png.length;
    }
    offset = chunkEnd;
  }
  return false;
}
