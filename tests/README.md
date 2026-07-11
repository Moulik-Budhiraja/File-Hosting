# Black-box end-to-end tests

The end-to-end suite starts the compiled Next.js production server on an
ephemeral loopback port with a temporary SQLite database and object-storage
directory. It drives the compiled CLI as a separate process and removes all
test state afterward. It does not start Docker or touch any deployment system.

Build both applications, then run the suite from the repository root:

```sh
npm --prefix server run build
npm --prefix cli run build
node --test tests/e2e.test.mjs
```

The suite uses only Node.js built-ins. It intentionally exercises the real
`server/.next` application and `cli/dist/index.js`; missing build artifacts are
reported as test failures rather than replaced with development servers or
mocks.
