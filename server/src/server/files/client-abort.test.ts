// Finding 7: a client abandoning its own upload (abort / ECONNRESET /
// premature close) is EXPECTED cancellation. It must never produce an
// error-level "Unhandled request error" log or a 500 — at most a structured
// info line — while genuinely unexpected errors keep the loud path.
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { errorResponse } from "./http";

function abortVariants(): Error[] {
  const reset = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  const premature = Object.assign(new Error("Premature close"), {
    code: "ERR_STREAM_PREMATURE_CLOSE",
  });
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  const undici = Object.assign(new Error("Request aborted"), {
    code: "UND_ERR_ABORTED",
  });
  return [reset, premature, abort, undici];
}

describe("client abort handling", () => {
  it("classifies aborts as expected cancellation: no error log, no 500", () => {
    for (const error of abortVariants()) {
      const errorLog = mock.method(console, "error", () => undefined);
      const infoLog = mock.method(console, "info", () => undefined);
      try {
        const response = errorResponse(error);
        assert.notEqual(
          response.status,
          500,
          `${error.message} must not be a 500`,
        );
        assert.equal(
          errorLog.mock.callCount(),
          0,
          `${error.message} must not log at error level`,
        );
        // Structured debug/info is allowed but not required.
        for (const call of infoLog.mock.calls) {
          assert.match(String(call.arguments[0]), /client_aborted/);
        }
      } finally {
        errorLog.mock.restore();
        infoLog.mock.restore();
      }
    }
  });

  it("keeps the loud path for genuinely unexpected errors", () => {
    const errorLog = mock.method(console, "error", () => undefined);
    try {
      const response = errorResponse(new Error("disk exploded"));
      assert.equal(response.status, 500);
      assert.equal(errorLog.mock.callCount(), 1);
    } finally {
      errorLog.mock.restore();
    }
  });
});
