#!/usr/bin/env bash
# Starts a throwaway local Stalwart v1 for tests: the official release binary
# under $TMPDIR (outside the repository), only on 127.0.0.1 and only with
# generated test data. `run` sets up a fresh server, starts it, runs the
# command and stops the server again, so every run starts from a clean state.
#
#   scripts/dev/stalwart.sh install
#   scripts/dev/stalwart.sh run <command> [arguments …]
#   scripts/dev/stalwart.sh check
#
# The command finds the server at $STALWART_URL (http://127.0.0.1:18080)
# and the credentials in the JSON file $STALWART_CREDENTIALS (directory with
# mode 700, deleted after the run; fields in scripts/dev/stalwart.mjs). The
# credentials are random and appear in no output of this script.
# `check` is `run` with the compatibility checks of scripts/dev/stalwart.mjs
# (OAuth, CORS, tokens, push, Sieve and more). The E2E suite uses `run` as
# well, locally and in CI (scripts/e2e.sh).
#
# Network: `install` needs api.github.com, github.com and
# release-assets.githubusercontent.com (with $GH_TOKEN it queries the release
# API authenticated, which raises the rate limit); `run` and `check` need
# none. Only in the first two starts does Stalwart try to load its web
# interface from GitHub (bootstrap mode cannot turn that off; a failed
# download is harmless); afterwards web interface and ASN data are turned off.
set -euo pipefail

VERSION="${STALWART_VERSION:-v1.1.0}"
PORT=18080
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEV="${TMPDIR:-/tmp}/roedy-mail-dev"
DIR="$DEV/stalwart/$VERSION"
BIN="$DIR/stalwart"

fail() {
  echo "stalwart.sh: $*" >&2
  exit 1
}

case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64 ;;
  *) fail "architecture $(uname -m) not supported" ;;
esac
ASSET="stalwart-$ARCH-unknown-linux-gnu.tar.gz"

# SHA-256 of the release assets of the tested version v1.1.0 and of v1.0.2 (for
# comparison runs with STALWART_VERSION); any other version is only checked
# against the digest of the release API.
pinned_digest() {
  case "$VERSION/$ARCH" in
    v1.1.0/x86_64) echo 62e6fdaf68f6ddfb45aa0dc1c28578a7e05f1e5e9a0c95fccfe1eae709d4ecbc ;;
    v1.1.0/aarch64) echo e1ff640f0d3800d72a04916e7b402f19e28e9106ed3ed719a876d238d9f73567 ;;
    v1.0.2/x86_64) echo 10bd375d4541e2ffbafdfd5d97d8aa1a5c188438fd8700fbd6f076ee0fc2f24f ;;
    v1.0.2/aarch64) echo 79864acfd055d8fba52e636cde4821453669a0cc222975a607d392740be8fdae ;;
  esac
}

# Checks the cached binary against the SHA-256 that `install` recorded after
# verifying the archive (detects a modified or foreign binary).
cache_ok() {
  [ -x "$BIN" ] && [ -f "$DIR/stalwart.sha256" ] &&
    (cd "$DIR" && sha256sum -c --quiet --status stalwart.sha256)
}

install() {
  if cache_ok; then
    echo "Stalwart $VERSION is already verified in $DIR"
    return
  fi
  if [ -e "$BIN" ]; then
    echo "Stalwart $VERSION in $DIR without a matching SHA-256 – downloading again" >&2
    rm -f "$BIN" "$DIR/stalwart.sha256" "$DIR/sha256"
  fi
  mkdir -p "$DIR"
  local api digest pinned
  local -a auth=()
  # In CI (e2e.yml) with the run's token, otherwise the unauthenticated limit
  # applies; the token only goes to api.github.com.
  if [ -n "${GH_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GH_TOKEN"); fi
  api="$(curl -fsS -H 'Accept: application/vnd.github+json' "${auth[@]}" \
    "https://api.github.com/repos/stalwartlabs/stalwart/releases/tags/$VERSION")" ||
    fail "release $VERSION not available (network for api.github.com allowed?)"
  digest="$(node "$REPO/scripts/dev/stalwart.mjs" digest "$ASSET" <<<"$api")" ||
    fail "asset $ASSET without SHA-256 digest in release $VERSION"
  pinned="$(pinned_digest)"
  if [ -n "$pinned" ] && [ "$pinned" != "$digest" ]; then
    fail "release API digest ($digest) differs from the pinned value in the script ($pinned) – asset replaced?"
  fi

  tmp="$(mktemp -d "$DEV/stalwart/download.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/$ASSET" \
    "https://github.com/stalwartlabs/stalwart/releases/download/$VERSION/$ASSET" ||
    fail "download failed (network for github.com and release-assets.githubusercontent.com allowed?)"
  echo "$digest  $tmp/$ASSET" | sha256sum -c --quiet - || fail "SHA-256 of $ASSET does not match"
  # Only the binary from the archive, into its own directory (untrusted data).
  mkdir "$tmp/x"
  tar -xzf "$tmp/$ASSET" -C "$tmp/x" --no-same-owner --no-same-permissions stalwart ||
    fail "archive without file stalwart"
  [ -f "$tmp/x/stalwart" ] && [ ! -L "$tmp/x/stalwart" ] || fail "stalwart in the archive is not a file"
  chmod 755 "$tmp/x/stalwart"
  (cd "$tmp/x" && sha256sum stalwart) >"$tmp/stalwart.sha256"
  mv "$tmp/x/stalwart" "$BIN"
  mv "$tmp/stalwart.sha256" "$DIR/stalwart.sha256"
  echo "Stalwart $VERSION ($ARCH, sha256 $digest) in $DIR"
}

