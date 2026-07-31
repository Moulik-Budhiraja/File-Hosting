// Finding 8: the System page's "compose.yaml default" copy must come from ONE
// typed model that this test proves against the real compose.yaml — the
// displayed healthcheck/log defaults can no longer drift silently.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  COMPOSE_DEFAULTS,
  healthcheckSummary,
  loggingSummary,
  parseComposeDefaults,
} from "./compose-defaults";

const COMPOSE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../../compose.yaml",
);

describe("compose-derived defaults", () => {
  it("matches the repository compose.yaml exactly", async () => {
    const parsed = parseComposeDefaults(await readFile(COMPOSE_PATH, "utf8"));
    assert.deepEqual(parsed, COMPOSE_DEFAULTS);
  });

  it("renders the displayed copy from the typed model", () => {
    const health = healthcheckSummary(COMPOSE_DEFAULTS.healthcheck);
    assert.match(health, /probes \/healthz/);
    assert.match(
      health,
      new RegExp(`interval ${COMPOSE_DEFAULTS.healthcheck.interval}`),
    );
    assert.match(
      health,
      new RegExp(`timeout ${COMPOSE_DEFAULTS.healthcheck.timeout}`),
    );
    assert.match(
      health,
      new RegExp(`retries ${COMPOSE_DEFAULTS.healthcheck.retries}`),
    );
    assert.match(
      health,
      new RegExp(`start period ${COMPOSE_DEFAULTS.healthcheck.startPeriod}`),
    );
    const logging = loggingSummary(COMPOSE_DEFAULTS.logging);
    assert.match(logging, new RegExp(COMPOSE_DEFAULTS.logging.driver));
    assert.match(logging, /10 MB × 3 files/);
  });

  it("fails loudly when compose.yaml no longer contains the expected fields", () => {
    assert.throws(() => parseComposeDefaults("services: {}"), /healthcheck/);
  });
});
