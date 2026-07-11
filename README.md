# fs file hosting

A small file-hosting service for humans, scripts, and agents. It consists of an
HTTP server backed by SQLite and filesystem object storage, plus the `fs` CLI.
Public files have short links; private files require the shared bearer token.

The production checkout lives at `~/hosting/file-hosting` and is released from
the Git commit currently checked out there.

## Layout and storage

- `server/` contains the HTTP server and browser preview.
- `cli/` contains the `fs` command-line client.
- `skills/fs/SKILL.md` teaches agents how to use the finished CLI.
- `runtime/files/` is bind-mounted at `/data/files` for uploaded objects and
  temporary upload parts.
- `runtime/sqlite/` is bind-mounted at `/data/sqlite` for `files.db` and its
  SQLite WAL/shared-memory files.
- SQLite stores file metadata, tags, visibility, hashes, and object locations;
  file bytes are not stored in the database.

Uploads and downloads are streamed. Incoming files are written to temporary
storage, hashed, and atomically moved into object storage only after a complete
upload.

## Configuration

Copy the example and replace `FS_TOKEN` with a long random secret:

```sh
cp .env.example .env
```

The server accepts the following environment variables:

| Variable | Default in Compose | Purpose |
| --- | --- | --- |
| `FS_TOKEN` | required | Shared bearer token for authenticated operations |
| `DATABASE_URL` | `file:/data/sqlite/files.db` | SQLite connection URL |
| `FS_STORAGE_DIR` | `/data/files` | Object-storage directory |
| `FS_PUBLIC_URL` | `https://files.moulik.dev` | Base URL placed in API responses |
| `FS_MAX_UPLOAD_BYTES` | `10737418240` | Server upload limit (10 GiB) |
| `FS_MIN_FREE_BYTES` | `1073741824` | Free space reserved before accepting an upload (1 GiB) |
| `FS_PORT` | `37641` | Loopback-only host port for local diagnostics |

The token is sent as `Authorization: Bearer <token>`. Do not put it in URLs,
commit it, or include it in logs.

## Run with Docker

```sh
install -d -m 700 -o 1001 -g 1001 runtime/files runtime/sqlite
chmod 600 .env
docker compose up --build -d
docker compose ps
docker compose exec -T server node -e \
  "fetch('http://127.0.0.1:3000/healthz').then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1) })"
```

Follow logs or stop the service with:

```sh
docker compose logs -f server
docker compose down
```

`docker compose down` preserves both bind-mounted runtime directories. The app
publishes container port 3000 only as loopback port 37641, leaving host port
3000 free. It also joins Nginx Proxy Manager's external `nginx-proxy_default`
network under the alias `file-hosting-server`, where NPM reaches the container
directly on port 3000.

## Local development and tests

Server development uses Node.js and npm:

```sh
cd server
npm install
cp .env.example .env
npm run dev
```

Run every automated check from the project root:

```sh
npm --prefix server run build
npm --prefix server run check
npm --prefix cli run typecheck
npm --prefix cli test
npm --prefix cli run build
node --test tests/e2e.test.mjs
```

The end-to-end suite starts real compiled server and CLI processes against
temporary SQLite and object storage, tests a restart, and removes its state.
See `tests/README.md` for details and `cli/README.md` for CLI installation and
usage.

## API overview

Authenticated API requests use the bearer token. Public preview and raw links
need no token; private entries require authentication and otherwise behave as
not found.

| Method and route | Purpose |
| --- | --- |
| `GET /healthz` | Health check |
| `POST /api/files` | Stream a new upload with metadata and tags |
| `GET /api/files` | List or search entries |
| `GET /api/files/{id}` | Read one entry's metadata |
| `PATCH /api/files/{id}` | Change tags or visibility |
| `DELETE /api/files/{id}` | Delete an entry and its stored object |
| `GET /{id}` | Browser metadata and safe preview page |
| `GET /raw/{id}` | Raw file bytes |

HTML and SVG content is shown as escaped source on the preview page rather than
executed. Other unsupported preview types are presented as downloads.

## CLI

The primary forms are:

```text
fs <path>          upload shorthand
fs up ...          explicit upload
fs down ...        download
fs list ...        list
fs find ...        search by name and/or tag
fs info ...        inspect metadata and URLs
fs tag ...         manage tags
fs visibility ...  change public/private visibility
fs rm ...          delete
```

The CLI supports shell globs and its own quoted glob expansion for uploads, with
`-r` required for directories (each directory becomes one `.tar.gz` object).
Machine use is supported through JSON, JSONL, ID-only, and NUL-delimited output;
data goes to stdout while progress and diagnostics go to stderr. See
`cli/README.md` and `fs --help` for the complete command contract.

## Production release

1. Push a tested commit to `main`.
2. In `~/hosting/file-hosting`, run `git pull --ff-only` and verify the desired
   commit with `git rev-parse HEAD`.
3. Run `docker compose up --build -d`, wait for the health check, and inspect
   `docker compose ps` plus `docker compose logs --tail=100 server`.
4. In Cloudflare DNS, keep `files.moulik.dev` as a DNS-only `A` record pointing
   to the host. DNS-only mode avoids Cloudflare proxy upload-size constraints
   for explicitly approved uploads over 1 GiB.
5. In Nginx Proxy Manager, proxy `files.moulik.dev` over HTTP to
   `file-hosting-server:3000`.
6. Add this in the Proxy Host's **Advanced** configuration so large requests
   stream to the application instead of being buffered:

   ```nginx
   client_max_body_size 0;
   proxy_request_buffering off;
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   send_timeout 3600s;
   ```

7. In NPM's SSL tab, request a Let's Encrypt certificate for
   `files.moulik.dev`, enable Force SSL, and accept the Let's Encrypt terms.
8. Verify the public health route, a small authenticated upload, preview and raw
   downloads, a private-file denial without authentication, and deletion before
   relying on the service.

DNS-only mode means traffic goes directly to Nginx Proxy Manager rather than
Cloudflare's proxy/CDN/WAF. TLS terminates at NPM. To roll back, check out the
previous known-good commit in the production checkout and rerun
`docker compose up --build -d`.
