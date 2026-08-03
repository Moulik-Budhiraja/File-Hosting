/** @type {import("next").NextConfig} */
const config = {
  output: "standalone",
  outputFileTracingIncludes: {
    "/*": [
      "./runtime/**/*",
      "./node_modules/ffmpeg-static/**/*",
      "./node_modules/ffprobe-static/**/*",
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
