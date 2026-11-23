# Workflows

| Workflow | Runs on | What it does |
| --- | --- | --- |
| [CI](ci.yml) | PR, merge queue, main, weekly | Lint (ESLint, Prettier, ShellCheck, actionlint), web app (types, tests, build, JS budget), server (rustfmt, Clippy, tests), dependencies (cargo deny, licenses) |
| [E2E](e2e.yml) | PR, merge queue, main, weekly | Playwright against the release binary and a fresh Stalwart v1 |
| [Pull request](pr.yml) | PR | Conventional Commit title, dependency review |
| [CodeQL](codeql.yml) | PR, main, weekly | Code scanning of workflows, TypeScript and Rust |
| [Fuzzing](fuzz.yml) | PR (Rust changes), nightly | ClusterFuzzLite on the cargo-fuzz targets in `fuzz/` |
| [Release](release.yml) | Tag `v*`, PR (image changes) | Binaries and image, smoke test, Trivy; on tags signed multi-arch push and GitHub release |
| [Scorecard](scorecard.yml) | main, weekly | OpenSSF Scorecard |
| [Image retention](retention.yml) | Monthly | Deletes untagged images from ghcr.io |

## Required checks

The ruleset of `main` requires these job names; renaming a job breaks merging
until the ruleset is updated as well:

- `CI passed` (aggregates all CI jobs)
- `E2E`
- `Conventional title`
- `Analyze (actions)`, `Analyze (javascript-typescript)`, `Analyze (rust)`

## Conventions

- Every `uses:` is pinned to a full commit SHA with the version as a comment
  (checked by `scripts/action-pins.test.mjs`); Dependabot updates both.
- `permissions` are read-only at the top and widened per job only where needed.
- Every job has a `timeout-minutes`, every step a `name`.
- Checkouts use `persist-credentials: false`.
- Shared setup lives in composite actions in [`../actions/`](../actions):
  `setup-node` (pnpm, Node.js, `pnpm install`), `setup-rust` (stable toolchain,
  build cache written only on main) and `setup-buildx` (BuildKit pinned by
  digest).
- Pull request runs are cancelled by newer pushes; runs on main and tags are not.
