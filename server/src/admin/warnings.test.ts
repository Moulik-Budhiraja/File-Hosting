import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveWarnings } from "./warnings";

function system(overrides: {
  free: number;
  reserve: number;
  tempParts?: number;
}) {
  return {
    freeBytes: overrides.free,
    minFreeBytes: overrides.reserve,
    tempPartCount: overrides.tempParts ?? 0,
  };
}

describe("deriveWarnings", () => {
  it("is quiet when free space is comfortable and no parts linger", () => {
    assert.deepEqual(
      deriveWarnings(system({ free: 100_000, reserve: 1_000 })),
      [],
    );
  });

  it("warns when free space nears the reserve floor", () => {
    const warnings = deriveWarnings(system({ free: 1_500, reserve: 1_000 }));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.severity, "warning");
    assert.equal(warnings[0]?.kind, "free-space");
    assert.match(warnings[0]?.title ?? "", /reserve floor/i);
  });

  it("escalates to danger below the reserve floor", () => {
    const warnings = deriveWarnings(system({ free: 900, reserve: 1_000 }));
    assert.equal(warnings[0]?.severity, "danger");
    assert.equal(warnings[0]?.kind, "free-space");
    assert.match(warnings[0]?.detail ?? "", /writes refused/i);
  });

  it("mentions lingering temp parts", () => {
    const warnings = deriveWarnings(
      system({ free: 100_000, reserve: 1_000, tempParts: 3 }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]?.title ?? "", /\.part/i);
    assert.equal(warnings[0]?.severity, "info");
    assert.equal(warnings[0]?.kind, "temp-parts");
  });
});
