# File hosting server

Next.js/Node 22 backend for the `fs` CLI. SQLite stores file metadata, users,
sessions, and API-key metadata; object bytes remain in the configured storage
directory.

## Local development

Copy `.env.example` to `.env`, replace `FS_TOKEN`, then run:

```sh
npm ci
npm run dev
```

`FS_TOKEN` remains a backward-compatible admin-equivalent service credential.
It is intentionally supported by the existing `Authorization: Bearer` flow, but
new automation should use per-user API keys so credentials can be attributed and
revoked individually.

## Bootstrap the first administrator

No username or password is committed or generated into logs. For a local or
maintenance-shell bootstrap:

```sh
FS_BOOTSTRAP_USERNAME=admin \
FS_BOOTSTRAP_PASSWORD='use-a-unique-password-manager-value' \
DATABASE_URL=file:./data/files.db \
npm run bootstrap:admin
```

For a container's first start, set `FS_BOOTSTRAP_USERNAME` and
`FS_BOOTSTRAP_PASSWORD` together. The server atomically creates an admin only
when the users table is empty. Remove both variables immediately after the first
successful start; leaving them configured makes a later start fail closed once
users exist. Passwords must be at least 12 characters and at most 72 UTF-8 bytes,
matching bcrypt's input limit.

## Authentication and authorization

- `POST /api/auth/login` creates a seven-day opaque server-side session and sets
  `fs_session` as `HttpOnly`, `SameSite=Strict`, and `Secure` when
  `FS_PUBLIC_URL` uses HTTPS.
- `POST /api/auth/logout` revokes the session immediately.
- `GET /api/auth/me` returns the current user or legacy-credential status.
- Cookie-authenticated mutations require an `Origin` equal to the configured
  public origin. Bearer requests are not cookie-CSRF-sensitive.
- Login errors do not distinguish missing, disabled, or wrong-password users.
  Five failures per normalized username and client address in 15 minutes cause
  a temporary `429`. Configure the reverse proxy to replace, not append
  untrusted, `X-Real-IP`/`X-Forwarded-For` values.
- Passwords use bcrypt with a random salt and cost 12. Every password entry path
  enforces a 12-character minimum and bcrypt's 72-byte UTF-8 maximum. Raw
  passwords are never stored or intentionally logged.
- Sessions are random 256-bit values stored only as SHA-256 digests with expiry
  and revocation. Disabled users fail every session/API-key lookup immediately.

Roles are only `admin` and `member`. Admins manage users and all files. Members
manage only files they own. The final active admin cannot be disabled or
demoted; the guard is an atomic conditional SQLite update.

## User and API-key endpoints

All routes below require a user session, user API key, or the legacy service
credential. Admin-only routes return `403` to authenticated members.

- `GET|POST /api/users` — admin list/create (`username`, `password`, `role`).
- `PATCH /api/users/{id}` — admin role, active state, and/or replacement password.
- `POST /api/auth/password` — member changes their own password using
  `current_password` and `new_password`; existing sessions are revoked.
- `GET|POST /api/api-keys` — list metadata or create a named key. Admins may pass
  `user_id`; members are restricted to themselves.
- `DELETE /api/api-keys/{id}` — owner or admin revocation.

API keys contain 256 bits of CSPRNG entropy and begin with `fsk_`. Creation
returns the full secret exactly once. SQLite stores only a deterministic SHA-256
digest plus ID, owner, name, prefix, last four characters, creation, last-use,
and revocation metadata. Slow password hashing is unnecessary for uniformly
random 256-bit keys: offline brute force is infeasible, while a deterministic
digest permits indexed lookup. List endpoints never return the secret.

## File API and visibility

`Authorization: Bearer` accepts either a per-user `fsk_...` key or the legacy
`FS_TOKEN`.

- `POST /api/files?name=...&tag=...&visibility=public|protected|private&archive=tar.gz`
  accepts raw bytes. The legacy `private=true` query remains compatible.
- `GET /api/files` accepts `q`, `name` (SQLite glob), repeated `tag` filters
  (AND), `visibility`, `limit`, and `cursor`.
- `GET /api/files/{id}` returns metadata.
- `PATCH /api/files/{id}` updates visibility and/or tags.
- `DELETE /api/files/{id}` removes metadata and bytes.
- `GET|HEAD /raw/{id}` streams bytes and supports one byte range.
- `GET /{id}` renders the preview.
- `GET /healthz` checks SQLite and writable storage.

Visibility:

- `public`: readable without authentication.
- `protected`: readable by any active authenticated user or valid API key.
- `private`: readable only by the owning user and admins.

Unauthorized direct reads and mutations use the same `404` envelope as a missing
file. List/search access predicates are part of the SQL query before ordering,
limit, cursor generation, or tag loading, so inaccessible rows cannot affect
pages or cursors.

## Migration

Startup detects the legacy `files` table transactionally, rebuilds its visibility
constraint to include `protected`, and adds nullable `owner_id` with indexes and
a user foreign key. Existing bytes, IDs, metadata, and tags are copied unchanged.
Legacy public rows stay public. Legacy private rows have no guessed owner and are
therefore admin-only. New uploads record the user ID from a session or API key;
legacy service uploads remain ownerless/admin-managed.

Back up the SQLite database and its `-wal`/`-shm` companions before upgrading.
The migration fixture test exercises the old schema and verifies public/private
semantics, tags, row identity, and insertion of the new visibility.

## Verification

```sh
npm run check
npm run format:check
npm run build
```

The production image runs as UID/GID `1001:1001`. Mount separate writable
SQLite and object directories. Mount the SQLite directory, not only the database
file, so WAL and shared-memory files persist beside it.
