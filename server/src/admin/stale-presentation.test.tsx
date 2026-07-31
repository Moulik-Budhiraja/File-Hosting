// Finding 1: on a stale/disconnected /api/system, retained EPHEMERAL state
// (in-flight transfers) must never render as currently streaming, and no
// capability/status row may keep a green success/on cue.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { StatusRow } from "./components/StatusRow";
import {
  TransfersPanel,
  type TransferEntry,
} from "./components/TransfersPanel";

const RETAINED_TRANSFER: TransferEntry = {
  direction: "upload",
  name: "retained-upload.bin",
  bytes: 512,
  total_bytes: 1024,
  started_at: "2026-07-31T10:00:00.000Z",
};

describe("TransfersPanel under stale data", () => {
  it("suppresses retained transfers on a failed refresh and shows neutral unavailable copy with the last success time", () => {
    const markup = renderToStaticMarkup(
      <TransfersPanel
        status="disconnected"
        transfers={[RETAINED_TRANSFER]}
        lastSuccessAt={Date.UTC(2026, 6, 31, 10, 0, 5)}
      />,
    );
    // Never a "streaming" row from retained data.
    assert.doesNotMatch(markup, /streaming/);
    assert.doesNotMatch(markup, /retained-upload\.bin/);
    // Neutral unavailable copy with the last successful observation time.
    assert.match(markup, /unavailable/i);
    assert.match(markup, /2026-07-31 10:00:05/);
  });

  it("still renders live transfers from a fresh response", () => {
    const markup = renderToStaticMarkup(
      <TransfersPanel
        status="ready"
        transfers={[RETAINED_TRANSFER]}
        lastSuccessAt={Date.now()}
      />,
    );
    assert.match(markup, /retained-upload\.bin/);
    assert.match(markup, /streaming → \.part/);
  });
});

describe("StatusRow under stale data", () => {
  it("drops green success/on cues when the row is not fresh and shows neutral unverified copy", () => {
    for (const state of ["ok", "on"] as const) {
      const markup = renderToStaticMarkup(
        <StatusRow
          name="Streamed I/O"
          detail="chunked upload/download"
          state={state}
          fresh={false}
        />,
      );
      assert.doesNotMatch(markup, /dot-success/);
      assert.doesNotMatch(markup, new RegExp(`>\\s*${state}\\s*<`));
      assert.match(markup, /unverified/i);
    }
  });

  it("keeps the green cue when fresh", () => {
    const markup = renderToStaticMarkup(
      <StatusRow
        name="Streamed I/O"
        detail="chunked upload/download"
        state="on"
        fresh
      />,
    );
    assert.match(markup, /dot-success/);
    assert.match(markup, /on/);
  });
});
