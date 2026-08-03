/** @type {import("next").NextConfig} */
const config = {
  output: "standalone",
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  outputFileTracingIncludes: {
    "/*": [
      "./runtime/**/*",
      "./node_modules/@twemoji/svg/*.svg",
      "./node_modules/@twemoji/svg/package.json",
      "./node_modules/@twemoji/svg/LICENSE*",
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
};

export default config;
