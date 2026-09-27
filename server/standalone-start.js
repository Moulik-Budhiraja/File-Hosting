import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import next from "next";
import { canonicalPublicOrigin, DEFAULT_PUBLIC_ORIGIN } from "./public-url.js";

process.env.FS_PUBLIC_URL = canonicalPublicOrigin(
  process.env.FS_PUBLIC_URL ?? DEFAULT_PUBLIC_ORIGIN,
);
Object.assign(process.env, { NODE_ENV: "production" });
const dir = fileURLToPath(new URL(".", import.meta.url));
process.chdir(dir);

// Use the build's serialized configuration, as Next's generated server does.
// prepare-standalone explicitly packages this custom entrypoint; Next's tracer
// does not trace custom servers. Do not also launch the generated server.js.
const { config } = JSON.parse(
  await readFile(
    new URL("./.next/required-server-files.json", import.meta.url),
    "utf8",
  ),
);
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);

const port = parseInt(process.env.PORT ?? "", 10) || 3000;
const hostname = process.env.HOSTNAME || "0.0.0.0";
const server = createServer();
// Change only the total request receipt deadline. In particular, preserve the
// independently initialized headersTimeout and all socket/keep-alive defaults.
server.requestTimeout = 0;
const keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT ?? "", 10);
if (Number.isFinite(keepAliveTimeout) && keepAliveTimeout > 0) {
  server.keepAliveTimeout = keepAliveTimeout;
}

const app = next({ dev: false, dir, hostname, port, httpServer: server });
await app.prepare();
const handle = app.getRequestHandler();
server.on("request", async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    console.error(error);
    if (res.headersSent) {
      res.destroy();
    } else {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    // Stop accepting connections, then finish pending uploads before closing
    // Next. Compose's existing stop_grace_period remains the outer bound.
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve(undefined)));
    });
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
if (!process.env.NEXT_MANUAL_SIG_HANDLE) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
server.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
server.listen(port, hostname, () => {
  console.log(
    JSON.stringify({
      event: "http-listening",
      address: server.address(),
      requestTimeout: server.requestTimeout,
      headersTimeout: server.headersTimeout,
      timeout: server.timeout,
      keepAliveTimeout: server.keepAliveTimeout,
      keepAliveTimeoutBuffer: server.keepAliveTimeoutBuffer,
    }),
  );
});
