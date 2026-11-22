# Operating Roedy Mail

> Installation with Docker Compose and a reverse proxy, configuration, initial setup, data directory, backup and restore, updates, monitoring and troubleshooting. What the individual areas of the app need is described in the guides under [`docs/setup/`](#further-guides).

Roedy Mail is a single process with an embedded web app and an SQLite database. The browser speaks JMAP directly with the Stalwart servers; the backend manages app accounts, settings and the list of mail servers and issues short-lived access tokens. It is shipped as the Docker image `ghcr.io/roedylabs/mail` for `linux/amd64` and `linux/arm64`; the source code is at [github.com/roedylabs/mail](https://github.com/roedylabs/mail).

```
Browser ──HTTPS──► reverse proxy ──HTTP──► roedy-mail (127.0.0.1:8080) ──► /data (SQLite, key, backups)
   │                                            │
   └──HTTPS (JMAP, OAuth)──► Stalwart v1 ◄──────┘ (diagnostics, token refresh, system emails)
```

## Requirements

- **Host:** Linux with Docker and Compose v2, `linux/amd64` or `linux/arm64`. Roedy Mail needs about 15 MB of memory when idle, up to 40 MB under load, plus a GeoIP database if configured; the image is about 14 MB.
- **Own host name with HTTPS**, such as `webmail.example.com`. The app needs the root `/` of its origin; a sub-path does not work. A [reverse proxy](#reverse-proxy) terminates TLS.
- **Stalwart v1.x from v1.0.0** at a public HTTPS address that every user's browser can reach, prepared as described in [`docs/setup/stalwart.md`](setup/stalwart.md): CORS, OAuth client, allow list. Ideally before the initial setup.
- **Outgoing connections** of the server (HTTPS): to the Stalwart servers, to the browsers' push services for web push ([`notifications.md`](setup/notifications.md#requirements)) and, while the update check is on, to `api.github.com` ([`administration.md`](setup/administration.md#updates)). The server reaches the push services directly, without an HTTP proxy, and only at public addresses.
- **Time:** The host needs an accurate clock (NTP). Authenticator app codes and the expiry times of sessions and tokens depend on it.

## Installation

### With Docker Compose

The basis is [`deploy/compose.yml`](../deploy/compose.yml): a container `roedy-mail`, port `8080` only on `127.0.0.1` for the proxy, a named volume `roedy-data` for `/data`, a read-only file system except for `/data` and `/tmp`, no capabilities.

1. Put `compose.yml` into its own directory, such as `/opt/roedy-mail/compose.yml`, and create a `.env` file next to it from the template [`deploy/.env.example`](../deploy/.env.example):

   ```sh
   curl -fsSL -o .env https://raw.githubusercontent.com/roedylabs/mail/main/deploy/.env.example
   chmod 600 .env
   ```

   It lists every variable of `compose.yml`. Replace `mail.example.com` with your own public host name; the minimum is:

   ```sh
   ROEDY_PUBLIC_URL=https://mail.example.com
   ROEDY_IMAGE_TAG=0.1
   ```

   `ROEDY_PUBLIC_URL` is required: it sets the address for links in emails and the redirect URI; without it, the server does not start (instances set up before 0.2 keep the address their setup stored). A fixed version in the tag (`0.1` follows the patches of 0.1.x, `0.1.0` is exactly that version) makes updates predictable; `latest` is the default. Pre-releases such as `0.2.0-rc.1` are only available under their own name. All variables: [Configuration](#configuration).

2. Start and check the health (the image is public, no `docker login` needed):

   ```sh
   docker compose up -d
   docker compose ps                          # column STATUS: healthy
   curl -fsS http://127.0.0.1:8080/readyz     # {"status":"ok"}
   ```

3. Set up the [reverse proxy](#reverse-proxy) and start the [initial setup](#initial-setup) in the browser at the public address.

The commands here run in the directory of `compose.yml`; from another directory use `-f <path>/compose.yml`. The container is always called `roedy-mail`, the volume `roedy-mail_roedy-data`.

**Bind mount instead of a volume:** A host directory must belong to the container's user (default 65532:65532, see below), otherwise the server does not start (`Permission denied`):

```sh
sudo install -d -o 65532 -g 65532 -m 700 /srv/roedy-mail
```

and in `compose.yml` `- /srv/roedy-mail:/data` instead of `- roedy-data:/data`. The data directory must be on a local file system, not on NFS or SMB: SQLite in WAL mode needs shared memory and reliable locks.

**Container user:** The server runs as user and group 65532 (the image's `USER`). To run it under other IDs, for example a service account that owns the data directory on the host, set `ROEDY_UID` and `ROEDY_GID` in `.env`; `compose.yml` passes them as `user:`. Never use 0 (root). The data directory must belong to these IDs:

- **New instance:** use a [bind mount](#with-docker-compose) created with these IDs, e.g. `sudo install -d -o 1500 -g 1500 -m 700 /srv/roedy-mail`. Not a new named volume: while it is empty, Docker fills it from the image's `/data` when the container is created, including owner 65532, so a `chown` beforehand does not last.
- **Existing instance** (the volume already holds the database): stop the container, change the owner once, set the IDs in `.env` and recreate the container with `docker compose up -d` (`docker compose start` would keep the old user):

  ```sh
  docker compose stop
  docker run --rm -v roedy-mail_roedy-data:/data alpine:3.24 chown -R 1500:1500 /data
  docker compose up -d
  ```

  The volume name assumes the project name `roedy-mail` from `compose.yml`; with `-p` or `COMPOSE_PROJECT_NAME` it is `<project>_roedy-data`.

  With a bind mount `sudo chown -R 1500:1500 <directory>` instead. The same applies to a separately mounted `/data/backups` ([Backup and restore](#backup-and-restore)).

**Verifying the image:** Every release carries an SBOM and provenance as attestations and is signed keylessly with [cosign](https://github.com/sigstore/cosign) by the release workflow (the signature is recorded in the public transparency log Rekor):

```sh
cosign verify ghcr.io/roedylabs/mail:0.1.0 \
  --certificate-identity https://github.com/roedylabs/mail/.github/workflows/release.yml@refs/tags/v0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Building it yourself:** `just dist` (needs [Zig](https://ziglang.org), `cargo-zigbuild`, `cargo-auditable`, `cargo-about` and the Rust targets `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`), then `just image` or `docker buildx build --platform linux/amd64,linux/arm64 .`. The Dockerfile only packages the binaries from `dist/`.

### Reverse proxy

The proxy terminates TLS and forwards all paths of the origin to `http://127.0.0.1:8080`. What it must do and what it must not do:

- **Append `X-Forwarded-For`.** `deploy/compose.yml` sets `ROEDY_TRUST_PROXY=true`: the client IP for rate limits, sessions and the audit log is then the entry the proxy appended. Caddy and Traefik do this by themselves, nginx with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. With two proxies in a row (such as a CDN in front of Caddy), use `ROEDY_TRUST_PROXY=2`; the rear one must then trust the front one, otherwise it replaces its entry with the front one's address (Caddy: `trusted_proxies`, Traefik: `forwardedHeaders.trustedIPs`; nginx with `$proxy_add_x_forwarded_for` always appends). The rear proxy may then only accept requests from the front one (firewall or `allow`/`deny` for the CDN's addresses), otherwise a client bypassing the CDN sets the evaluated entry itself. The container's port must only be reachable for the proxy, otherwise a client chooses its own address.
- **Pass request headers through unchanged**, in particular `Cookie`, `X-Requested-With` and `Sec-Fetch-*`. Without `X-Requested-With` the API rejects every change with 403 `csrf`. With `Sec-Fetch-Dest` it rejects requests the browser loads as an embedded resource, such as an image in an HTML email that points at the API: if the proxy removes the headers, this protection is missing; if it rewrites them, normal calls fail.
- **Do not replace response headers.** The server sets the Content Security Policy, `Cross-Origin-Opener-Policy`, `Referrer-Policy`, `Permissions-Policy`, `X-Content-Type-Options`, with `ROEDY_TRUST_PROXY` also HSTS, and the cache headers. An additional CSP from the proxy applies alongside our own and, when in doubt, blocks the mail servers. The proxy must not cache `/`, `/service-worker.js` and `/manifest.webmanifest` longer than the backend allows, otherwise updates and a changed branding arrive late ([`app.md`](setup/app.md#requirements)).
- **Compress.** The backend does not compress; without compression the first load transfers about three times as much (953 instead of 285 kB). Caddy with `encode`, nginx with `gzip` for HTML, CSS, JavaScript, JSON and SVG.
- **Accept requests up to 2 MB.** The uploaded logo (Administration › Branding) arrives as JSON of up to 1.4 MB. Without configuration nginx only allows 1 MB.
- **HTTP/2** to the browser is recommended, important for Stalwart ([`stalwart.md`](setup/stalwart.md#server-address)).
- **Public paths:** If the proxy has its own sign-in in front, it exempts `/branding/mail-logo.png` (logo of the system emails; mail clients load it without signing in) and `/branding/push-icon.png` (icon of the push notifications).

**Caddy** (certificate and redirect from HTTP come by themselves):

```
webmail.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
}
```

**nginx** (from 1.25.1; older versions write `listen 443 ssl http2;` instead of `http2 on;`):

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name webmail.example.com;

    ssl_certificate     /etc/letsencrypt/live/webmail.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/webmail.example.com/privkey.pem;

    client_max_body_size 2m;
    proxy_read_timeout 300s;   # backup, restore and compaction run in one request
    gzip on;
    gzip_types text/css text/javascript application/javascript application/json
               application/manifest+json image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name webmail.example.com;
    return 301 https://$host$request_uri;
}
```

**Traefik:** If Traefik itself runs as a container, it cannot reach the host's `127.0.0.1`. Then leave out `ports` in `compose.yml`, attach the service to Traefik's network and create a router on port `8080` with the `compress` middleware. Traefik sets `X-Forwarded-For` by itself; `ROEDY_TRUST_PROXY=true` stays.

**Stalwart on the same host:** Stalwart needs its own host name (such as `mail.example.com`) and, like Roedy Mail, listens on port 8080 by default; then change the host port in `compose.yml` (`"127.0.0.1:8081:8080"`) and point the proxy at `127.0.0.1:8081`. What the proxy in front of Stalwart needs (source of the client address, `Access-Control-Expose-Headers`) is described in [`stalwart.md`](setup/stalwart.md#behind-a-reverse-proxy).

## Configuration

All settings come from environment variables, with Compose from the `.env` file next to `compose.yml`. Values are read as text without surrounding whitespace, so a key or path made only of digits works as well. Empty values count as unset, unknown `ROEDY_*` variables are ignored, invalid values prevent the start with a line `error: …` that names the variable (such as `error: Invalid configuration – ROEDY_LISTEN: …`). Everything else is configured by administrators in the app ([`administration.md`](setup/administration.md)).

| Variable | Default | Meaning |
|---|---|---|
| `ROEDY_LISTEN` | `0.0.0.0:8080` | Address and port of the HTTP server. The reverse proxy handles TLS. |
| `ROEDY_DATA_DIR` | `data` relative to the working directory (in the image `/data`) | [Data directory](#data-directory) with the database `roedy.sqlite3`. Must be on a local file system (SQLite in WAL mode). |
| `ROEDY_PUBLIC_URL` | – | **Required.** Public address, e.g. `https://mail.example.com` (without credentials, query or fragment). Without it, `serve` exits with `error: ROEDY_PUBLIC_URL is not set – …`, unless the setup of an older version stored an address. The setup does not ask for it. |
| `ROEDY_LOG` | `info` | Log filter in the format of [`EnvFilter`](https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html), e.g. `warn` or `info,roedy_mail_server=debug`. The setup token always appears. |
| `ROEDY_LOG_FORMAT` | `json` | `json` (one line per event) or `text`. Logs go to stderr. |
| `ROEDY_WEB_DIR` | – | Directory with the web app build (e.g. `apps/web/build`). Takes precedence over the embedded web app; for development. |
| `ROEDY_TRUST_PROXY` | `false` (in `deploy/compose.yml` `true`) | Reverse proxies in front of the server: `true` for one, otherwise their number (at most 10). The client IP is then the entry in `X-Forwarded-For` appended by the front-most proxy, and the server sends HSTS. Only set it when the port is reachable exclusively via the proxy and every proxy appends to `X-Forwarded-For` instead of passing it through ([Reverse proxy](#reverse-proxy)). In `compose.yml` `true` applies as long as the variable is missing; set to empty means off. |
| `ROEDY_SECRET_KEY` | – | Instance key for secrets in the database (OAuth client secrets, tokens of the mail accounts, credentials of the sender account, authenticator app secrets, invitation links, VAPID keys, GitHub token of the update check): 32 bytes as 64 hex characters (`openssl rand -hex 32`) or Base64 (`openssl rand -base64 32`). If it is missing as well as `ROEDY_SECRET_KEY_FILE`, the first start creates `<ROEDY_DATA_DIR>/secret.key` (`0600`) and uses it afterwards. Without the key these values can no longer be read ([Key](#instance-key)). |
| `ROEDY_SECRET_KEY_FILE` | – | File with this key, e.g. a Docker secret (`/run/secrets/roedy_secret_key`). Not together with `ROEDY_SECRET_KEY`. |
| `ROEDY_GEOIP_DB` | – | GeoIP database in MaxMind DB format (e.g. GeoLite2-City or DB-IP Lite, as a volume, not in the image) for the location in "Signed-in devices", security emails and the audit log ("Hamburg, Germany"); without it, the shortened IP address appears there. The file is held in memory (GeoLite2-City ≈ 60 MB, -Country ≈ 9 MB) and reloaded daily if it has changed. |
| `ROEDY_IMAGE_TAG` | `latest` | Only in `deploy/compose.yml`: version of the image ([Updates](#updates)). |
| `ROEDY_UID`, `ROEDY_GID` | `65532` | Only in `deploy/compose.yml`: user and group the container runs as. The data directory must belong to them ([Container user](#with-docker-compose)). |
| `MIMALLOC_PURGE_DELAY`, `MIMALLOC_ALLOW_THP` | `0` in the image | Allocator: return free memory immediately, no Transparent Huge Pages. Without them the idle server keeps up to 58 instead of 14 MB. |

**HTTPS:** The session cookie (`__Host-roedy_session`) is `Secure`; signing in therefore only works via HTTPS or `http://localhost`. Service worker, installation as an app and push need it as well.

## Initial setup

As long as no administrator exists, the app redirects to the setup (`/setup`), and the server writes the **setup token** to the log on every start, regardless of `ROEDY_LOG`. The setup asks for it in the second step:

```sh
docker logs roedy-mail 2>&1 | grep Setup-Token
docker exec roedy-mail roedy-mail setup-token   # alternatively
```

The token is valid until the setup is completed; afterwards `roedy-mail setup-token` reports `error: Setup is complete; there is no setup token anymore.` (exit code 1). After five wrong entries, input from that address is blocked for 30 seconds.

The setup only creates the administrator, with multi-factor authentication from the start, in seven steps:

1. **Language and appearance:** language (System, English, German), theme (System, Light, Dark) and accent color (five colors or your own under "More"). They apply to the wizard at once and become the administrator's settings; nothing is sent to the server yet.
2. **Setup token:** the token from the log.
3. **Administrator:** name and email address.
4. **Password:** password and confirmation; "Continue" is available once the rules below the field are met.
5. **Authenticator app:** QR code and key for an authenticator app, confirmed with a 6-digit code; it cannot be skipped. After five wrong codes the field is locked for 15 minutes.
6. **Recovery codes:** the ten recovery codes with "Copy" and "Download"; "Continue" needs the confirmation that they are saved.
7. **Review** ("All set?"): a summary with "Change" per row; "Finish setup" creates the administrator with the authenticator app and the recovery codes and revokes the setup token.

The setup runs in this browser tab: language, appearance, name and email address stay in the tab's session storage, the token, the password, the app's key and the recovery codes only in memory. The account, its authenticator app and its recovery codes only come into being with "Finish setup". After a reload on steps 3 to 7 the wizard returns to the setup token with the other details kept; the authenticator app then has to be scanned again. Then it signs the administrator in and opens Administration › Mail servers; every later sign-in asks for a code from the app. The public address is not part of the setup; it comes from [`ROEDY_PUBLIC_URL`](#configuration).

Next:

1. Add the mail server under Administration › Mail servers, with the OAuth client ([`stalwart.md`](setup/stalwart.md#oauth-client)); "Test connection" checks it.
2. Set up the system emails under Administration › Email with a [sender account](setup/stalwart.md#sender-account-for-system-emails) (optional; invitations, password reset and notifications by email need it).
3. Back up the [instance key](#instance-key).
4. Under Administration › Maintenance, check the schedule of the [backups](#backup-and-restore) (daily by default, 30 days).
5. Invite more people under Administration › Users: with system emails by email, without them via "Copy link".
6. Optionally adjust the [update check](#updates) under Administration › Updates.

## Data directory

Everything the server stores permanently lives in `/data` (`ROEDY_DATA_DIR`), owner 65532 (or `ROEDY_UID`/`ROEDY_GID`), directory `0700`, files `0600`:

| Path | Content |
|---|---|
| `roedy.sqlite3` | Database: users, sessions, settings, mail servers, tokens of the mail accounts (encrypted), notifications, audit log, branding |
| `roedy.sqlite3-wal`, `roedy.sqlite3-shm` | Part of the database while it is open (WAL mode). Never delete or copy them individually while the server is running. |
| `secret.key` | [Instance key](#instance-key), only without `ROEDY_SECRET_KEY` and `ROEDY_SECRET_KEY_FILE` |
| `backups/` | [Backups](#backup-and-restore) as `.tar.zst`, temporary files in `backups/.tmp-…` |

SQLite's temporary files go to `/tmp` (a `tmpfs` in `compose.yml`). Administration › Maintenance › Storage shows the usage; the database can also be compacted there ([`administration.md`](setup/administration.md#storage)). A copy of the files while the server is running is not a usable backup; that is what the app's backups are for.

### Instance key

The key encrypts all secrets in the database. It does **not** belong in the backups: whoever has a backup should not be able to read the secrets in it. So store it separately right after the setup, for example in a password manager:

```sh
docker cp roedy-mail:/data/secret.key ./secret.key   # 64 hex characters
```

Delete the file afterwards once the key is in its place, otherwise it may end up next to the backups along with the directory after all. The content also works as `ROEDY_SECRET_KEY`. Without it no backup can be restored; with a different key the server starts, but can no longer use mail accounts, OAuth clients, the sender account, authenticator apps and push ([Troubleshooting](#troubleshooting)). There is no command to change the key.

## Backup and restore

Administration › Maintenance creates backups by hand ("Back up now") or on a schedule (daily or weekly, default daily, keep for 30 days; [`administration.md`](setup/administration.md#backups)). A backup is a file `roedy-mail-<timestamp>-<auto|manual>-<ID>.tar.zst` in `/data/backups` with `manifest.json` and `roedy.sqlite3`: all settings, users, mail servers and the branding. The files are the list: whatever lies there, the page shows. The next successful backup deletes automatic backups older than the retention; manual backups stay. If a scheduled backup fails, the administrators get "Backup failed"; the cause is in the log.

**Not included:** the [key](#instance-key), the emails (they live in Stalwart, whose backup is Stalwart's business) and the GeoIP database.

**Keep off-site:** Backups on the same disk do not protect against its failure. Options:

- copy the directory from the host regularly, for example via cron:

  ```sh
  docker cp roedy-mail:/data/backups/. /srv/roedy-mail-backups/
  ```

  `.tmp-…` directories in it come from a backup currently running and do not belong to it.

- mount a separate directory or share at `/data/backups` (owner 65532 or `ROEDY_UID`/`ROEDY_GID`; unlike for the database, it may be a network drive for the backups), in `compose.yml` additionally `- /mnt/backup/roedy-mail:/data/backups`;
- download individual backups on the page.

**Restoring in the app:** Only in maintenance mode, so that nobody changes data during the restore: turn it on under Administration › Maintenance (the notice above the list of backups has a button for it). Until then "Restore" is locked, and the server rejects a restore outside maintenance mode with 409 `maintenance_required` without changing anything; it checks again right before it copies the backup over the live database, so turning maintenance mode off while the backup is being unpacked and checked cancels the restore, even if it is turned on again before the copy. Administrators can still work during that time: whatever they change before the copy is lost with it. Restoring resets all data to the state of the backup, without a restart, including the maintenance mode: afterwards it is set as in the backup, so usually off again. Afterwards all other people are signed out, password reset links from emails expire, and mail accounts with OAuth may require a new sign-in (Stalwart v1 has replaced their refresh tokens in the meantime). The server rejects a backup from a newer version, with a different key, or one that was changed after it was created before it changes anything: `manifest.json` carries an HMAC with the instance key over its fields and the SHA-256 of `roedy.sqlite3`, so whoever can write to the backups directory but does not have the key cannot plant a database of their own. A backup whose HMAC does not fit, or which has none, is rejected with 422 `backup_unverified`. Backups made before this check existed (manifest format 1) can no longer be restored in the app: the list marks them as older (`legacy` in `GET /api/v1/admin/backups`) and "Restore" stays locked. The audit log is not reset: its entries since the backup stay, plus the entry about the restore. Restoring needs free space of about twice the size of the database.

**On a new instance:** start with the same key (`ROEDY_SECRET_KEY` in `.env` or `ROEDY_SECRET_KEY_FILE`), set up, copy the backup to `/data/backups` and restore it on the page. `docker cp` creates files in the container as root; the server could then not open a backup (`0600`). So use a helper container that sets owner and mode (in the backup's directory):

```sh
file=roedy-mail-20261104T003000Z-auto-….tar.zst
uid=65532 gid=65532   # or ROEDY_UID / ROEDY_GID from .env
docker run --rm -v roedy-mail_roedy-data:/data -v "$PWD":/backup:ro alpine:3.24 sh -c \
  "install -d -o $uid -g $gid -m 700 /data/backups &&
   install -o $uid -g $gid -m 600 /backup/$file /data/backups/"
```

The helper container only fits a named volume. If `/data/backups` is mounted separately as above, or `/data` itself is a bind mount, skip it (it would write into the volume underneath, where the app neither finds nor removes the file) and put the backup on the host as root directly into the directory behind `/data/backups` instead, e.g. `sudo install -o "$uid" -g "$gid" -m 600 "$file" /mnt/backup/roedy-mail/` for the separate mount, or for a `/data` bind mount `sudo install -d -o "$uid" -g "$gid" -m 700 /srv/roedy-mail/backups` and `sudo install -o "$uid" -g "$gid" -m 600 "$file" /srv/roedy-mail/backups/`.

**By hand, with the server stopped** – for example for an older version after a failed update, or when the server no longer starts. The host needs `zstd` for this (the `tar` in the `alpine` helper container cannot do it):

```sh
docker compose stop
mkdir restore && cd restore
docker cp roedy-mail:/data/backups/roedy-mail-20261104T003000Z-auto-….tar.zst .   # also works when stopped
zstd -dc roedy-mail-20261104T003000Z-auto-….tar.zst | tar -x   # extracts manifest.json and roedy.sqlite3
uid=65532 gid=65532   # or ROEDY_UID / ROEDY_GID from .env
docker run --rm -v roedy-mail_roedy-data:/data -v "$PWD":/backup:ro alpine:3.24 sh -c \
  "cp /backup/roedy.sqlite3 /data/ && rm -f /data/roedy.sqlite3-wal /data/roedy.sqlite3-shm &&
   chown $uid:$gid /data/roedy.sqlite3 && chmod 600 /data/roedy.sqlite3"
cd .. && docker compose up -d
```

With a bind mount instead of the volume, the same works without a helper container: copy `roedy.sqlite3` into the directory, delete `roedy.sqlite3-wal` and `roedy.sqlite3-shm`, set owner 65532 (or `ROEDY_UID`/`ROEDY_GID`) and mode `0600`. The key must be the same as for the backup. If the backup is older than the program version, the start applies the missing migrations. Unlike in the app, nothing checks the MAC (only restore a file by hand that you know comes from this instance), the audit log is at the state of the backup, and sessions and links from emails from the state of the backup stay valid, including those ended since. If you do not want the sessions and links, afterward create a backup in the app ("Back up now") and restore that one right away: a restore in the app ends all other sessions and the reset and email change links. This also works when the backup restored by hand is in the old format 1, which the app no longer restores itself.

## Updates

Roedy Mail does not install updates by itself. It checks the public GitHub releases of `roedylabs/mail` on a schedule and reports new versions to the administrators ([`administration.md`](setup/administration.md#updates)); a GitHub token is optional and only raises the API rate limit. What changes is described in the release notes and in `CHANGELOG.md`.

Versions follow 0.x: a new minor version (0.1 → 0.2) may contain migrations and operational changes, a patch version (0.1.0 → 0.1.1) fixes bugs. An update:

1. Under Administration › Maintenance **"Back up now"**. A manual backup stays until someone deletes it.
2. Read the release notes, raise `ROEDY_IMAGE_TAG` in `.env` if needed.
3. Pull the new image and restart the container:

   ```sh
   docker compose pull
   docker compose up -d
   docker logs roedy-mail 2>&1 | grep -E 'migration applied|Roedy Mail started'
   ```

The server applies pending migrations by itself on start (`roedy-mail migrate` does the same without starting) and finishes running requests within 8 seconds when stopping. After a newer version starts, administrators get "Update installed" and all users "New in version …". Open tabs and installed apps fetch the new web app by themselves ([`app.md`](setup/app.md#new-version)).

**Back to an older version:** An older version does not start once the database schema is newer than itself (`The database schema (version …) is newer than this program version`). Then set the older tag and restore the backup from before the update [by hand](#backup-and-restore); whatever happened since the update is lost.

**Stalwart:** All v1.x from v1.0.0 are supported, tested with v1.1.0. After an update of Stalwart, start the server once with `STALWART_UPDATE_ROLE_PERMISSIONS=true` ([Updating Stalwart](setup/stalwart.md#updating-stalwart)), then "Test connection" under Administration › Mail servers.

## Monitoring

### Health

| Endpoint | Response |
|---|---|
| `GET /healthz` | `200 {"status":"ok"}` as long as the process responds |
| `GET /readyz` | `200 {"status":"ok"}` if the database is readable within 2 seconds, otherwise `503 {"status":"unavailable"}` and a warning in the log |

Neither needs a sign-in, and both are also open behind the proxy; they reveal nothing but the health. The image checks itself with `roedy-mail healthcheck` (queries `/healthz`, without curl) every 30 seconds; after three failures the container counts as `unhealthy`. Docker does not restart it because of that; only `restart: unless-stopped` does after a crash. Because the health check only queries `/healthz`, the container stays `healthy` even with an unreadable database; only `/readyz` shows that. For external monitoring, `/readyz` via the public address is therefore the right choice:

```sh
docker compose ps                                          # column STATUS: healthy
docker inspect --format '{{.State.Health.Status}}' roedy-mail
docker inspect --format '{{json .State.Health.Log}}' roedy-mail   # last results
curl -fsS https://webmail.example.com/readyz
```

**Compose:** [`deploy/compose.yml`](../deploy/compose.yml) states the same check explicitly as `healthcheck:` with the image's timings `interval: 30s`, `timeout: 5s`, `start_period: 10s` and `retries: 3`. Docker fills keys that the block leaves out from the image's `HEALTHCHECK` one by one. `start_interval` is left out on purpose, because older Compose versions refuse it on Docker Engine before 25: Engine 25 and later take the image's `1s` (checks every second during `start_period`, so the container is usually `healthy` within a few seconds; Docker's own default would be 5 seconds), older engines know no start interval and check every 30 seconds from the start. The exec form `["CMD", "roedy-mail", "healthcheck"]` is needed because the image has no shell. The command reads the same `ROEDY_*` variables as the server: it queries the port of `ROEDY_LISTEN` over loopback (`127.0.0.1`, for `[::]` first `::1`), or the address itself if `ROEDY_LISTEN` names one, so a changed listener needs no change to the check. `compose.yml` does not pass `ROEDY_LISTEN` on: to change it, add it under `environment:` (e.g. `ROEDY_LISTEN: 0.0.0.0:9000`) and adjust `ports:` to match (`127.0.0.1:8080:9000`). It runs with the container's user (`ROEDY_UID`/`ROEDY_GID`) and restrictions, writes nothing and needs no capabilities.

- **Tune:** change the values in `compose.yml`, or in a `compose.override.yml` next to it, which `docker compose` merges by itself (not with `-f`), e.g. `services: { roedy-mail: { healthcheck: { interval: 60s } } }`. Recreate the container with `docker compose up -d`.
- **Turn off:** replace the keys of the block with `disable: true` alone and recreate the container with `docker compose up -d`. Deleting the block does not turn the check off; the image's `HEALTHCHECK` applies again. A service that waits with `condition: service_healthy` then no longer starts; change it to `service_started` or remove the dependency.
- **Reverse proxy in the same Compose file:** with `depends_on: { roedy-mail: { condition: service_healthy } }` it starts only once the server responds; it reaches the server at `http://roedy-mail:8080`. That needs a listener reachable from the Compose network, such as the default `0.0.0.0:8080`, not a loopback address; with another port in `ROEDY_LISTEN` use that port.

### Logs

The server writes to stderr, one JSON line per event with `timestamp`, `level`, `message`, `target` and further fields:

```json
{"timestamp":"2026-11-12T21:00:50.883094Z","level":"INFO","message":"Roedy Mail started","version":"0.1.0","listen":"0.0.0.0:8080","data_dir":"/data","public_url":"https://webmail.example.com/","web":"embedded","trust_proxy":1,"target":"roedy_mail_server::app"}
```

```sh
docker logs -f roedy-mail                                     # follow
docker logs --since 24h roedy-mail 2>&1 | grep -E '"level":"(WARN|ERROR)"'
```

`ROEDY_LOG=debug` shows more (including lines for every request with method and path, without query and without tokens), `ROEDY_LOG_FORMAT=text` readable text. Docker keeps the logs without limit. A limit is set in `compose.yml` on the service with

```yaml
    logging:
      driver: local
      options:
        max-size: 10m
        max-file: "5"
```

Messages that matter in operation:

| Message (`message`) | Level | Meaning |
|---|---|---|
| `Roedy Mail started` | INFO | Start with version, address, data directory and number of proxies (`trust_proxy`) |
| `migration applied` | INFO | Migration on start or with `roedy-mail migrate` |
| `Setup-Token: …` | INFO | Setup still pending |
| `database not ready`, `database not responding` | WARN | `/readyz` responds 503: disk full, permissions, lock |
| `job failed: …` | WARN | a background job (backup, updates, push, emails, cleanup) failed; the reason is included |
| `backup failed: …` | ERROR | scheduled backup failed; a manual backup reports its error as `internal error` |
| `System mail not sent` | WARN | Sending via Stalwart failed, reason in `reason` ([`stalwart.md`](setup/stalwart.md#sender-account-for-system-emails)) |
| `Sending account not usable` | INFO | Check of the sender account failed, reason in `reason` |
| `refresh failed`, `early refresh failed: …` | WARN | Stalwart not reachable or throttling; the accounts recover by themselves |
| `push service not reached: …` | WARN | Outgoing connection to a push service blocked ([`notifications.md`](setup/notifications.md#troubleshooting)) |
| `update check failed` | WARN, INFO | Reason in `reason`: WARN for `token` (token invalid or expired) and `no_access`, INFO for `rate_limited` and `unreachable`, which pass by themselves; Administration › Updates shows every failure |
| `checkpoint blocked, the -wal file stays large for now` | WARN | a long read held on to the database; harmless if it does not persist |
| `internal error: …` | ERROR | Error of a request (500), with cause |
| `response failed` | ERROR | Companion line for every response with 5xx, also for `/readyz` with 503; the cause is in the line before |

### In the app

Administration › Audit log shows sign-ins, changes and administrative actions with person, address and time ([`administration.md`](setup/administration.md#audit-log)), Administration › Maintenance › Storage the usage of the data directory. Administrators get notifications about new versions, installed updates and backups (topic System) and about security events.

## Commands

The container only contains the binary; commands run with `docker exec roedy-mail roedy-mail <command>`. Commands that use the database use the same `ROEDY_DATA_DIR` as the server.

| Command | Purpose |
|---|---|
| `roedy-mail serve` | Starts the server (default in the image). Applies pending migrations first; shuts down cleanly on SIGTERM or Ctrl+C (open requests get 8 s). |
| `roedy-mail healthcheck` | Queries `GET /healthz` of the running server (exit code 0 = healthy); for `HEALTHCHECK` in the image without curl. |
| `roedy-mail migrate` | Applies pending database migrations and shows the schema version. |
| `roedy-mail setup-token` | Shows the setup token for the setup. |
| `roedy-mail reset-admin [--user <email address or user name>]` | Restores an [administrator's access](#lost-access). With several administrators `--user` is required. |
| `roedy-mail --version` | Shows the version. |

## Troubleshooting

Errors of individual areas of the app are covered in the guides: [mail servers and diagnostics](setup/stalwart.md#diagnostic-reasons), [administration](setup/administration.md#troubleshooting), [notifications](setup/notifications.md#troubleshooting), [web app](setup/app.md#troubleshooting).

| Observation | Cause | Remedy |
|---|---|---|
| Container does not start, log `error: …` with the name of a variable | invalid value of a variable | Correct the value according to [Configuration](#configuration) |
| Container does not start, `Permission denied` under `/data` | Data directory does not belong to the container's user (65532 or `ROEDY_UID`/`ROEDY_GID`) | Bind mount: `sudo chown -R <uid>:<gid> <directory>`; volume: see [Container user](#with-docker-compose) |
| Container does not start, `The database schema (version …) is newer than this program version` | older version on a newer database | Start the newer version or go [back to an older version](#updates) |
| `/readyz` responds 503 (the container stays `healthy`) | Database not readable: disk full, permissions, network drive | Check the log (`database not ready`, `database not responding`), space and permissions; keep the data directory local |
| Container `unhealthy` | Process no longer responds on `/healthz` | Look at the log, restart the container (`docker compose restart`) |
| No `Setup-Token` in the log | Setup completed, or stderr not captured | `docker logs roedy-mail 2>&1`; `roedy-mail setup-token` tells whether the setup is completed |
| Sign-in fails without a message, you end up on the sign-in page again | Access via `http://` (the cookie is `Secure`) | Use HTTPS |
| Audit log and "Signed-in devices" show the same address for everyone (Docker network or proxy), sign-ins are blocked for everyone together | `ROEDY_TRUST_PROXY` missing, set to empty or too small, or the proxy does not append `X-Forwarded-For` | [Reverse proxy](#reverse-proxy); check `trust_proxy` in the startup log |
| Every change fails with 403 `csrf` | Proxy removes `X-Requested-With` | Pass request headers through |
| Reading calls fail with 403 `csrf` | Proxy sets or changes `Sec-Fetch-Dest` | Pass `Sec-Fetch-*` through unchanged |
| Uploading a logo fails with 413 | Proxy limit (nginx: 1 MB) | `client_max_body_size 2m;` |
| First load on mobile is slow | Proxy does not compress | `encode` (Caddy) or `gzip` (nginx) |
| Still the old web app after an update | Proxy caches `/` or `/service-worker.js` | Pass the backend's cache headers through |
| "Add account" reports "CORS not enabled", diagnostics report errors | Stalwart not prepared | [`stalwart.md`](setup/stalwart.md) |
| Mail accounts show "Sign-in required" | Refresh token expired (account not used for a long time), OAuth client registered again, client secret added to a public client ([manual client](setup/stalwart.md#manual)), backup restored or Stalwart migrated | "Sign in again"; [token lifetimes](setup/stalwart.md#token-lifetimes) |
| Log `… cannot be decrypted – do ROEDY_SECRET_KEY or secret.key match this database?` (push: `… not decrypted`), mail accounts, sender account and push do not work, `/readyz` is fine nonetheless | different instance key than when saving | Use the correct [key](#instance-key) and restart |
| Authenticator app codes are rejected | Host clock is wrong | Set up NTP |
| Port 8080 in use | Stalwart or another service on the same host | Change the host port in `compose.yml` ([Stalwart on the same host](#reverse-proxy)) |

### Lost access

If an administrator has lost the password, or the authenticator app and the recovery codes:

```sh
docker exec roedy-mail roedy-mail reset-admin --user admin@example.com
```

The command sets a new random password (it only appears in the output), removes authenticator apps and recovery codes (including the ones from the setup), ends all sessions and unlocks the account. Then sign in with the printed password, change it under Account › Security and set up the authenticator app again. Other users reset their password on the sign-in page via "Forgot password?" (this needs system emails); if they have lost the authenticator app and recovery codes, an administrator resets the multi-factor authentication under Administration › Users.

## Further guides

| Guide | Content |
|---|---|
| [`docs/setup/stalwart.md`](setup/stalwart.md) | Preparing Stalwart: address, CORS, OAuth client, allow list, reverse proxy in front of Stalwart, sender account, token lifetimes, trash and spam, JMAP limits, push, Sieve, diagnostic reasons |
| [`docs/setup/administration.md`](setup/administration.md) | Administration in the app: system email and templates, branding, organization, banner, audit log, updates, maintenance with backups and storage, developer |
| [`docs/setup/notifications.md`](setup/notifications.md) | Notifications at the bell, by email and web push, VAPID keys, push for new emails |
| [`docs/setup/app.md`](setup/app.md) | Installed app, start without network, emails on the device, language |
| [`SECURITY.md`](../SECURITY.md) | Reporting security vulnerabilities |
