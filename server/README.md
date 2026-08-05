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

- `POST /api/auth/login` creates an opaque server-side session bounded by 12
  hours idle and a fixed seven-day maximum. HTTPS deployments set `__Host-fs_session` with `Secure`; HTTP development/CI uses
  `fs_session`. Both are `HttpOnly`, `SameSite=Strict`, and `Path=/`. Every
  set/read/rotate/clear path derives the same canonical name from
  `FS_PUBLIC_URL`; duplicate values or a request containing both names fail
  closed.
- `POST /api/auth/logout` revokes the session immediately.
- `GET /api/auth/me` returns the current user or legacy-credential status.
- Cookie-authenticated mutations require an `Origin` equal to the configured
  public origin. Bearer requests are not cookie-CSRF-sensitive.
- Missing users and incorrect passwords return the same response. A disabled
  account or expired temporary password is disclosed only after the submitted
  password verifies for that account.
- Five failures per normalized username in 15 minutes cause a temporary `429`.
  Address-wide pre-bcrypt throttling (10 attempts per 15 minutes) is enabled
  only by the complete trusted-ingress contract below. Without valid ingress
  proof, login degrades truthfully to identity-only bucketing.
- Passwords use bcrypt with a random salt and cost 12. Every password entry path
  enforces a 12-character minimum and bcrypt's 72-byte UTF-8 maximum. Raw
  passwords are never stored or intentionally logged.
- Sessions are random 256-bit values stored only as SHA-256 digests with expiry
  and revocation. Disabled users fail every session/API-key lookup immediately.

### Trusted ingress for address-wide login throttling

Set all three variables or none:

- `FS_TRUSTED_INGRESS_IP_HEADER` — a dedicated header containing exactly one
  IPv4 or IPv6 address.
- `FS_TRUSTED_INGRESS_SECRET_HEADER` — a separate dedicated proof header.
- `FS_TRUSTED_INGRESS_SECRET` — a random shared secret of at least 32 bytes,
  distinct from `FS_TOKEN` and never logged or sent to clients.

The server verifies the proof in constant time before accepting the address.
Missing/incorrect proof, duplicate/comma-joined values, and malformed addresses
are ignored and receive identity-only throttling; ordinary `Forwarded`,
`X-Forwarded-For`, and `X-Real-IP` headers are never trusted automatically.

This mode is secure only when the application has no direct network path from
clients: expose it solely to the configured reverse proxy, and make that proxy
strip any incoming copies and set (replace, never append) both configured
headers on every request. Restrict the application port with loopback,
firewall, or a private network. A deployment that allows direct access to the
application port lets a client present the shared proof if it is ever leaked
and does not satisfy this trust contract.

### HTTPS transport ownership

The application owns HSTS. When `FS_PUBLIC_URL` uses `https:`, the production
build emits `Strict-Transport-Security: max-age=31536000; includeSubDomains` on
every app, API, file, asset, health, and 404 response through one global Next.js
header rule. HTTP development builds and builds without `FS_PUBLIC_URL` emit no
HSTS header. Because Next.js compiles header rules at build time, build and run
the image with the same `FS_PUBLIC_URL`; Compose passes the same value to both.
Rebuild when changing its scheme.

The reverse proxy still must redirect every plaintext HTTP request to the
canonical HTTPS URL before application content or credentials are served. It
must preserve the application's HSTS value unchanged, or deliberately replace
it with the exact same value; it must not strip it, append a second value, or
emit HSTS for an HTTP-only deployment. `includeSubDomains` is appropriate only
when every subdomain is HTTPS-capable. This project does not request `preload`:
preload is intentionally omitted until the domain owner separately verifies
all current and future subdomains, accepts the long-lived removal process, and
explicitly opts in.

Roles are only `admin` and `member`. Admins manage users and all files. Members
manage only files they own. The final active admin cannot be disabled or
demoted; the guard is an atomic conditional SQLite update.

## User and API-key endpoints

All routes below require a user session, user API key, or the legacy service
credential. Admin-only routes return `403` to authenticated members.

- `GET|POST /api/users` — admin list/create (`username`, `password`, `role`).
  Create accepts an optional opaque `request_id` (1–128 chars): creation is
  then idempotent per actor+id — the first commit returns
  `201 { user, created: true }` and a retry with the same id and candidate
  returns `200 { user, created: false }` for the same user, so a client that
  lost the response can reconcile without duplicates. If that credential has
  since been replaced, reconciliation fails with `409 credential_superseded`
  rather than presenting a stale candidate. Only the bcrypt hash is ever
  stored; reconciliation metadata is pruned after 24 hours.
- `PATCH /api/users/{id}` — exactly one of role, active state, or replacement
  password per request. A password reset may carry `request_id` (only together with
  `password`): the reset applies exactly once per actor+id
  (`password_applied: true`, sessions revoked); a replay returns
  `password_applied: false` only while that candidate is still current. The
  target is bound to the request id, overlapping different reset ids use a
  password-hash conditional update (one wins; the stale write gets
  `409 password_reset_conflict`), and a superseded replay gets
  `409 credential_superseded`. Callers without `request_id` are unchanged.
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
  (AND), `visibility`, `owner=me`, `limit`, and `cursor`.
- `GET /api/files/{id}` returns metadata.
- `PATCH /api/files/{id}` updates visibility, tags, and/or `owner_id` (admin
  only).
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
