import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyLoadOutcome, initialLoadState } from "./load-state";

describe("load-state freshness model", () => {
  it("marks successful loads fresh with a last-success timestamp", () => {
    const state = applyLoadOutcome(initialLoadState<number>(), {
      ok: true,
      data: 42,
      at: 1_000,
    });
    assert.equal(state.status, "ready");
    assert.equal(state.data, 42);
    assert.equal(state.stale, false);
    assert.equal(state.lastSuccessAt, 1_000);
  });

  it("keeps stale data on refresh failure but flags it and keeps last success", () => {
    const loaded = applyLoadOutcome(initialLoadState<number>(), {
      ok: true,
      data: 42,
      at: 1_000,
    });
    const failed = applyLoadOutcome(loaded, {
      ok: false,
      kind: "disconnected",
      message: "Could not reach the server",
      at: 31_000,
    });
    assert.equal(failed.status, "disconnected");
    assert.equal(failed.data, 42);
    assert.equal(failed.stale, true);
    assert.equal(failed.lastSuccessAt, 1_000);
    assert.equal(failed.message, "Could not reach the server");
  });

  it("does not report staleness when there was never any data", () => {
    const failed = applyLoadOutcome(initialLoadState<number>(), {
      ok: false,
      kind: "api",
      message: "boom",
      at: 5,
    });
    assert.equal(failed.status, "api");
    assert.equal(failed.data, null);
    assert.equal(failed.stale, false);
    assert.equal(failed.lastSuccessAt, null);
  });

  it("clears staleness once a later refresh succeeds", () => {
    let state = applyLoadOutcome(initialLoadState<number>(), {
      ok: true,
      data: 1,
      at: 1,
    });
    state = applyLoadOutcome(state, {
      ok: false,
      kind: "api",
      message: "x",
      at: 2,
    });
    state = applyLoadOutcome(state, { ok: true, data: 2, at: 3 });
    assert.equal(state.status, "ready");
    assert.equal(state.stale, false);
    assert.equal(state.data, 2);
    assert.equal(state.lastSuccessAt, 3);
  });
});
