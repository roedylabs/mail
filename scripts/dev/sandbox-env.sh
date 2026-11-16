# shellcheck shell=bash
# Environment for sandboxed shells where $HOME and /run are read-only (for
# example AI coding agents or locked-down CI runners).
# Usage: . scripts/dev/sandbox-env.sh
#
# Redirects caches (npm, pnpm, cargo), store locks, PNPM_HOME and corepack to
# $TMPDIR and provides pnpm via corepack if it is missing (Node 26 no longer
# ships corepack).
# The pnpm version comes from "packageManager" in package.json: an installed
# pnpm 12 puts that version under $PNPM_HOME and starts it, without corepack.
# PNPM_HOME is set explicitly because the profile usually sets it to
# ~/.local/share/pnpm (then XDG_DATA_HOME does not apply).

_rm_base=${TMPDIR:-/tmp}/roedy-mail-dev
export npm_config_cache="$_rm_base/npm-cache"
export COREPACK_HOME="$_rm_base/corepack-home"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export NODE_USE_ENV_PROXY=1 # otherwise Node fetch (corepack) does not use the sandbox proxy
export XDG_RUNTIME_DIR="$_rm_base/run" # pnpm 12 creates store locks there
export XDG_CACHE_HOME="$_rm_base/cache"
export XDG_DATA_HOME="$_rm_base/data"
export XDG_STATE_HOME="$_rm_base/state"
export PNPM_HOME="$_rm_base/pnpm-home" # version from "packageManager" (pnpm 12)
export CARGO_HOME="$_rm_base/cargo-home" # registry cache; ~/.cargo is not writable
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$PNPM_HOME"
chmod 700 "$XDG_RUNTIME_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  if [ ! -x "$_rm_base/corepack/node_modules/.bin/corepack" ]; then
    npm install --silent --no-audit --no-fund --prefix "$_rm_base/corepack" corepack
  fi
  mkdir -p "$_rm_base/bin"
  "$_rm_base/corepack/node_modules/.bin/corepack" enable --install-directory "$_rm_base/bin" pnpm
  export PATH="$_rm_base/bin:$PATH"
fi
unset _rm_base
