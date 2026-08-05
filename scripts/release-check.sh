#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export NEXT_TELEMETRY_DISABLED=1
export OG_DESIGN_REFERENCE_DIR="$PWD/server/test-fixtures/og-design-v2"
export OG_DESIGN_AUDIT_DIR="${OG_DESIGN_AUDIT_DIR:-${TMPDIR:-/tmp}/file-hosting-design-audit-release}"

npm --prefix server ci
npm --prefix server run format:check
npm --prefix server run lint
npm --prefix server run typecheck
npm --prefix server test
npm --prefix server run package:check
npm --prefix server run build
npm --prefix server run test:compiled
npm --prefix server run test:standalone
npm --prefix server run design:audit
npm --prefix server audit --omit=dev --audit-level=low
npm --prefix server audit --audit-level=low

npm --prefix cli ci
npm --prefix cli run typecheck
npm --prefix cli test
npm --prefix cli run build
npm --prefix cli audit --omit=dev --audit-level=low
npm --prefix cli audit --audit-level=low

node --test tests/e2e.test.mjs tests/compose.test.mjs tests/release-graph.test.mjs
node scripts/run-rich-link-probe.mjs
scripts/compose-runtime-check.sh
