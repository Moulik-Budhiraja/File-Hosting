import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advancePager,
  initialPager,
  pagerLabel,
  resetPager,
  retreatPager,
} from "./pagination";

describe("cursor pager", () => {
  it("walks forward and backward through cursor history", () => {
    let pager = initialPager();
    assert.equal(pager.cursor, undefined);
    assert.equal(pager.page, 1);

    pager = advancePager(pager, "cursor-a");
    assert.equal(pager.cursor, "cursor-a");
    assert.equal(pager.page, 2);

    pager = advancePager(pager, "cursor-b");
    assert.equal(pager.page, 3);

    pager = retreatPager(pager);
    assert.equal(pager.cursor, "cursor-a");
    assert.equal(pager.page, 2);

    pager = retreatPager(pager);
    assert.equal(pager.cursor, undefined);
    assert.equal(pager.page, 1);

    pager = retreatPager(pager);
    assert.equal(pager.page, 1, "retreat at the first page is a no-op");
  });

  it("resets history when filters change", () => {
    let pager = advancePager(initialPager(), "cursor-a");
    pager = resetPager();
    assert.equal(pager.page, 1);
    assert.equal(pager.cursor, undefined);
  });

  it("labels the visible row range", () => {
    const first = initialPager();
    assert.equal(pagerLabel(first, 16, 16, true), "rows 1–16 · more available");
    const second = advancePager(first, "c");
    assert.equal(pagerLabel(second, 16, 3, false), "rows 17–19");
    assert.equal(pagerLabel(first, 16, 0, false), "no rows");
  });
});
