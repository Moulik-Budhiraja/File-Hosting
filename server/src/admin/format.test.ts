import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatBytes,
  formatExactBytes,
  formatInteger,
  formatListTimestamp,
  formatRecentTimestamp,
  formatUptime,
  formatUtcDateTime,
} from "./format";

describe("formatBytes", () => {
  it("uses binary units with density-appropriate precision", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(671_088_640), "640 MB");
    assert.equal(formatBytes(2_516_582), "2.4 MB");
    assert.equal(formatBytes(19_608_371), "18.7 MB");
    assert.equal(formatBytes(421_888), "412 KB");
    assert.equal(formatBytes(93_845_913_600), "87.4 GB");
    assert.equal(formatBytes(443_023_163_392), "412.6 GB");
    // GB-scale values always carry one decimal, matching the design copy.
    assert.equal(formatBytes(2_147_483_648), "2.0 GB");
    assert.equal(formatBytes(1_073_741_824), "1.0 GB");
    // KB-scale values are integers.
    assert.equal(formatBytes(4_096), "4 KB");
    assert.equal(formatBytes(18_432), "18 KB");
  });
});

describe("formatExactBytes", () => {
  it("shows grouped byte counts with a rounded suffix", () => {
    assert.equal(formatExactBytes(671_088_640), "671,088,640 bytes · 640 MB");
  });
});

describe("formatInteger", () => {
  it("groups thousands", () => {
    assert.equal(formatInteger(18_204), "18,204");
    assert.equal(formatInteger(0), "0");
  });
});

describe("timestamps", () => {
  const now = Date.parse("2026-07-31T09:41:22Z");

  it("formats full UTC date-times", () => {
    assert.equal(
      formatUtcDateTime("2026-07-31T07:11:42.000Z"),
      "2026-07-31 07:11:42 UTC",
    );
  });

  it("formats recent-file timestamps relative to today", () => {
    assert.equal(
      formatRecentTimestamp("2026-07-31T09:38:51.000Z", now),
      "09:38:51",
    );
    assert.equal(
      formatRecentTimestamp("2026-07-30T22:41:00.000Z", now),
      "yesterday",
    );
    assert.equal(
      formatRecentTimestamp("2026-07-28T06:00:00.000Z", now),
      "Jul 28",
    );
  });

  it("formats list timestamps as month day and time", () => {
    assert.equal(
      formatListTimestamp("2026-07-31T09:02:00.000Z"),
      "Jul 31 09:02",
    );
  });
});

describe("formatUptime", () => {
  it("renders days, hours, and minutes", () => {
    assert.equal(
      formatUptime(27 * 86_400 + 14 * 3_600 + 12 * 60),
      "27d 14h 12m",
    );
    assert.equal(formatUptime(59), "0m");
    assert.equal(formatUptime(3_660), "1h 1m");
  });
});
