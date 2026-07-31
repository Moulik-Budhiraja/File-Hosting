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

Final full-suite commands and results are recorded in the pull request
validation section.
