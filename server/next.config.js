// App-shell defensive headers. The file-serving routes (/{id} preview,
// /raw/{id}) set their own stricter route-specific policies in their
// handlers and are deliberately NOT matched here — a global frame-ancestors
// would break the preview iframe that embeds /raw/{id}.
const appSecurityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js injects inline bootstrap scripts; without a nonce pipeline
      // 'unsafe-inline' keeps the app functional while still pinning
      // sources to self.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

const apiSecurityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "default-src 'none'; frame-ancestors 'none'",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

/** @type {import("next").NextConfig} */
const config = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/", headers: appSecurityHeaders },
      {
        source: "/(login|files|users|keys|account)",
        headers: appSecurityHeaders,
      },
      { source: "/api/:path*", headers: apiSecurityHeaders },
      { source: "/healthz", headers: apiSecurityHeaders },
      {
        source: "/_next/:path*",
        headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
      },
    ];
  },
};

export default config;
