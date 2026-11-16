#!/usr/bin/env bash
# Load test with 50,000 emails: the same path as the
# E2E suite (scripts/e2e.sh builds web app and binary and sets up Stalwart),
# but with playwright.load.config.ts, i.e. only e2e/load-test.load.ts.
# The test fills Stalwart with scripts/load-test-seed.mjs and writes the
# measurements to apps/web/test-results/load-test/measurements.json.
# The backend part (sessions, token broker, SQLite) runs separately:
# `cargo test -p roedy-mail-server --release --test load -- --ignored --nocapture`.
#
#   scripts/load-test.sh [--no-build] [arguments for playwright test …]
#
# LOAD_TEST_MAILS (default 50000) and LOAD_TEST_ACCOUNTS (additional accounts for
# the recipient suggestions, default 4) shrink the run. Preparation as for
# scripts/e2e.sh.
#
# The binary comes as a release build (E2E_PROFILE, default here release),
# because the run also measures its memory; with
# --no-build the build of the last scripts/e2e.sh run applies, even a debug build.
# LOAD_TEST_LIGHTHOUSE=<path to lighthouse/core/index.js> additionally measures
# the mailbox with Lighthouse; Lighthouse lives outside the repo for this, e.g.
#   npm install --prefix "$TMPDIR/roedy-mail-dev/lighthouse" lighthouse@13
# With --no-build apps/web/build must match the binary.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export E2E_PROFILE="${E2E_PROFILE:-release}"
build=()
if [ "${1:-}" = --no-build ]; then
  build=(--no-build)
  shift
fi
exec scripts/e2e.sh "${build[@]}" -c playwright.load.config.ts "$@"
