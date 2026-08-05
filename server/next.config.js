import { canonicalPublicOrigin, DEFAULT_PUBLIC_ORIGIN } from "./public-url.js";

const publicUrl = canonicalPublicOrigin(
  process.env.FS_PUBLIC_URL ?? DEFAULT_PUBLIC_ORIGIN,
);
const usesHttps = new URL(publicUrl).protocol === "https:";
const transportSecurityHeaders = usesHttps
  ? [
      {
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      },
    ]
  : [];

const globalSecurityHeaders = [
  ...transportSecurityHeaders,
  { key: "X-Content-Type-Options", value: "nosniff" },
];

// App-shell defensive headers. File-serving routes set stricter route-specific policies.
const appSecurityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
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
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

/** @type {import("next").NextConfig} */
const config = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  outputFileTracingIncludes: {
    "/*": [
      "./runtime/**/*",
      "./node_modules/@twemoji/svg/*.svg",
      "./node_modules/@twemoji/svg/package.json",
      "./node_modules/@twemoji/svg/{license*,readme.md}",
      "./node_modules/ffmpeg-static/**/*",
      "./node_modules/ffprobe-static/index.js",
      "./node_modules/ffprobe-static/package.json",
      "./node_modules/ffprobe-static/LICENSE",
      `./node_modules/ffprobe-static/bin/${process.platform}/${process.arch}/ffprobe*`,
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/@napi-rs/**/*",
      "./node_modules/@libsql/**/*",
      "./node_modules/libsql/**/*",
      "./node_modules/sharp/**/*",
      "./node_modules/@img/**/*",
      "./node_modules/yauzl/**/*",
      "./node_modules/fd-slicer/**/*",
      "./node_modules/pend/**/*",
      "./node_modules/buffer-crc32/**/*",
    ],
  },
  outputFileTracingExcludes: {
    "next-server": ["**/node_modules/typescript/**/*"],
    "/*": ["**/node_modules/typescript/**/*"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: globalSecurityHeaders },
      { source: "/", headers: appSecurityHeaders },
      {
        source: "/(login|files|users|keys|account)",
        headers: appSecurityHeaders,
      },
      {
        source: "/(login|files|users|keys|account)/:path*",
        headers: appSecurityHeaders,
      },
      { source: "/api/:path*", headers: apiSecurityHeaders },
      { source: "/healthz", headers: apiSecurityHeaders },
    ];
  },
};

export default config;
