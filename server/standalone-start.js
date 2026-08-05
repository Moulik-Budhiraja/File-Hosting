import { canonicalPublicOrigin, DEFAULT_PUBLIC_ORIGIN } from "./public-url.js";

process.env.FS_PUBLIC_URL = canonicalPublicOrigin(
  process.env.FS_PUBLIC_URL ?? DEFAULT_PUBLIC_ORIGIN,
);

const serverEntry = "./server.js";
await import(serverEntry);
