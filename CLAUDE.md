# Roedy Mail

Lightweight self-hosted webmail for Stalwart, built on JMAP.
Backend: Rust (axum, SQLite) in `crates/server`, JMAP client in `crates/jmap`.
Web app: Svelte 5 / SvelteKit SPA in `apps/web`, JMAP layer in `packages/jmap`,
design tokens in `packages/tokens`. Toolchain: Node 26, pnpm 12, Rust stable.

## Commands

- Sandboxed shell with read-only home: `. scripts/dev/sandbox-env.sh` in the same shell call before pnpm/cargo.
- Run: `pnpm install`, `cargo run -- serve` (:8080), `pnpm dev` (:5173).
- Checks (all must pass before a PR): `pnpm lint`, `pnpm check`, `pnpm test`,
  `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- Single tests: `pnpm --filter @roedy/web exec vitest run <file>`, `cargo test -p roedy-mail-server <filter>`.
- `just check|e2e|dist|image|smoke|screenshots` (`pnpm exec just …` without just).

## Conventions (details in CONTRIBUTING.md)

- English everywhere. German only in `apps/web/messages/de.json`, `crates/server/locales/de.json`
  and `crates/server/templates/de/`; every message key exists in en and de.
- Web: `#lib/…` imports with file extension, icons via `apps/web/src/lib/icons.ts`, colours via design tokens;
  keyboard and screen-reader accessible.
- Never edit an existing migration in `crates/server/src/db/migrations/`; add a new one.
- Stay lightweight (image ≤ 25 MB, idle ≤ 40 MB, mailbox JS ≤ 300 kB gzip); justify new dependencies.
- Clean room: no code from other webmail projects.

## Git

- Never push to `main`; work on a short-lived branch and open a PR. The maintainer squash-merges; never merge yourself.
- Conventional Commits for commits and PR titles: `<type>(<scope>): <description>`, lowercase, no trailing period.
  Types: feat fix perf refactor docs test build ci chore style revert.
  Scopes: server jmap web jmap-ts tokens ci deploy docs deps repo release.
  The PR title becomes the commit and the changelog entry.
- No real names, domains or email addresses in commits, docs, tests or fixtures. Use `example.com`, `*.example`,
  `*.test`, `*.invalid`; commit identities use GitHub noreply addresses.
