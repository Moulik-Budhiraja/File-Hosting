import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const readme = readFileSync("README.md", "utf8").replace(/\s+/gu, " ");

describe("documented API contract", () => {
  it("documents the user PATCH exactly-one mutation invariant", () => {
    expect(readme).toMatch(
      /PATCH \/api\/users\/\{id\}.*exactly one of role, active state, or replacement password per request/iu,
    );
    expect(readme).not.toMatch(
      /PATCH \/api\/users\/\{id\}.*role, active state, and\/or replacement password/iu,
    );
  });

  it("documents every supported file list and PATCH field", () => {
    expect(readme).toMatch(/GET \/api\/files.*owner=me/iu);
    expect(readme).toMatch(
      /PATCH \/api\/files\/\{id\}.*visibility.*tags.*owner_id/iu,
    );
    expect(readme).toMatch(/owner_id.*admin/iu);
  });
});
