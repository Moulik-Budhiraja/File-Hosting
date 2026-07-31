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

Final full-suite commands and results are recorded in the pull request
validation section.