# --- run and check -------------------------------------------------------------
# Three starts in the same run directory: (1) without config.json in bootstrap
# mode, `x:Bootstrap/set` writes database, domain and admin; (2) in recovery
# mode, which only opens the recovery port and creates no default listeners
# (25, 443, 993 …) – there stalwart.mjs sets up listeners, CORS and the
# user account; (3) normal operation, only HTTP on 127.0.0.1:$PORT, where app
# passwords and the OAuth client follow (accounts cannot reach JMAP in
# recovery mode). Stalwart binds the recovery port to [::] unconditionally; it
# is only open during the setup and requires the random recovery admin.
RECOVERY_PORT=18081
URL="http://127.0.0.1:$PORT"
RECOVERY_URL="http://127.0.0.1:$RECOVERY_PORT"
HELPER="$REPO/scripts/dev/stalwart.mjs"
run_dir=
server=
parent=$$
bin_real=

# Starts Stalwart in the background (mode bootstrap, recovery or normal) and
# remembers the PID. Only the server process loads the environment with the
# recovery admin (`stalwart.env`, mode 600), not the command.
start_server() {
  local mode="$1"
  (
    set -a
    # shellcheck disable=SC1091
    . "$run_dir/stalwart.env"
    set +a
    export STALWART_RECOVERY_MODE_PORT="$RECOVERY_PORT"
    if [ "$mode" = recovery ]; then export STALWART_RECOVERY_MODE=1; fi
    exec "$BIN" -c "$run_dir/config.json"
  ) >>"$run_dir/stalwart.log" 2>&1 &
  server=$!
  # Watcher: if this script ends without the EXIT trap (e.g. SIGKILL on a
  # timeout), it stops the server and deletes the run directory with the
  # credentials.
  (
    set +e # inherited from set -e: a kill on an exited process must not abort it
    while kill -0 "$parent" 2>/dev/null && alive "$server"; do sleep 1; done
    if ! kill -0 "$parent" 2>/dev/null; then
      # Only our own server: after a normal end it has already been reaped,
      # and its PID may have been reassigned.
      if ours "$server"; then
        kill "$server" 2>/dev/null
        for _ in $(seq 1 40); do
          ours "$server" || break
          sleep 0.25
        done
        ours "$server" && kill -9 "$server" 2>/dev/null
      fi
      rm -rf "$run_dir"
    fi
  ) >/dev/null 2>&1 &
}

# Is the process still running? `kill -0` also succeeds for an exited child
# not yet reaped (zombie), hence the look into /proc.
alive() {
  [ -r "/proc/$1/status" ] && ! grep -q '^State:[[:space:]]*Z' "/proc/$1/status" 2>/dev/null
}

# Is this Stalwart binary (and no other process) still running under the PID?
ours() {
  alive "$1" && [ "$(readlink "/proc/$1/exe" 2>/dev/null)" = "$bin_real" ]
}

# Stops the server via the remembered PID and waits until port and database
# are free (after 10 s with SIGKILL).
stop_server() {
  [ -n "$server" ] || return 0
  kill "$server" 2>/dev/null || true
  (
    sleep 10
    kill -9 "$server" 2>/dev/null || true
  ) >/dev/null 2>&1 &
  local killer=$!
  wait "$server" 2>/dev/null || true
  kill "$killer" 2>/dev/null || true
  server=
}

