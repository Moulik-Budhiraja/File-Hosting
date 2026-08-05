import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBounds,
  differenceHash,
  hammingDistance,
  pixelStats,
  rmse,
} from "./design-metrics";

test("pixelStats rejects a blank near-black card as content", () => {
  const blank = Buffer.alloc(12 * 8 * 3);
  for (let offset = 0; offset < blank.length; offset += 3) {
    blank[offset] = 13;
    blank[offset + 1] = 14;
    blank[offset + 2] = 16;
  }
  const result = pixelStats(blank, 12, 8);
  assert.equal(result.variance, 0);
  assert.equal(result.edgeFraction, 0);
  assert.equal(result.inkFraction, 0);
  assert.equal(result.lightFraction, 0);
  assert.equal(result.accentFraction, 0);
});

test("pixelStats measures ink, accent, variance and edges deterministically", () => {
  const pixels = Buffer.alloc(4 * 2 * 3, 0);
  const colors = [
    [13, 14, 16],
    [227, 164, 79],
    [242, 241, 236],
    [13, 14, 16],
    [13, 14, 16],
    [227, 164, 79],
    [242, 241, 236],
    [13, 14, 16],
  ];
  colors.forEach((color, index) => {
    pixels.set(color, index * 3);
  });
  const result = pixelStats(pixels, 4, 2);
  assert(result.variance > 1_000);
  assert(result.edgeFraction > 0.3);
  assert.equal(result.inkFraction, 0.5);
  assert.equal(result.lightFraction, 0.5);
  assert.equal(result.accentFraction, 0.25);
});

test("rmse is exact for identical buffers and known constant delta", () => {
  assert.equal(rmse(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3])), 0);
  assert.equal(rmse(Buffer.from([0, 0, 0]), Buffer.from([3, 3, 3])), 3);
});

test("difference hash and Hamming distance reject structure displacement", () => {
  const gradient = Buffer.alloc(9 * 8 * 3);
  const displaced = Buffer.alloc(9 * 8 * 3);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 9; x += 1) {
      const offset = (y * 9 + x) * 3;
      gradient.fill(x * 24, offset, offset + 3);
      displaced.fill(((x + 4) % 9) * 24, offset, offset + 3);
    }
  }
  const expected = differenceHash(gradient, 9, 8);
  assert.equal(expected.length, 16);
  assert.equal(hammingDistance(expected, expected), 0);
  assert.ok(hammingDistance(expected, differenceHash(displaced, 9, 8)) >= 8);
  assert.throws(() => differenceHash(Buffer.alloc(3), 9, 8));
  assert.throws(() => hammingDistance("00", "0000"));
});

test("assertBounds refuses clipped metric regions", () => {
  assert.doesNotThrow(() =>
    assertBounds({ left: 0, top: 0, width: 1200, height: 630 }),
  );
  assert.throws(() =>
    assertBounds({ left: 1199, top: 0, width: 2, height: 1 }),
  );
  assert.throws(() => assertBounds({ left: 0, top: -1, width: 1, height: 1 }));
});
