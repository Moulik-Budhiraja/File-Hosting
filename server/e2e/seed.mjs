// Idempotent E2E fixture seeding through the real public API.
// Dev/test-only; the token is a fixture value, not a real credential.

export const SEEDED_OBJECT_COUNT = 21;

/**
 * @param {string} base
 * @param {string} token
 * @param {string} name
 * @param {import("node:buffer").Buffer | string} body
 * @param {{ tags?: string[]; visibility?: string; mime?: string }} [options]
 */
async function upload(base, token, name, body, options = {}) {
  const { tags = [], visibility = "public", mime } = options;
  const params = new URLSearchParams({ name });
  for (const tag of tags) params.append("tag", tag);
  if (visibility === "private") params.set("private", "true");
  const response = await fetch(`${base}/api/files?${params}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(mime ? { "content-type": mime } : {}),
    },
    body: /** @type {BodyInit} */ (body),
  });
  if (!response.ok) {
    throw new Error(`Seed upload failed for ${name}: ${response.status}`);
  }
  // Space creation timestamps so newest-first ordering is deterministic.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return response.json();
}

/**
 * @param {string} base
 * @param {string} token
 */
export async function ensureSeeded(base, token) {
  const systemResponse = await fetch(`${base}/api/system`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!systemResponse.ok) {
    throw new Error(`/api/system failed: ${systemResponse.status}`);
  }
  const system = await systemResponse.json();
  if (system.storage.object_count > 0) return;

  const parquetish = Buffer.alloc(4096, 7);
  for (let index = 1; index <= 14; index += 1) {
    await upload(
      base,
      token,
      `telemetry-batch-04${String(index).padStart(2, "0")}.parquet`,
      parquetish,
      {
        tags: ["ingest", "telemetry", "batch", "datasets"],
        visibility: "private",
        mime: "application/octet-stream",
      },
    );
  }
  await upload(
    base,
    token,
    "telemetry-schema-v4.json",
    JSON.stringify(
      {
        columns: [
          { name: "event_id", type: "int64" },
          { name: "device_id", type: "binary" },
          { name: "ts_utc", type: "timestamp" },
          { name: "battery_pct", type: "double" },
        ],
      },
      null,
      2,
    ),
    {
      tags: ["ingest", "telemetry", "schema", "datasets"],
      mime: "application/json",
    },
  );
  await upload(
    base,
    token,
    "telemetry-sampler-config.yaml",
    "sampler:\n  rate: 0.25\n  regions: [eu-west, us-east]\nretention: 180d\n",
    {
      tags: ["ingest", "telemetry", "config", "datasets"],
      visibility: "private",
      mime: "application/x-yaml",
    },
  );
  await upload(
    base,
    token,
    "onboarding-runbook.md",
    "# Onboarding runbook\n\n1. Request the shared token.\n2. `fs auth set`.\n3. Upload with `fs <path>`.\n",
    { tags: ["docs"], mime: "text/markdown" },
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  await upload(base, token, "og-image-launch.png", png, {
    tags: ["web"],
    mime: "image/png",
  });
  await upload(base, token, "press-kit-2026.zip", Buffer.alloc(2048, 3), {
    tags: ["web"],
    mime: "application/zip",
  });
  await upload(base, token, "victim-of-deletion.txt", "delete me in the E2E suite", {
    tags: ["tmp"],
    mime: "text/plain",
  });
  await upload(base, token, "api-reference-v3.pdf", Buffer.alloc(3172, 1), {
    tags: ["docs"],
    mime: "application/pdf",
  });
}
