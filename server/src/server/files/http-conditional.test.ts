import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluatePreconditions } from "./http-conditional";

const etag = '"sha256-current"';
const modified = new Date("2026-08-08T09:00:00.999Z");

function evaluate(headers: HeadersInit, method = "GET") {
  return evaluatePreconditions(
    new Request("https://files.example.test/raw/1234567/small", {
      method,
      headers,
    }),
    etag,
    modified,
  );
}

describe("stored derivative HTTP preconditions", () => {
  it("fails stale If-Unmodified-Since before Range for GET and HEAD", () => {
    for (const method of ["GET", "HEAD"]) {
      assert.deepEqual(
        evaluate(
          {
            "if-unmodified-since": "Wed, 01 Jan 2020 00:00:00 GMT",
            range: "bytes=0-9",
          },
          method,
        ),
        { status: 412, allowRange: false },
      );
    }
  });

  it("honors RFC validator precedence and ignores invalid dates", () => {
    assert.deepEqual(
      evaluate({
        "if-match": etag,
        "if-unmodified-since": "Wed, 01 Jan 2020 00:00:00 GMT",
      }),
      { allowRange: true },
      "If-Match suppresses If-Unmodified-Since",
    );
    assert.deepEqual(
      evaluate({
        "if-none-match": '"different"',
        "if-modified-since": "Wed, 31 Dec 2099 23:59:59 GMT",
      }),
      { allowRange: true },
      "If-None-Match suppresses If-Modified-Since",
    );
    assert.deepEqual(
      evaluate({
        "if-none-match": "",
        "if-modified-since": "Wed, 31 Dec 2099 23:59:59 GMT",
      }),
      { allowRange: true },
      "If-None-Match presence suppresses If-Modified-Since",
    );
    assert.deepEqual(
      evaluate({ "if-unmodified-since": "not-a-date", range: "bytes=0-9" }),
      { allowRange: true },
    );
    assert.deepEqual(
      evaluate({ "if-unmodified-since": modified.toUTCString() }),
      { allowRange: true },
      "HTTP dates compare at whole-second precision",
    );
  });
});
