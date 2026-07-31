# Representative TDD evidence

The implementation was developed in focused RED → GREEN slices. Representative
cycles observed in this worktree:

1. Password hashing and policy
   - RED: `npx tsx --test src/server/auth/auth.test.ts` failed with
     `ERR_MODULE_NOT_FOUND` for `auth/password`.
   - GREEN: the same test passed after bcrypt cost-12 hashing, normalization, and
     password validation were implemented.
2. User repository and first-admin safety
   - RED: the focused repository test failed because `bootstrapAdmin` did not
     exist.
   - GREEN: it passed after an atomic empty-database bootstrap was added.
3. Concurrent last-admin protection
   - RED: the concurrency assertion reported two successful disables (`2 !== 1`).
   - GREEN: it passed after replacing check-then-update logic with one atomic
     conditional SQLite update.
4. Legacy migration and SQL access filtering
   - RED: the migration test observed `ownerId` as `undefined` instead of `null`.
   - GREEN: it passed after the transactional table rebuild and pre-pagination
     access predicate were implemented.
5. File RBAC/IDOR
   - RED: a member API-key upload returned `401` instead of `201`.
   - GREEN: it passed after bearer/session resolution and centralized
     read/manage authorization were wired into file routes.
6. CLI compatibility
   - RED: `fs visibility <id> protected` returned exit code 2.
   - GREEN: the focused CLI test passed after extending only visibility types and
     validation to accept `protected`.
7. Standalone bootstrap database directory
   - RED: `npx tsx --test --test-name-pattern='creates missing parent directories'
src/server/auth/auth.test.ts` failed with SQLite error 14 because the nested
     parent directory did not exist.
   - GREEN: the same focused test passed after both repositories shared local
     `file:` database-directory preparation.
8. HTTP canonical public URL cookie security
   - RED: `npx tsx --test --test-name-pattern='does not mark an HTTP public URL'
src/server/auth/http.test.ts` found `Secure` on the production-mode HTTP
     session cookie.
   - GREEN: the same focused test passed after cookie security was derived only
     from the validated configured public URL scheme; the existing HTTPS test
     continues to require `Secure`.
9. Bcrypt UTF-8 input boundary
   - RED: `npx tsx --test --test-name-pattern="rejects passwords beyond bcrypt's"
src/server/auth/auth.test.ts` reported a missing rejection for 73-byte input.
   - GREEN: the same focused test passed with exact 72-byte ASCII and multibyte
     boundaries accepted, 73-byte forms rejected, and verification routed through
     the central validator to prevent bcrypt truncation-equivalent credentials.

10. Expired login-throttle retention
    - RED: `npx tsx --test --test-name-pattern='purges expired login throttle records'
src/server/auth/auth.test.ts` observed two retained rows instead of one (`2 !== 1`).
    - GREEN: the same focused test passed after authentication attempts removed
      expired windows through an indexed timestamp cleanup before recording the
      current failure.

11. Password-reset/login session race
    - RED: the focused `does not issue a password session` test reached SQLite with
      a stale authentication result instead of rejecting it as changed credentials.
    - GREEN: password authentication now carries the verified hash into a
      conditional session insert, so a reset either prevents issuance or revokes a
      session inserted first.
12. Administrator-reset/self-service race
    - RED: the focused `does not overwrite an administrator reset` test reported
      a missing rejection from the in-flight self-service change.
    - GREEN: self-service updates now condition their transactional password update
      on the exact hash they verified, preserving a concurrent administrator reset.
13. Concurrent login throttling
    - RED: the focused `atomically limits concurrent password attempts` test let all
      10 requests reach invalid-credential handling (`10 !== 5`).
    - GREEN: an atomic pre-bcrypt reservation now admits five attempts and rejects
      the other five before expensive password verification.
14. Session retention
    - RED: the focused `purges expired and revoked sessions` test retained three
      rows instead of only the newly active session (`3 !== 1`).
    - GREEN: indexed cleanup before session creation now removes expired and revoked
      rows.

15. API-key owner validation
    - RED: the focused missing-owner HTTP test received 500 and logged a
      `SQLITE_CONSTRAINT_FOREIGNKEY` error instead of returning 404.
    - GREEN: API-key creation now validates the owner centrally and returns
      `user_not_found` before insertion.
16. Malformed session cookies
    - RED: the focused malformed-cookie test threw `URIError: URI malformed`.
    - GREEN: cookie decoding now treats malformed percent encoding as an absent,
      unauthenticated cookie.
17. Protected CLI filtering
    - RED: the focused `list supports protected-only visibility filtering` test
      exited with usage code 2 because `--protected` was unknown.
    - GREEN: list/find now expose `--protected`, send `visibility=protected`, and
      reject every conflicting visibility-flag combination.

18. Compose bootstrap forwarding
    - RED: `node --test tests/compose.test.mjs` could not find either bootstrap
      variable in the service environment.
    - GREEN: Compose now forwards both optional values from repository `.env`, the
      example documents their one-time use, and the focused test passes. Local
      `docker compose config --quiet` validation was unavailable because Docker is
      not installed in this runner.

Final full-suite commands and results are recorded in the pull request
validation section.
