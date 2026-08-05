import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  settleUnavailableTiming,
  UNAVAILABLE_TIMING_FLOOR_MS,
  unavailableImageResponse,
  unavailablePageResponse,
} from "./unavailable";

describe("generic unavailable responses", () => {
  it("uses the current configured origin rather than a baked deployment URL", async () => {
    const response = unavailablePageResponse(
      true,
      "https://configured.example.test/prefix",
    );
    const body = await response.text();
    assert.match(
      body,
      /<meta property="og:url" content="https:\/\/configured\.example\.test">/u,
    );
    assert.match(
      body,
      /<meta property="og:image" content="https:\/\/configured\.example\.test\/og\/0000000\.png">/u,
    );
    assert.doesNotMatch(body, /files\.moulik\.dev/u);
  });

  it("uses byte-identical stable headers for every unavailable class", async () => {
    const page = unavailablePageResponse(
      true,
      "https://configured.example.test",
    );
    const image = await unavailableImageResponse(true);
    assert.equal(page.headers.get("date"), "Thu, 01 Jan 1970 00:00:00 GMT");
    assert.equal(image.headers.get("date"), "Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("converges repeated early and late classes into one sub-2500ms schedule", async () => {
    const ages = [0, 500, 1_000, 1_800, 2_200, 2_480];
    const totals = await Promise.all(
      Array.from({ length: 5 }, () => ages)
        .flat()
        .map(async (age) => {
          const startedAt = performance.now() - age;
          await settleUnavailableTiming(startedAt);
          return performance.now() - startedAt;
        }),
    );
    const minimum = Math.min(...totals);
    const maximum = Math.max(...totals);
    assert.ok(minimum >= UNAVAILABLE_TIMING_FLOOR_MS - 25, `${minimum}ms`);
    assert.ok(maximum < 2_500, `${maximum}ms`);
    assert.ok(maximum - minimum < 175, `${maximum - minimum}ms spread`);
  });
});
