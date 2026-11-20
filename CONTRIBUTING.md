# Contributing to Roedy Mail

Thanks for your interest in Roedy Mail! Bug reports, ideas, translations, documentation and code are all welcome.

- **Questions and ideas:** [GitHub Discussions](https://github.com/roedylabs/mail/discussions)
- **Bugs and feature requests:** [issues](https://github.com/roedylabs/mail/issues/new/choose)
- **Security vulnerabilities:** never in public, see [SECURITY.md](SECURITY.md)

For larger changes, please open an issue or discussion first so we can agree on the approach before you invest time.

## Development setup

**Requirements:** Node 26, pnpm 12 and Rust stable. The easiest way is [mise](https://mise.jdx.dev) (`mise install`). Without mise, enable pnpm via corepack (`npm install -g corepack && corepack enable`); the pnpm version is pinned in `package.json`.

```sh
pnpm install          # dependencies and Git hooks (lefthook)
ROEDY_PUBLIC_URL=http://localhost:5173 cargo run -- serve    # backend on :8080, data in ./data
pnpm dev              # web app on http://localhost:5173, proxies /api to the backend
```

`ROEDY_PUBLIC_URL` is required; in development it is the address of the web app. The first start prints a setup token in the backend log; open the web app and follow the setup wizard. You need a Stalwart v1 server to sign in to mail accounts – `scripts/dev/stalwart.sh` starts a throwaway local one for tests.

In a sandboxed shell with a read-only home directory, run `. scripts/dev/sandbox-env.sh` first; it moves the pnpm, npm and cargo caches to `$TMPDIR`.

Useful environment variables during development: `ROEDY_LOG_FORMAT=text` for readable logs, `ROEDY_LOG=debug,tower_http=debug` to log every request. The session cookie is `Secure`; Chrome and Firefox accept it on `http://localhost`, Safari does not.

Common tasks are in the [`justfile`](justfile) (`pnpm exec just …` if [just](https://just.systems) is not installed):

| Command | What it does |
|---|---|
| `just check` | All checks below |
| `just e2e` | End-to-end suite against the binary and a local Stalwart |
| `just dist` | Static release binaries with the embedded web app |
| `just image` / `just smoke` | Build and smoke-test the container image (needs Docker) |
| `just screenshots` | Regenerate the screenshots in `docs/screenshots/` with demo data |
| `just branding` | Regenerate the icons, logo and social preview in `assets/branding/` |

## Checks

The same checks run in CI and in the `pre-push` hook:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm lint             # ESLint and Prettier (pnpm format fixes formatting)
pnpm check            # svelte-check and TypeScript
pnpm test             # Vitest and script tests
```

While iterating, run single test files: `pnpm --filter @roedy/web exec vitest run <file>` or `cargo test -p roedy-mail-server <filter>`.

### Fuzzing and property-based tests

Code that reads untrusted input gets randomized tests as well as hand-written ones:

- **Web:** property-based tests with [fast-check](https://fast-check.dev) next to the unit tests (`*.property.test.ts`), e.g. for the mail renderer and the EventSource parser. They run with `pnpm test`; a failure prints the counterexample and the seed to replay it.
- **Server:** [cargo-fuzz](https://rust-fuzz.github.io/book/cargo-fuzz.html) targets in [`fuzz/`](fuzz/README.md) for addresses, JMAP responses and headers. ClusterFuzzLite runs them on pull requests that change Rust code and every night ([`fuzz.yml`](.github/workflows/fuzz.yml)). Locally with nightly Rust and `cargo install cargo-fuzz`: `just fuzz <target> -max_total_time=60`.

New parsers of external input should get a property or a fuzz target; a bug found that way also gets a regular regression test.

## Project layout

| Path | Content |
|---|---|
| `crates/server` | Backend (Rust, axum, SQLite), binary `roedy-mail` |
| `crates/jmap` | Minimal JMAP client used by the backend |
| `apps/web` | Web app (Svelte 5, SvelteKit as an SPA) |
| `packages/jmap` | JMAP layer for the browser (TypeScript) |
| `packages/tokens` | Design tokens as CSS and TypeScript constants |
| `fuzz/` | Fuzz targets for the backend (cargo-fuzz, outside the workspace) |
| `docs/` | Operator documentation |
| `assets/branding/` | Icons, logo and social preview of the project |
| `scripts/` | Git hooks, release, E2E, load test and developer tooling |

## Conventions

- **Language:** code, comments, commits and docs are in English. UI texts live in `apps/web/messages/{en,de}.json`, server texts in `crates/server/locales/{en,de}.json` and `crates/server/templates/{en,de}/`. English is the source language; every key needs both languages.
- **Web app:** imports via `#lib/…` with file extension, icons through the registry in `apps/web/src/lib/icons.ts`, colours through the design tokens.
- **Accessibility:** every interactive element must be usable with the keyboard and a screen reader; `scripts/a11y/audit.mjs` runs axe over all pages.
- **Database:** never edit an existing migration in `crates/server/src/db/migrations/`; add a new one.
- **Dependencies:** keep the app lightweight (image ≤ 25 MB, idle memory ≤ 40 MB, mailbox JavaScript ≤ 300 kB gzip). Justify new dependencies in the PR. Libraries that end up in the browser bundle belong in `dependencies`, build and test tools in `devDependencies` (`pnpm audit --prod` checks the former).
- **Pinning:** GitHub Actions by full commit SHA, container images (`FROM`, BuildKit in `.github/buildkit/Dockerfile`) by digest; Dependabot keeps them current. `scripts/action-pins.test.mjs` and `scripts/docker-pins.test.mjs` check it in `pnpm test`.
- **Clean room:** do not copy code from other webmail projects. The basis is the JMAP RFCs and the Stalwart documentation.

## Commits and pull requests

- Branch from `main` with a short-lived branch, e.g. `feat/search-filters` or `fix/attachment-preview`.
- Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/en/): `<type>(<scope>): <description>` with the types `feat fix perf refactor docs test build ci chore style revert` and the scopes `server jmap web jmap-ts tokens ci deploy docs deps repo`. The description starts lowercase and has no trailing period.
- Pull requests are squash-merged; the PR title becomes the commit and the changelog entry.
- Keep pull requests focused. Add tests, update the docs and include screenshots for UI changes (light and dark, desktop and mobile).
- CI, CodeQL and an automated review by CodeRabbit run on every pull request; a maintainer reviews and merges.

## Releases

Maintainers release from `main` with [git-cliff](https://git-cliff.org):

```sh
just release 0.2.0       # branch, version bump, CHANGELOG.md and release PR
just release-tag 0.2.0   # after merging: tag v0.2.0 on main, starts the release workflow
```

The release workflow only accepts a tag on the release commit `chore(release): v<version>` on `main` and never overwrites a published version. It builds and checks the image (size, smoke test, Trivy), publishes it to `ghcr.io/roedylabs/mail` for amd64 and arm64, signs it with cosign, attests image and binaries, and creates the GitHub release.

## License

Roedy Mail is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). By submitting a contribution you agree that it is licensed under the same terms.
