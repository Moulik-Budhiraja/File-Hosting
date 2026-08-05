import assert from "node:assert/strict";

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PixelStats {
  mean: [number, number, number];
  variance: number;
  edgeFraction: number;
  inkFraction: number;
  lightFraction: number;
  accentFraction: number;
}

export function pixelStats(
  pixels: Buffer,
  width: number,
  height: number,
  background: readonly [number, number, number] = [13, 14, 16],
): PixelStats {
  assert.equal(pixels.length, width * height * 3);
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let luminanceSum = 0;
  let luminanceSquared = 0;
  let edges = 0;
  let edgePairs = 0;
  let ink = 0;
  let light = 0;
  let accent = 0;
  const luma = (offset: number) =>
    (pixels[offset] ?? 0) * 0.2126 +
    (pixels[offset + 1] ?? 0) * 0.7152 +
    (pixels[offset + 2] ?? 0) * 0.0722;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      redSum += red;
      greenSum += green;
      blueSum += blue;
      const value = luma(offset);
      luminanceSum += value;
      luminanceSquared += value * value;
      const distance = Math.sqrt(
        (red - background[0]) ** 2 +
          (green - background[1]) ** 2 +
          (blue - background[2]) ** 2,
      );
      if (distance >= 24) ink += 1;
      if (value >= 150) light += 1;
      if (red >= 180 && green >= 105 && green <= 205 && blue <= 120)
        accent += 1;
      if (x > 0) {
        edgePairs += 1;
        if (Math.abs(value - luma(offset - 3)) >= 18) edges += 1;
      }
      if (y > 0) {
        edgePairs += 1;
        if (Math.abs(value - luma(offset - width * 3)) >= 18) edges += 1;
      }
    }
  }
  const count = width * height;
  const meanLuminance = luminanceSum / count;
  return {
    mean: [redSum, greenSum, blueSum].map((sum) =>
      Number((sum / count).toFixed(3)),
    ) as [number, number, number],
    variance: Number(
      Math.max(0, luminanceSquared / count - meanLuminance ** 2).toFixed(3),
    ),
    edgeFraction: Number((edges / Math.max(edgePairs, 1)).toFixed(6)),
    inkFraction: Number((ink / count).toFixed(6)),
    lightFraction: Number((light / count).toFixed(6)),
    accentFraction: Number((accent / count).toFixed(6)),
  };
}

export function rmse(left: Buffer, right: Buffer): number {
  assert.equal(left.length, right.length);
  let squared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    squared += delta * delta;
  }
  return Number(Math.sqrt(squared / left.length).toFixed(3));
}

export function differenceHash(
  pixels: Buffer,
  width: number,
  height: number,
): string {
  assert.equal(width, 9);
  assert.equal(height, 8);
  assert.equal(pixels.length, width * height * 3);
  let hash = 0n;
  let bit = 0n;
  const luma = (offset: number) =>
    (pixels[offset] ?? 0) * 0.2126 +
    (pixels[offset + 1] ?? 0) * 0.7152 +
    (pixels[offset + 2] ?? 0) * 0.0722;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = (y * width + x) * 3;
      if (luma(left) > luma(left + 3)) hash |= 1n << bit;
      bit += 1n;
    }
  }
  return hash.toString(16).padStart(16, "0");
}

export function hammingDistance(left: string, right: string): number {
  assert.match(left, /^[0-9a-f]{16}$/u);
  assert.match(right, /^[0-9a-f]{16}$/u);
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (difference > 0n) {
    count += Number(difference & 1n);
    difference >>= 1n;
  }
  return count;
}

export function assertBounds(region: Region, width = 1200, height = 630): void {
  assert(Number.isInteger(region.left) && Number.isInteger(region.top));
  assert(Number.isInteger(region.width) && Number.isInteger(region.height));
  assert(region.left >= 0 && region.top >= 0);
  assert(region.width > 0 && region.height > 0);
  assert(region.left + region.width <= width);
  assert(region.top + region.height <= height);
}
