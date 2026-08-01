# PR #8 final audit follow-up repair

## Scope

- Previous repair commit: `10ce8e608af8011275b378f9d2c92335d5ea656b`
- Stack base: `165fee3434c0af05ac3768a4c31ec0aa804bd2d7`
- Fresh Sol audit at the previous repair commit: PASS, 0 P0/P1/P2/P3
- Fresh Fable audit at the previous repair commit: FAIL, 0 P0/P1/P2 and 4 P3
- Backend PR #7 live state during repair: merged

The Fable report was treated as a finding inventory. The enclosing Hermes session independently reproduced all four findings before changing production code.

## Finding repairs

### 1. Unstructured gateway failures after an origin commit

`ApiError` now records whether the response contained the backend's structured error envelope. A structured JSON origin 500 remains a known server failure and retains safe retry behavior. An unstructured delivered 5xx is conservative because a reverse proxy can replace the origin response after the password transaction commits; it now enters the same unknown-outcome recovery path as lost delivery, clears submitted credentials, and focuses the sign-in recovery link.

Production coverage forwards a real password request, observes origin 204, substitutes an HTML 502, and proves the replacement password works, the old password fails, the prior session is revoked, the UI does not claim `Password not changed`, credentials are cleared, and the sign-in link is focused.

### 2. Stale PR #7 rollout copy

PR #7 is merged. The `PROPOSED · BACKEND IN PR #7` label, component, imports, usage sites, and dead styles were removed from login and authenticated console surfaces. Unit coverage asserts that neither surface continues to advertise the backend as unmerged.

### 3. Stale password field judgments

Editing the current-password value clears a prior `invalid_credentials` field judgment, including its message, `aria-invalid`, and `aria-describedby`. Editing either member of the new-password/confirmation pair clears a prior mismatch judgment. Focused component and real-production browser coverage exercise both correction paths.

### 4. Binary redirect sanitizer source

Literal NUL and other control bytes in `next-path.ts` and its hostile fixture were replaced with visible `\u0000-\u001f` and `\u007f` source escapes. Runtime sanitizer behavior remains unchanged. A source-integrity test reads both files as bytes and fails if a literal NUL returns; normal Git diff/stat/search now treats them as text.

## Strict RED/GREEN evidence

Focused RED before production repair:

```text
4 test files
61 tests
55 passed
6 failed
```

The six failures independently demonstrated:

1. stale current-password rejection after edit;
2. stale confirmation mismatch after new-password edit;
3. HTML 502 falsely rendered as `Password not changed`;
4. console rollout label still present;
5. login rollout label still present;
6. literal NUL bytes still present.

Focused GREEN after production repair:

```text
4 test files passed
61/61 tests passed
```

Focused production Playwright after a clean standalone build:

```text
password-ambiguous.spec.ts: 5/5 passed
```

## Complete post-repair gates

| Gate                                      |                                                  Result |
| ----------------------------------------- | ------------------------------------------------------: |
| Backend                                   |                                                   74/74 |
| Warning-clean UI                          |                                                 202/202 |
| Production Playwright, port 4381          |                                                   64/64 |
| Production Playwright, port 4382          |                                                   64/64 |
| CLI                                       |                                                   52/52 |
| Root E2E                                  |                                                   17/17 |
| Compose static                            |                                                     1/1 |
| Non-overlapping authoritative total       |                                                 410/410 |
| Focused production password flows         |                                                     5/5 |
| Format, lint, typecheck                   |                                                  passed |
| Clean standalone build                    | passed; 9/9 static pages and standalone assets prepared |
| CLI clean build                           |                                                  passed |
| Server production dependency audit        |                                       0 vulnerabilities |
| CLI full and production dependency audits |                                       0 vulnerabilities |

The second complete 64/64 browser run and focused 5/5 run are stability evidence and are not double-counted in 410/410.

## Disclosure and limitations

The full server dependency audit retains one high-severity development-only `brace-expansion` advisory through lint/parser tooling; production dependencies are clean. GitGuardian's two historical synthetic password-policy fixtures may remain red; no incident was dismissed and history was not rewritten. Docker, native Windows High Contrast, `gitleaks`, `trufflehog`, and `semgrep` are unavailable on this host; standalone production, Chromium forced-colors, dependency, full-diff, tracked-content, secret-pattern, control-byte, and artifact scans are used and disclosed instead.

Fresh immutable Sol and Fable audits must run at the exact published follow-up commit before final PASS can be claimed.
