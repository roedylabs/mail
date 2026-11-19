# Administration: pages, requirements and troubleshooting

> Covered are Email, Branding, Organization, Banner, Audit log, Updates, Maintenance and Developer with what operations must provide for them, and troubleshooting; Users and Mail servers only appear in the overview. Not part of the interface are app passwords and API keys of the app account, single sign-on and the Beta switch on the Developer page.

The pages under **Administration** control the instance as a whole: sending, appearance, audit log, updates, backups. Everything that concerns a single person is under Settings and Account. Their settings live in the database in the data directory; the sections name what must be provided outside.

## Overview

Only administrators see the pages: the menu entry is missing for everyone else, a direct call shows "Access denied", and the endpoints under `/api/v1/admin/…` respond 403.

| Page | Path | Purpose | More |
|---|---|---|---|
| Users | `/admin/users` | Invite, edit and lock accounts | [Operations › Initial setup](../ops.md#initial-setup) |
| Organization | `/admin/organization` | Company details, support, legal notices | [below](#organization) |
| Branding | `/admin/branding` | App name, logo, brand color, sign-in page | [below](#branding) |
| Banner | `/admin/banner` | Own notice for all users | [below](#banner) |
| Mail servers | `/admin/mail-servers` | Allowed JMAP servers and OAuth clients | [Preparing Stalwart](stalwart.md) |
| Email | `/admin/email` | Sender account of the system emails, templates | [below](#email-system-email) |
| Audit log | `/admin/audit-log` | Trace changes and sign-ins | [below](#audit-log) |
| Updates | `/admin/updates` | Version and update check | [below](#updates) |
| Maintenance | `/admin/maintenance` | Maintenance mode, backups, storage | [below](#maintenance) |
| Developer | `/admin/developer` | Diagnostics in the browser; only with the "Advanced settings" switch in the navigation | [below](#developer) |

**Saving:** Organization, Branding, Banner and Email show the "Unsaved changes" bar with "Save" and "Discard". The toast afterwards offers "Undo"; the change only goes to the server once it has expired. Schedules, display and the maintenance notice have no button and apply after a short pause.

## Email: system email

Invitations, confirmation links, security notices and notifications go out through the sender account. How the account is created in Stalwart is described under [Stalwart › Sender account for system emails](stalwart.md#sender-account-for-system-emails). The initial setup only creates the administrator: set up the sender account here right after the setup, and change it here later.

| Section | Content |
|---|---|
| Status | "Connected", "No connection", "Not set up", "Not checked" or "Checking …", plus session, account, "Last checked" and the "Test connection" button. |
| Connection | Mail server from Administration › Mail servers; sign-in "Password" (ideally an app password from Stalwart) or "Token" (bearer token of the sender account). With "Token" the user name may stay empty. An empty field keeps the stored secret of the same sign-in method. Only the secret of the chosen sign-in method stays stored. |
| Sender | "Sender name" (at most 100 characters) and "Reply-to address" (at most 254), both optional. The address is that of the account's identity in Stalwart: the first one; the page has no selection. |
| Sending | "Save a copy to Sent"; otherwise the message is removed after sending. |
| Test | "Recipient", prefilled with your own address, and "Send". This only works after a successful connection test. |

**Checking:** "Test connection" signs in as before sending (session, identity, mailbox "Drafts") and stores nothing; it checks the inputs on the page. If they differ from the stored connection, its status stays unchanged. Saving checks a changed connection right away by itself.

**Status:** It also follows real sending. If a system email fails because of the connection (unreachable, sign-in rejected or locked, no permission, throttled, identity or mailbox missing), the page shows "No connection"; an error that only affects this one email does not change it. The notice bar "System emails not set up" for administrators only depends on whether an account with a secret exists on a server of the list, not on the status. There is no way to remove the sender account; if its server is deleted, it counts as not set up, and the other fields stay.

**Limits:** Test emails are limited per administrator to ten at once, then one per minute; only what actually goes out after a successful check counts. After five rejected sign-ins at one server within 15 minutes, Roedy Mail stops trying there for 15 minutes ([Stalwart › Sender account](stalwart.md#sender-account-for-system-emails)).

**Requirement:** System emails need the public address (`ROEDY_PUBLIC_URL`) for their links. It is changed via `ROEDY_PUBLIC_URL`; there is no field for it under Administration.

App password and token are stored in the database encrypted with the instance key and appear in no response, no log and no audit log entry.

### Templates

The section shows the emails as the server renders them: with the same templates, the current branding, the organization's footer and the time zone and formats of the signed-in administrator. The texts cannot be edited. Every template exists in German and English: the preview shows the interface language; emails are sent in the recipient's language, an invitation in that of the inviting administrator ([Web app › Language](app.md#language)).

| Template | Variants |
|---|---|
| Invitation | – |
| Reset password | – |
| Confirm email address | – |
| Security notice | New sign-in, No location, Password changed (also as sole administrator), Password reset, Email address change, Multi-factor reset, App added, First app added (also as sole administrator), App removed, Last app removed, Code used, Last code used, Code, new device, New codes generated |
| Notification digest | Summary, One item, Over 50, Instant |
| System notice | Backup, Update |

Above the preview are "Subject", "From" and "To"; you can switch between HTML and text, and for HTML also between light and dark. Emails are always sent light; dark only exists here. The recipient is the signed-in administrator for most templates; everything else is fixed sample data, so that the preview shows no real content. "From" stays empty as long as no identity is known, i.e. without a sender account, before the first successful check or after an error. The test email is not in the list.

## Branding

Four sections, saved together:

| Section | Fields |
|---|---|
| Name | "App name", at most 32 characters. |
| Logo | "Type": default, initials ("Characters", at most 2; empty = first letter of the name), icon (twelve to choose from) or image. For an image, "Size": Padded or Fill. Plus "Tile" (accent color, light, dark) and "Slightly tilted". |
| Brand color | Default accent color for everyone; "Allow custom accent color" enables the choice under Appearance. Turned off, this locks the choice; the users' stored color is kept. |
| Sign-in page | "Heading" (at most 48 characters, empty = "Welcome back"), "Text" (at most 120), "Background art". |

"Restore defaults" resets everything and removes the image.

### Upload

Allowed are PNG, JPG, WebP and SVG up to 1 MB (1,048,576 bytes). The page recommends square with at least 256 × 256 pixels; this is not checked.

- **Raster images:** The format is determined by the content, not by extension or declared type. At most 4096 pixels per side; the file must decode completely.
- **SVG:** An SVG with `<!ENTITY` or `<text>` is rejected, also in embedded SVGs; so convert text to paths beforehand. The server reads everything else and writes it anew: paths, groups, gradients, patterns, masks, filters and images as data URLs remain. Scripts, events, `foreignObject`, links, CSS imports and external references are dropped. Embedded images at most 4096 pixels per side, the result at most 2 MiB.

The image is stored in the database; older versions are not kept.

### Where branding appears

| Target | What | Route |
|---|---|---|
| Web app and sign-in page | Name, logo, color, texts of the sign-in page | `public/config`; uploaded logo under `/branding/image/<id>.<extension>` |
| System emails | App name, brand color, tile, mail logo as PNG (80 × 80) | `/branding/mail-logo.png?v=<version>` |
| Push | Icon as PNG (192 × 192); the app name only where the event's text mentions it | `/branding/push-icon.png?v=<version>` |
| Installed app | Name, brand color, tile, icons as PNG (180, 192 and 512 pixels) | `/manifest.webmanifest`, `/branding/app-icon.png`, `/branding/app-icon-maskable.png`, `/branding/apple-touch-icon.png`; public, a proxy with its own sign-in must let them through like the push icon. Already installed apps only pick up a change at the next check by the browser or the system. |

"Slightly tilted" only applies in the web app. The server draws the PNGs itself, on start and after every change, and keeps them in memory. `v` only makes image proxies reload: the routes always deliver the current image, so older emails show the new logo too.

**Requirement:** The emails embed the logo with the public address; mail clients load it from there without signing in. So this address must be reachable from outside, and a reverse proxy with its own sign-in must exempt `/branding/mail-logo.png` ([Operations › Reverse proxy](../ops.md#reverse-proxy)). The sign-in page and push need `/branding/image/…` and `/branding/push-icon.png` without sign-in as well.

## Organization and banner

### Organization

| Field | Limit |
|---|---|
| Name | single line, at most 120 characters |
| Website, help center, legal notice, privacy policy, terms of use, source code | Link with `http://` or `https://`, at most 2048 characters |
| Support email | Address, at most 254 characters |

Everyone sees the details under Settings › About; empty fields are hidden there. The emails' footer names the name (without a name, the app name), support email, legal notice and privacy policy; privacy policy and legal notice also appear on the sign-in page.

**Public:** `GET /api/v1/public/config` responds without sign-in. It contains the app name, branding (without the logo's file name), all fields of the organization, the banner while it is on, the maintenance mode with notice, the version, the update notice, the cache version and whether the setup is pending. Whatever must not be public belongs neither in the organization nor in the banner.

### Banner

| Field | Limit |
|---|---|
| Title | Required while the banner is shown; at most 40 characters |
| Text | optional, at most 140 characters; on smartphones only the title is visible |
| Link | optional, only `https://` with a dot in the host; shows a button |
| Label | at most 24 characters, empty = "Learn more" |
| Color | Accent color, Soft, Dark, Warning |
| Icon | Megaphone, Info, Warning, Event, New, Tool, Gift, Heart |
| Dismissible | Users can close the banner |

"Show banner" turns it on after a confirmation. It appears in the app's notice bar, not on the sign-in page. Open sessions show it after up to 60 s or when returning to the tab, without reloading.

**Closing per revision:** Every change, whether to the content or to the display, increases the revision. Whoever closes the banner stores the revision in their own account's settings. So it reappears after every change, also after turning it off and on again. Changes to a banner that is turned off are not in the audit log.

## Audit log

The audit log records changes and sign-ins in the database. It is not the container's log.

| Filter | Contains among others |
|---|---|
| Sign-in | Sign-ins, including failed ones, sign-outs, password, email address, profile, authenticator apps, recovery codes, signed-out devices |
| Users | Invitations, roles, locking and unlocking, deleting, multi-factor reset |
| Settings | Organization, branding, banner, email settings, mail server policy, token and schedule of the updates, backup schedule, retention |
| System | Setup, `roedy-mail reset-admin`, creating, changing, deleting mail servers, export of the audit log, updates, maintenance mode, compaction, backups |

Next to "All" and the filters are the hits per category. The search ("Person, action, or location") matches the displayed text case-insensitively and starts after a short pause; the newest entries are at the top, "Load more entries" fetches the next 100. The search goes through all entries within the retention period while other requests wait for the database.

Secrets never appear in the audit log, only the names of the changed fields. Names show the state at the time of the entry. As detail, an entry shows the location from the GeoIP database (`ROEDY_GEOIP_DB`), for sign-ins without it the shortened IP address, otherwise for example the size of a backup.

Not in the audit log are changes to the maintenance notice, turning on maintenance mode again while it is on, and a failed restore.

**Export:** "Export as CSV" delivers all hits of the current filter and search as `audit-log-YYYY-MM-DD.csv` with the columns `Time;Category;Person;Action;Details` (file name and column headers follow the interface language), every field in quotes, UTF-8 with BOM, line ending CRLF. Fields starting with `=`, `+`, `-`, `@`, tab or carriage return get a `'` in front, so that a spreadsheet does not execute them as a formula. The export itself appears in the audit log.

**Retention:** 30 days, 90 days (default) or 1 year, for all categories. List and export immediately only show entries within the period. Deletion only happens in the daily job `audit_retention`, not when saving; until then a period that is too short can be taken back, and the entries are there again.

## Updates

Roedy Mail checks the releases of the public repository [`roedylabs/mail`](https://github.com/roedylabs/mail/releases) on a schedule, reports new versions and notices a version change on start. **It installs nothing:** the operator installs the update as a new image.

- **Request:** The server only reads `GET /repos/roedylabs/mail/releases?per_page=30` on `api.github.com`. It needs outgoing HTTPS there.
- **No requests:** Turning off "Check automatically" stops the scheduled requests to GitHub. Roedy Mail still detects the version change on start.

### Access token (optional)

The check works without a token. GitHub allows unauthenticated clients 60 API requests per hour and address; a token raises the limit, which helps when many services share one outgoing address. A token (`ghp_…` or `github_pat_…`) needs no permissions beyond reading public repositories, for example a fine-grained token with "Public repositories" access. "Verify and save" asks GitHub first and only stores what GitHub accepts.

- **Storage:** The token is stored in the database encrypted with the instance key. The page only shows the beginning and the last four characters; "Remove" cannot be undone.
- **Limit:** "Check now" and new tokens share 20 requests at once per administrator, then one per 30 seconds.

### Schedule

"Check automatically" (on by default), "Frequency" hourly, daily (default) or weekly, "Day of the week" (Mon) and "Time" (03:00). The time applies in the time zone of the administrator who last changed the schedule; before that in `Europe/Berlin`.

The job `update_check` looks every minute. Without a previous check, one is due right away; missed dates are made up. A failed attempt also counts as a check; the next one follows at the next date.

**Which version counts:** Tags of the form `vX.Y.Z` from the last 30 releases, without drafts and pre-releases, compared by semver (0.10.0 is newer than 0.9.9). A failed check keeps the last known version.

### Notices

| Event | When | To | Email |
|---|---|---|---|
| "Update available" | A check finds a version newer than the installed one; once per version | active administrators | via the digest |
| "Update installed" | Start of a newer version | active administrators | own system notice, immediately, also during quiet hours; one attempt |
| "New in version …" | Start of a newer version | all active users | according to the channels of the News topic |

Both notices to administrators belong to the System topic; its email is off by default (Settings › Notifications). "New in version …" names the first item of the release notes if the check saw exactly this version, otherwise a general text. The first version of an instance does not count as an update, nor does switching back.

"Show update status" toggles the notice under Settings › About for everyone. It only appears if the state is known: not before a version was found, not after a failed check without a known newer version. The notice is also in `public/config`.

### Installing an update

With [`deploy/compose.yml`](../../deploy/compose.yml), `ROEDY_IMAGE_TAG` in the environment or in `.env` next to the file sets the version (default `latest`, for predictable updates a fixed version such as `0.1`):

```sh
docker compose -f deploy/compose.yml pull
docker compose -f deploy/compose.yml up -d
```

`pull` is Compose's usual form of what the page calls "Pull the new image and restart the container". The server applies pending database migrations by itself on start.

Before that, "Back up now" under Maintenance: an older version no longer starts once the schema is newer than itself, and a backup can only be restored with a version that knows its schema.

## Maintenance

### Maintenance mode

The switch locks the app for everyone except administrators.

- **Turning it on** asks for confirmation and in one step ends the sessions of all users without administrator rights, and with them their push subscriptions. Individual sign-outs are not in the audit log; the entry names the number of ended sessions.
- **During maintenance** sign-in and accepting an invitation fail for everyone without administrator rights; the page shows the notice. An open page notices the end of the session after up to 60 s and switches to the sign-in page with the notice, without reloading. Administrators keep working and see the notice bar "Maintenance mode". Background jobs keep running, and the mail server stays untouched. Rejected requests only appear in the log at level `debug`.
- **Turning it off** allows sign-in again. An open sign-in page loses the notice after up to 60 s. Ended sessions do not come back; the users sign in again.
- **"Notice for users":** up to 500 characters, multi-line, appears on the sign-in page while maintenance is running. Empty or with "Default text", "We’re performing maintenance right now. Please try again in an hour." applies. The notice is saved without a button and is in `public/config`, so it is public.

Every switch is recorded in the audit log and goes as an event to all active administrators, including the acting one.

### Backups

Procedure, location, key and manual restore are described in [Operations › Backup and restore](../ops.md#backup-and-restore). Here is what is missing there.

**Usage:** "Back up now" creates a manual backup. The list shows time, size and type ("Automatic" or "Manual") with "Download", "Restore" (confirmation by typing the word `RESTORE`, translated in other interface languages) and "Delete" (with "Undo" in the toast). "Restore" only works in maintenance mode: until then it is locked (on the desktop with the tooltip "Only possible in maintenance mode"), and above the list the notice "Restore only in maintenance mode" offers "Turn on maintenance mode" with the usual confirmation. An older backup without an authenticity value (format 1, see below) can never be restored: its row adds "Older version, can’t be restored", and "Restore" stays locked, also in maintenance mode (on the desktop with the tooltip "Comes from an older version and can’t be restored", which takes precedence over the one about maintenance mode). The schedule has "Back up automatically", "Frequency" (daily, weekly) and "Keep for" (7, 30 or 90 days).

**Schedule:** There is no fixed time of day. The interval of 24 hours or 7 days counts from the last scheduled backup; without a previous one, a backup is due right away. A failed attempt counts too.

**Not included** are:

| What | Where it stays |
|---|---|
| `secret.key` or `ROEDY_SECRET_KEY` | keep separately; without it the restore rejects the backup |
| Emails, mailboxes, contacts | on the mail server; Roedy Mail only backs up its own database |
| Environment variables, Compose file, `.env` | with the operator |
| GeoIP database | separate volume |
| Container logs | Docker |
| other backups | `<ROEDY_DATA_DIR>/backups` |

A file contains exactly `manifest.json` and `roedy.sqlite3`. The manifest (format 2) names format, program and schema version, time, type, a fingerprint of the instance key and an HMAC-SHA-256 with the instance key over all these fields (each with its length in front) and the SHA-256 of `roedy.sqlite3`. The restore checks the HMAC in constant time and rejects a file whose database or manifest was changed, even if the fingerprint was copied from a real backup; the fingerprint only decides whether the error names a different key. Files in format 1 (without HMAC) are marked `legacy` in the list (`GET /api/v1/admin/backups`) and rejected like a changed file, with 422 `backup_unverified`. The database unpacks to at most 64 times the size of the file, but always to 64 MiB; beyond that the restore stops and deletes what it unpacked. The limit counts everything unpacked, not only the database, and creating a backup fails if its database would exceed it. Secrets such as the credentials of the mail accounts and authenticator apps are encrypted individually in it; names, addresses and the audit log, however, are readable. The files have mode `0600`. That no longer applies to the copy after downloading.

**Download** delivers the file directly, without caching, and is recorded in the audit log. There is no upload in the browser: a file comes in from outside by putting it into `<ROEDY_DATA_DIR>/backups`. It must keep its name (`roedy-mail-<time>-auto|manual-<ulid>.tar.zst`), be a regular file and stay readable for user 65532.

**Space:** A backup first writes the snapshot and the archive to `backups/.tmp-…`, so it needs the size of the database plus that of the archive there. Restoring needs about twice the size of the database (working copy and `-wal` file) and otherwise fails before it changes anything. The next start cleans up leftovers after a crash.

**Retention:** It only runs after a successful scheduled backup and only affects automatic ones. If backups are turned off or fail, the existing ones stay.

**Notices:** Events only exist for scheduled backups, to all active administrators in the System topic. "Backup created" can trigger the system notice "Backup completed", "Backup failed" comes via the digest. Email is off by default for this topic. The cause of a failure is only in the log. Only one backup or restore runs at a time; meanwhile nothing can be deleted either.

**After a restore**, in addition to [Operations](../ops.md#backup-and-restore): all sessions except your own end, and with them the web push subscriptions. Notification emails already sent since the backup may arrive again. The audit log is not reset: entries since the backup (such as downloads of backups and exports of the audit log) stay, plus the entry about the restore. Entries of people the backup does not know keep their name, but no longer link to a user.

### Storage

The rows "Database", "Backups" and "Logo files" show the space used. The database counts without the logos stored in it, but with free pages; the `-wal` file does not count.

"Compact" asks for confirmation and runs `VACUUM` followed by a checkpoint, so it returns free pages to the file system.

- **Space needed:** Briefly twice the size of the database, once in `/tmp` and once as the `-wal` file in the data directory.
- **`/tmp`:** Writable in the image (`1777`); in `deploy/compose.yml`, because of `read_only: true`, a tmpfs with Docker's default, so the copy is held in memory there. Your own Compose file with a read-only file system also needs a writable `/tmp`.
- **Duration:** Requests and jobs wait for the database meanwhile.
- **Failure:** If the space is not sufficient, the call responds with an error, and state, time and audit log stay as they were.

The page's text announces that browsers renew their local cache afterwards. For that, the server increases the version in `public/config` (as after restoring a backup). Browsers then clear the cache of the app shell and the stored emails on the next fetch of the configuration and load both again; pending offline changes stay ([Web app › Cache](app.md#refreshing-and-clearing-the-cache)).

## Developer

The page is purely diagnostics in the browser, only visible with "Advanced settings". It changes nothing about the server's operation; its log level stays `ROEDY_LOG`. It helps when a problem only occurs in one browser or a bug report is needed.

| Area | Function | Applies to |
|---|---|---|
| Diagnostics | "Debug mode" shows the debug bar at the bottom left: layout, window size, current path without tokens from mail links. Only administrators see it. | your own account, on every device |
| Diagnostics | "Log level" (Error, Warning, Info, Debug; default Info) only filters the display of the log below. | your own account, on every device |
| Log | Events of this session: start, notices, navigation (Debug), browser errors, connection, error pages. At most 120 entries, the page shows 60; "Copy" takes all of the chosen level, "Clear" deletes. | only this tab; empty after reloading, goes nowhere |
| Testing | "Error pages": preview of 404, 403, 500 and offline. | – |
| Testing | "Simulate offline": all requests fail as without network. End it with the switch or "End simulation" in the notice bar. | only this tab; reloading ends it |
| Testing | "Session expiry" shows the dialog after a longer inactivity. "Sign in again" really signs out. | your own session |
| Testing | "Log an error" writes a test entry at the Error level. | only this tab |
| Environment | Version with build, layout, screen, view, browser, time zone, language; "Copy" for bug reports. | – |

"Log" here means the browser's session log, not the page Administration › Audit log and not the container's log.

## Troubleshooting

The causes are in the container's log:

```sh
docker logs roedy-mail 2>&1 | grep -E 'System mail|Sending account|test email|logo|update|backup|checkpoint|internal error'
```

Details about GitHub only appear at level `debug`: `ROEDY_LOG=info,roedy_mail_server=debug`.

| Symptom | Cause | Remedy |
|---|---|---|
| Notice bar "System emails not set up", status "Not set up" | No sender account, or its server was deleted | Choose a server, enter credentials, save |
| "Can’t reach the server. Check the address." | `unreachable`: address, DNS, firewall | Check the mail server, see [Stalwart › Server address](stalwart.md#server-address) |
| "Sign-in failed." | `auth_failed` or `forbidden`: app password changed, token expired or revoked | Enter the credentials again |
| "Too many failed attempts. Try again in …." | `auth_locked`: five rejected sign-ins in 15 minutes | Wait, correct the credentials first |
| "That didn’t work. Please try again." on "Send", log `test email: no public URL` | No public address | Set `ROEDY_PUBLIC_URL` |
| The same, log `System mail not sent` with `reason` | Error of only this email, such as `not_created` | Reasons under [Stalwart › Sender account](stalwart.md#sender-account-for-system-emails) |
| "Too many attempts." on "Send" | Limit of the test emails | Wait a minute |
| "Send" not possible | Hint "Available after a successful connection test." | "Test connection" |
| Logo missing in emails, the header shows the tile | Log `Branding logo not drawn`: the route responds 404 | Replace the image |
| Logo missing in emails, the route delivers it in the browser | Public address not reachable from outside, or a proxy requires a sign-in | Exempt `/branding/mail-logo.png` |
| "The file couldn’t be read." for the logo | File damaged, over 4096 pixels per side, SVG with `<text>` or `<!ENTITY` | Export smaller, convert text to paths |
| "Check failed" with "The access token is invalid or expired." | `token`: 401 from GitHub, or log `update token not readable` after a different instance key | Replace or remove the token |
| "Check failed" with "The access token can’t access …" | `no_access`: 403 or 404 from GitHub | Use a token that can read public repositories, or remove it |
| "GitHub is rate-limiting requests right now." | `rate_limited`: the hourly limit of the outgoing address is used up | Try again later, or store a token for a higher limit; log `update check failed` |
| "GitHub can’t be reached right now." | `unreachable`: no outgoing HTTPS to `api.github.com`, or unusable response | Check firewall and DNS; `debug` shows the reason |
| "Invalid token or no access to …" when saving | Wrong format, or GitHub responds 401, 403, 404 | Check the token; it was not saved |
| "GitHub isn’t responding right now. The token wasn’t saved." | Rate limit or GitHub not reachable | Try again later |
| No status under About | Display off, automatic check off, no version known yet, or check failed without a known newer version | Check Administration › Updates |
| Start fails: `The database schema (version …) is newer than this program version` | An older version on a newer database | Start the newer version; going back only with a backup from before, by hand as in [Operations](../ops.md#backup-and-restore) |
| Button "Running …" | A backup or restore is already running (`backup_running`) | Wait; the page checks again by itself |
| "Back up now" reports the general error, entry "Backup failed" | Log `internal error`, for scheduled backups `backup failed`: no space or no permissions in the `backups` directory | Free up space, check owner `65532` |
| "Maintenance mode is no longer on. …" after "Restore" | 409 `maintenance_required`: maintenance mode was turned off in the meantime, for example by another administrator, at the latest before the backup was copied. Nothing was changed; the page shows the switch as off again. | Turn on maintenance mode and restore again |
| "This backup comes from an older version or was changed …" after "Restore" | 422 `backup_unverified`: the authenticity value is missing (format 1; the list marks such a backup and locks "Restore") or does not fit (manifest or database changed after the backup was created; log `backup not authentic`). Nothing was changed. | Use another backup |
| "Restore" reports another error | 422 `backup_invalid` (damaged; log `backup not readable`, `backup database not readable` or `backup database larger than the limit`), 409 `backup_newer` (from a newer program version), 409 `backup_other_key` (different instance key) each with a text of their own, 500 (for example no space) with the general error. In each of these cases nothing was changed. | Use another backup, update the program, use the matching key or free up space |
| Copied backup missing from the list | Name changed, or not a regular file (link) | Use the original name, a file instead of a link |
| Backups do not load, Storage shows none | Log `backups not readable`: permissions on the directory | Check owner `65532` |
| Mailbox looks empty after a restore, tile with a dot, the email account shows "Sign-in required" | The stored refresh token is older than the rotation in Stalwart; the mailbox itself does not show the state yet | "Sign in again" under the email account |
| "Compact" reports the general error | Log `internal error`: no space in `/tmp` or in the data directory | Free up space, check the size of the tmpfs |
| `-wal` file stays large after compacting | Log `checkpoint blocked, the -wal file stays large for now` | Compact again later |
| Entries missing in the audit log | Older than the retention (a restore keeps the audit log, but brings back the retention setting of the backup) | Check the period; before the deletion run it can be taken back |
| App shows "Offline" despite a connection | Offline simulation of the Developer page | "End simulation" in the notice bar or reload the tab |
| New emails only arrive after up to a minute, the browser reports no outage | Only the mail server was gone: after errors, sync falls back to polling every minute, push is only retried after 5 minutes. If the browser itself reports the end of an outage, the app syncs immediately. | Wait or reload the page |
