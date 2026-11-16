#!/usr/bin/env bash
# E2E suite: builds the web app and the binary with the embedded web app and
# runs the Playwright suite from apps/web/e2e against a freshly set up
# Stalwart v1 (scripts/dev/stalwart.sh run). The same path locally and in CI.
#
#   scripts/e2e.sh [--no-build] [arguments for playwright test …]
#
# Once beforehand: scripts/dev/stalwart.sh install and the browsers
# (`pnpm --filter @roedy/web exec playwright install chromium-headless-shell`,
# or scripts/dev/browser.sh install, whose browsers under
# $TMPDIR/roedy-mail-dev/ms-playwright are found as well).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Own copy of the binary: `cargo test` (also in the pre-push hook) rebuilds
# target/debug/roedy-mail without embed-web; --no-build would otherwise take a
# binary without the web app.
export ROEDY_E2E_BIN="$REPO/target/e2e/roedy-mail"
# E2E_PROFILE=release builds the binary optimized as in the image (that is how
# the load test measures memory); the default is the faster debug build.
profile=${E2E_PROFILE:-dev}

if [ "${1:-}" = --no-build ]; then
  shift
else
  pnpm --filter @roedy/web build
  cargo build -p roedy-mail-server --locked --features embed-web --profile "$profile"
  if [ "$profile" = dev ]; then out=debug; else out=$profile; fi
  install -D -m 0755 "target/$out/roedy-mail" "$ROEDY_E2E_BIN"
fi

[ -x "$ROEDY_E2E_BIN" ] || {
  echo "e2e: $ROEDY_E2E_BIN missing – run without --no-build" >&2
  exit 1
}
dev_browsers="${TMPDIR:-/tmp}/roedy-mail-dev/ms-playwright"
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$dev_browsers" ]; then
  export PLAYWRIGHT_BROWSERS_PATH="$dev_browsers"
fi

exec scripts/dev/stalwart.sh run pnpm --filter @roedy/web exec playwright test "$@"
