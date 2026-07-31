// The admin console holds the shared bearer token in page memory and exposes
// destructive actions, so admin responses carry frame protections and a
// restrictive CSP. The built Next.js runtime injects inline bootstrap
// scripts/styles, so script-src/style-src allow 'unsafe-inline'; everything
// else is locked down. Raw object responses set their own sandboxing CSP in
// the route handler, so the full admin CSP is scoped to /admin.
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const FRAME_PROTECTION_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

/** @type {import("next").NextConfig} */
const config = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/admin",
        headers: [
          ...FRAME_PROTECTION_HEADERS,
          { key: "Content-Security-Policy", value: ADMIN_CSP },
        ],
      },
      {
        source: "/admin/:path*",
        headers: [
          ...FRAME_PROTECTION_HEADERS,
          { key: "Content-Security-Policy", value: ADMIN_CSP },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          ...FRAME_PROTECTION_HEADERS,
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default config;
