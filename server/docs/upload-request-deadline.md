# Production upload request deadline

`npm start` and the container run the explicitly packaged `start.js`. It owns one Node HTTP server and sets `server.requestTimeout = 0` before listening. Node's header receipt timeout, socket timeout, keep-alive timeout, and connection-check interval keep their defaults. `KEEP_ALIVE_TIMEOUT` retains the generated Next entrypoint's positive-integer override behavior.

Next 15.5.22's generated standalone entrypoint calls `startServer`, which creates its own HTTP server. It exposes a keep-alive option but no request receipt timeout option. The replacement uses Next's public `next()`, `prepare()`, `getRequestHandler()`, and `close()` APIs so the application can configure its own HTTP server. It retains hostname, port, request handling, and graceful SIGINT/SIGTERM draining.

Next's standalone tracer does not trace custom entrypoints. This repository already copies `standalone-start.js` to `start.js` through `scripts/prepare-standalone.mjs`. The custom entrypoint reads the build's `.next/required-server-files.json` and sets the same `__NEXT_PRIVATE_STANDALONE_CONFIG` used by Next's generated `server.js`. It uses the traced runtime dependencies and assets; it does not execute the generated `server.js`. That serialized-config convention is a Next internal dependency. The packaged-entrypoint tests must pass when upgrading Next. No installed dependency is edited or globally patched by the application.

Run after `npm --prefix server run build`:

    node --test tests/upload-deadline.test.mjs tests/standalone-start.test.mjs

The tests observe the actual listening HTTP server in a child process. They compare its timeout values with the installed Node defaults, exercise paced authenticated uploads, verify private download bytes and deletion, check static assets and security headers, and finish an in-flight upload during SIGTERM. The observer is test-only and is never loaded by the production command. For the fast paced-upload regression it shortens a nonzero request timeout and the header/check intervals in the test child. A zero request timeout stays zero. Node swaps nonzero header/request timeout values if the header timeout is larger, so the test scales both.

Production verification must also send continuous private synthetic bytes for more than 330 seconds through the public HTTPS endpoint, wait for HTTP 201, download and compare the bytes, then delete the exact returned ID and verify 404. A connection that merely remains open is insufficient.

Nginx's 60-second client-body inactivity limit is unchanged. Its one-hour upstream read/send and client-send inactivity limits, authentication, upload size limit, storage reserve, and login throttling are unchanged. This change removes only Node's total request receipt deadline. It does not promise uploads will survive inactivity, network failures, or deployments.

References:

- https://nextjs.org/docs/app/guides/custom-server
- https://nodejs.org/docs/latest-v22.x/api/http.html#serverrequesttimeout
- https://github.com/nodejs/node/blob/v22.23.2/src/node_http_parser.cc
