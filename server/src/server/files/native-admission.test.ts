import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nativeAdmissionState, withNativeAdmission } from "./native-admission";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("shared native admission", () => {
  it("reuses ownership for nested preview, raster, and render work without deadlock", async () => {
    const result = await withNativeAdmission(100, async () =>
      withNativeAdmission(100, async () =>
        withNativeAdmission(100, async () => "complete"),
      ),
    );
    assert.equal(result, "complete");
    assert.deepEqual(nativeAdmissionState(), {
      active: 0,
      queued: 0,
      budgetMiB: 384,
    });
  });

  it("serializes unrelated work and recovers after a queued deadline", async () => {
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = withNativeAdmission(500, async () => {
      await ownerGate;
    });
    await delay(10);
    await assert.rejects(
      withNativeAdmission(20, async () => undefined),
      /native admission queue wait timed out/u,
    );
    assert.deepEqual(nativeAdmissionState(), {
      active: 1,
      queued: 0,
      budgetMiB: 384,
    });
    releaseOwner();
    await owner;
    const recovered = await withNativeAdmission(100, async () => "recovered");
    assert.equal(recovered, "recovered");
    assert.deepEqual(nativeAdmissionState(), {
      active: 0,
      queued: 0,
      budgetMiB: 384,
    });
  });
});
