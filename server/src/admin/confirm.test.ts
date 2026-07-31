import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConfirmController } from "./confirm";

describe("createConfirmController", () => {
  it("never runs the action before an explicit confirmation", async () => {
    let runs = 0;
    const controller = createConfirmController(async () => {
      runs += 1;
    });
    assert.equal(controller.state(), "idle");
    controller.request();
    assert.equal(controller.state(), "armed");
    assert.equal(runs, 0);
    await controller.confirm();
    assert.equal(runs, 1);
    assert.equal(controller.state(), "done");
  });

  it("cancelling disarms without running the action", async () => {
    let runs = 0;
    const controller = createConfirmController(async () => {
      runs += 1;
    });
    controller.request();
    controller.cancel();
    assert.equal(controller.state(), "idle");
    await controller.confirm();
    assert.equal(runs, 0, "confirm after cancel must be a no-op");
  });

  it("confirm without a prior request is a no-op", async () => {
    let runs = 0;
    const controller = createConfirmController(async () => {
      runs += 1;
    });
    await controller.confirm();
    assert.equal(runs, 0);
  });

  it("reports failures and allows re-arming", async () => {
    let attempts = 0;
    const controller = createConfirmController(async () => {
      attempts += 1;
      throw new Error("boom");
    });
    controller.request();
    await controller.confirm();
    assert.equal(controller.state(), "error");
    assert.equal(attempts, 1);
    controller.request();
    assert.equal(controller.state(), "armed");
  });

  it("ignores double confirmation while running", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const controller = createConfirmController(async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });
    controller.request();
    await Promise.all([controller.confirm(), controller.confirm()]);
    assert.equal(maxConcurrent, 1);
  });
});
