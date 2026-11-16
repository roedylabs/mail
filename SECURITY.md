# Security policy

## Supported versions

Roedy Mail is in 0.x development. Security fixes are released for the latest published version only.

| Version | Supported |
|---|---|
| latest 0.x release | ✅ |
| older releases | ❌ |

## Reporting a vulnerability

Please do **not** report security vulnerabilities via public issues, pull requests or discussions.

Use GitHub's private vulnerability reporting: **[Report a vulnerability](https://github.com/roedylabs/mail/security/advisories/new)** (repository tab "Security" › "Report a vulnerability").

Please include the affected version or commit, a description and the impact, steps to reproduce and, if available, a suggested fix. We aim to acknowledge reports within a few days, keep you informed while we work on a fix, and agree on the time of disclosure with you. Reporters are credited in the advisory unless they prefer otherwise.

## Particularly relevant areas

- Token broker: storage and issuing of refresh and access tokens of the mail accounts
- Sign-in, sessions, two-factor sign-in, recovery codes, password reset, invitations, setup token
- Rendering of untrusted HTML emails (sanitizing, sandbox iframe, external content)
- Content Security Policy and other security headers
- Administration functions (backups, restore, branding uploads)

## Notes for operators

- Secrets do not belong in the repository or in images: use `ROEDY_SECRET_KEY` or `ROEDY_SECRET_KEY_FILE`, or back up the key `/data/secret.key` (mode 0600) created on first start. The key is deliberately not part of the app backups.
- The reverse proxy terminates TLS; only set `ROEDY_TRUST_PROXY` when a trusted proxy sits in front.
- Anyone who can read the container logs can set up an instance that is not yet set up with the setup token. The token becomes invalid with the first administrator.
