# Tasks for development, image and release (https://just.systems).
# `just` lists all recipes. Without just installed: `pnpm exec just …`
# (package rust-just, pinned in package.json).

set shell := ["bash", "-euo", "pipefail", "-c"]

# Target platforms of the image: statically linked with musl.
targets := "x86_64-unknown-linux-musl aarch64-unknown-linux-musl"

# List recipes
default:
    @just --list

# All checks as in the pre-push hook
check:
    cargo fmt --all -- --check
    cargo fmt --manifest-path fuzz/Cargo.toml -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test --workspace
    pnpm lint
    pnpm check
    pnpm test

# Run a fuzz target from fuzz/ (needs nightly Rust and cargo-fuzz; arguments go to libFuzzer, e.g. -max_total_time=60)
[positional-arguments]
fuzz target *args:
    #!/usr/bin/env bash
    set -euo pipefail
    target="$1"
    shift
    # New inputs go to fuzz/corpus/ (not in Git), fuzz/seeds/ stays as it is.
    mkdir -p "fuzz/corpus/$target"
    dict=()
    if [ -f "fuzz/dict/$target.dict" ]; then dict=("-dict=fuzz/dict/$target.dict"); fi
    seeds=()
    if [ -d "fuzz/seeds/$target" ]; then seeds=("fuzz/seeds/$target"); fi
    cargo +nightly fuzz run "$target" "fuzz/corpus/$target" "${seeds[@]}" -- "${dict[@]}" "$@"

# E2E suite against a fresh Stalwart v1 (builds web app and binary; arguments go to playwright test)
[positional-arguments]
e2e *args:
    scripts/e2e.sh "$@"

# Branding files (icons, favicon.ico, logo, social preview) to assets/branding and the web app's favicon.svg (needs rsvg-convert from librsvg)
branding:
    node scripts/branding/generate.mjs

# README and walkthrough screenshots with demo data to docs/screenshots (Playwright via scripts/dev/browser.sh; ImageMagick shrinks the files; arguments go to the script, e.g. --only compose)
[positional-arguments]
screenshots *args:
    scripts/dev/browser.sh install
    ROEDY_VERSION="${ROEDY_VERSION:-$(node -p 'require("./package.json").version')}" \
      scripts/dev/browser.sh run scripts/screenshots/capture.mjs docs/screenshots "$@"

# Build the web app with Rust licenses (needs cargo-about); build info from ROEDY_VERSION, ROEDY_BUILD_SHA, ROEDY_BUILD_DATE or Git
web:
    pnpm licenses:server
    ROEDY_SERVER_LICENSES=target/licenses-server.json pnpm --filter @roedy/web build

# Binaries with embedded web app to dist/ (needs zig, cargo-zigbuild, cargo-auditable and rustup targets)
dist: web
    rm -rf dist
    # One call for both targets: the LTO steps (codegen-units = 1) run in parallel.
    cargo auditable zigbuild --release --locked -p roedy-mail-server --features embed-web \
      {{ prepend("--target ", targets) }}
    install -D -m 0755 target/x86_64-unknown-linux-musl/release/roedy-mail dist/amd64/roedy-mail
    install -D -m 0755 target/aarch64-unknown-linux-musl/release/roedy-mail dist/arm64/roedy-mail
    ls -l dist/*/roedy-mail

# Build the image for the local platform from dist/ (Docker with buildx)
image tag="roedy-mail:dev":
    docker buildx build --load -t {{ tag }} .

# Smoke test for an image (version optional, e.g. 0.2.0)
smoke image="roedy-mail:dev" version="":
    scripts/image-smoke.sh {{ image }} {{ version }}

# Prepare a release: version, CHANGELOG.md and PR (version without v, e.g. 0.2.0)
release version:
    scripts/release.sh prepare {{ version }}

# After merging the release PR: set tag v<version> on main and push it
release-tag version:
    scripts/release.sh tag {{ version }}