# curl reports 7 when nobody listens; any other answer means: port in use.
port_free() {
  local probe=0
  curl -s --noproxy '*' -o /dev/null --max-time 2 "$1/" || probe=$?
  [ "$probe" -eq 7 ]
}

# Ready as soon as the JMAP session responds (200 without authentication).
wait_ready() {
  for _ in $(seq 1 120); do
    curl -sf --noproxy '*' -o /dev/null "$1/jmap/session" && return 0
    alive "$server" || return 1
    sleep 0.25
  done
  return 1
}

# Last lines of the log (without colors, secrets redacted) and abort.
startup_fail() {
  echo "--- Stalwart log (last lines):" >&2
  node "$HELPER" log "$run_dir/credentials.json" "$run_dir/stalwart.log" 40 >&2 || true
  fail "$1"
}

# Delete leftovers of aborted runs: a timeout often sends SIGKILL to the whole
# process group, then the watcher dies too and the run directory (credentials,
# about 80 MB of data) stays behind. A leftover is a directory whose lock
# nobody holds anymore (a PID is not reliable: the run may have used another
# PID namespace), or one without a lock that is older than a minute
# (otherwise a run being set up).
remove_stale() {
  local old
  for old in "$DEV"/stalwart/run.*; do
    [ -d "$old" ] || continue
    if [ -e "$old/lock" ]; then
      if flock -n "$old/lock" true 2>/dev/null; then rm -rf "$old"; fi
    elif [ -n "$(find "$old" -maxdepth 0 -mmin +1)" ]; then
      rm -rf "$old"
    fi
  done
}

cleanup() {
  stop_server
  if [ -n "$run_dir" ]; then rm -rf "$run_dir"; fi
}

run() {
  [ "$#" -gt 0 ] || fail "usage: $0 run <command> [arguments …]"
  cache_ok || fail "Stalwart $VERSION missing or differs from the verified state – first: $0 install"
  bin_real="$(readlink -f "$BIN")"
  port_free "$URL" || fail "port $PORT is already in use"
  port_free "$RECOVERY_URL" || fail "port $RECOVERY_PORT (recovery) is already in use"
  local caller="$PWD"

  mkdir -p "$DEV/stalwart"
  remove_stale
  run_dir="$(mktemp -d "$DEV/stalwart/run.XXXXXX")"
  chmod 700 "$run_dir"
  # Lock for the duration of the run; server and watcher inherit it, the command does not.
  exec 9>"$run_dir/lock"
  flock -n 9 || fail "lock $run_dir/lock not acquired"
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP

  node "$HELPER" credentials "$run_dir/credentials.json" "$URL" || fail "credentials not generated"

  start_server bootstrap
  wait_ready "$RECOVERY_URL" || startup_fail "bootstrap mode does not respond on port $RECOVERY_PORT"
  node "$HELPER" bootstrap "$run_dir/credentials.json" "$RECOVERY_URL" "$run_dir/data" || startup_fail "x:Bootstrap/set failed"
  stop_server
  [ -f "$run_dir/config.json" ] || startup_fail "bootstrap without config.json"

  start_server recovery
  wait_ready "$RECOVERY_URL" || startup_fail "recovery mode does not respond on port $RECOVERY_PORT"
  node "$HELPER" configure "$run_dir/credentials.json" "$RECOVERY_URL" || startup_fail "setup failed"
  stop_server

  start_server normal
  wait_ready "$URL" || startup_fail "Stalwart does not respond at $URL"
  node "$HELPER" accounts "$run_dir/credentials.json" || startup_fail "app passwords or OAuth client not created"

  cd "$caller"
  local status=0
  STALWART_URL="$URL" STALWART_CREDENTIALS="$run_dir/credentials.json" "$@" 9>&- || status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- Stalwart log (last lines):" >&2
    node "$HELPER" log "$run_dir/credentials.json" "$run_dir/stalwart.log" 20 >&2 || true
  fi
  exit "$status"
}

case "${1:-}" in
  install)
    install
    ;;
  run)
    shift
    run "$@"
    ;;
  check)
    run node "$HELPER" check
    ;;
  *)
    echo "Usage: $0 install | run <command> [arguments …] | check" >&2
    exit 2
    ;;
esac
