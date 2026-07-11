# File hosting server

Next.js/Node 22 server for the `fs` CLI. SQLite stores metadata; uploaded bytes live in a separate persistent directory.

## Local development

Copy `.env.example` to `.env`, replace `FS_TOKEN`, then run:

```sh
npm install
npm run dev
```

The required production environment is documented in `.env.example`. `FS_MAX_UPLOAD_BYTES=0` disables the application upload-size limit. Reverse proxies may still apply their own limit.

## HTTP API

All `/api/*` routes require `Authorization: Bearer $FS_TOKEN`.

- `POST /api/files?name=...&tag=...&private=false&archive=tar.gz` accepts raw request bytes.
- `GET /api/files` accepts `q`, `name` (SQLite glob), repeated `tag` filters (AND), `visibility`, `limit`, and `cursor`.
- `GET /api/files/{id}` returns metadata.
- `PATCH /api/files/{id}` updates visibility and/or tags.
- `DELETE /api/files/{id}` removes the entry and stored bytes.
- `GET|HEAD /raw/{id}` streams bytes and supports one `Range` header.
- `GET /{id}` returns a small preview page.
- `GET /healthz` checks SQLite and writable storage.

PATCH bodies use:

```json
{
  "visibility": "private",
  "tags": { "operation": "add", "values": ["example"] }
}
```

Public entries need no token for raw or preview routes. Private entries require the bearer token and otherwise return the same `404` response as missing entries. HTML and SVG previews show escaped source; direct raw responses carry a sandboxing CSP. Responses use `Cache-Control: no-store` so a public-to-private visibility change takes effect immediately.

## Verification

```sh
npm run check
npm run build
docker build -t file-hosting-server .
```

The Docker image runs the standalone Next.js server as UID/GID `1001:1001` on
port 3000. Mount separate writable directories at `/data/sqlite` and
`/data/files`, then use `DATABASE_URL=file:/data/sqlite/files.db` plus
`FS_STORAGE_DIR=/data/files`. Mount the SQLite directory rather than only the
database file so its WAL and shared-memory files persist beside it.
