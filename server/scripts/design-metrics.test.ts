import assert from "node:assert/strict";
import test from "node:test";

import { assertBounds, pixelStats, rmse } from "./design-metrics";

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

test("assertBounds refuses clipped metric regions", () => {
  assert.doesNotThrow(() =>
    assertBounds({ left: 0, top: 0, width: 1200, height: 630 }),
  );
  assert.throws(() =>
    assertBounds({ left: 1199, top: 0, width: 2, height: 1 }),
  );
  assert.throws(() => assertBounds({ left: 0, top: -1, width: 1, height: 1 }));
});
