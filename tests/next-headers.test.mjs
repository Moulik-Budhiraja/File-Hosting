import assert from "node:assert/strict";
import test from "node:test";

const configUrl = new URL("../server/next.config.js", import.meta.url);

async function loadHeaderRules(publicUrl) {
  const previous = process.env.FS_PUBLIC_URL;
  if (publicUrl === undefined) {
    delete process.env.FS_PUBLIC_URL;
  } else {
    process.env.FS_PUBLIC_URL = publicUrl;
  }

  try {
    const { default: config } = await import(
      `${configUrl.href}?public-url=${encodeURIComponent(publicUrl ?? "unset")}-${crypto.randomUUID()}`
    );
    return config.headers();
  } finally {
    if (previous === undefined) {
      delete process.env.FS_PUBLIC_URL;
    } else {
      process.env.FS_PUBLIC_URL = previous;
    }
  }
}

function headersNamed(rules, name) {
  return rules.flatMap((rule) =>
    rule.headers.filter((header) => header.key.toLowerCase() === name),
  );
}

function hstsHeaders(rules) {
  return headersNamed(rules, "strict-transport-security");
}

function ruleFor(rules, source) {
  return rules.find((rule) => rule.source === source);
}

function headerValues(rule, name) {
  return (rule?.headers ?? [])
    .filter((header) => header.key.toLowerCase() === name)
    .map((header) => header.value);
}

test("HTTPS public URL applies one global one-year HSTS contract", async () => {
  const rules = await loadHeaderRules("HtTpS://FILES.Example.Test:443/");
  const hstsRules = rules.filter((rule) =>
    rule.headers.some(
      (header) => header.key.toLowerCase() === "strict-transport-security",
    ),
  );

  assert.equal(hstsRules.length, 1);
  assert.equal(hstsRules[0].source, "/:path*");
  assert.deepEqual(hstsHeaders(rules), [
    {
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    },
  ]);
});

test("Next build config rejects a non-origin public URL without reflecting secrets", async () => {
  for (const publicUrl of [
    "not an absolute URL",
    "ftp://files.example.test",
    "https://user:password@files.example.test",
    "https://files.example.test/path",
    "https://files.example.test/.",
    "https://files.example.test/%2e",
    "https://files.example.test/?secret=query-value",
    "https://files.example.test/#secret-fragment",
  ]) {
    await assert.rejects(
      loadHeaderRules(publicUrl),
      (error) =>
        error instanceof Error &&
        /FS_PUBLIC_URL must be a canonical HTTP or HTTPS origin/u.test(
          error.message,
        ) &&
        !error.message.includes(publicUrl) &&
        !error.message.includes("password") &&
        !error.message.includes("query-value") &&
        !error.message.includes("secret-fragment"),
      publicUrl,
    );
  }
});

test("HTTP and unset public URLs emit no HSTS header", async () => {
  for (const publicUrl of ["http://127.0.0.1:3000", undefined]) {
    const rules = await loadHeaderRules(publicUrl);
    assert.deepEqual(hstsHeaders(rules), [], publicUrl ?? "unset");
  }
});

test("every Next response receives one global nosniff rule", async () => {
  for (const publicUrl of [
    "https://files.example.test",
    "http://127.0.0.1:3000",
    undefined,
  ]) {
    const rules = await loadHeaderRules(publicUrl);
    const globalRule = ruleFor(rules, "/:path*");
    assert.deepEqual(
      headerValues(globalRule, "x-content-type-options"),
      ["nosniff"],
      publicUrl ?? "unset",
    );
  }
});

test("nested app fallbacks receive one complete framing-denial policy", async () => {
  const rules = await loadHeaderRules("https://files.example.test");
  const nestedAppRule = ruleFor(
    rules,
    "/(login|files|users|keys|account)/:path*",
  );

  assert.deepEqual(headerValues(nestedAppRule, "x-frame-options"), ["DENY"]);
  assert.equal(
    headerValues(nestedAppRule, "content-security-policy").length,
    1,
  );
  assert.match(
    headerValues(nestedAppRule, "content-security-policy")[0],
    /(?:^|; )frame-ancestors 'none'(?:;|$)/u,
  );
  assert.deepEqual(headerValues(nestedAppRule, "referrer-policy"), [
    "strict-origin-when-cross-origin",
  ]);
  assert.equal(headerValues(nestedAppRule, "permissions-policy").length, 1);

  const globalRule = ruleFor(rules, "/:path*");
  assert.deepEqual(headerValues(globalRule, "x-frame-options"), []);
  assert.deepEqual(headerValues(globalRule, "content-security-policy"), []);
  assert.equal(
    rules.some((rule) => rule.source.startsWith("/raw")),
    false,
  );
});
