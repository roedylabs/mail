# Notifications: bell, email and web push

> Covered are the three channels with their requirements, the VAPID key for web push, push for new emails, the schedule of the background jobs and troubleshooting. Installed app, start without network and language: [`app.md`](app.md).

Roedy Mail reports events of the app account in three ways; new emails come separately, directly from the mail server ([New emails](#new-emails)). Every user configures them for themselves under **Settings › Notifications**: tabs "Channels" (globally on or off), "Topics" (channels per topic) and "Delivery" (quiet hours, email digest, sound). What the administrator must provide for this is described under [Requirements](#requirements). All three come in the recipient's language as chosen in their settings ([Web app › Language](app.md#language)).

## Overview

| Channel | Route | Default |
|---|---|---|
| In the app | Bell at the top right. The app polls every 60 seconds while the tab is visible, also when opening the bell, when returning to the tab and as soon as a push arrives; with the app open, optionally with sound. | on, all topics |
| Email | Via the sender account of the system emails, every notification individually ("Instant") or as a daily or weekly digest. | on for Security and Account, daily digest |
| Push | Web push to every signed-in browser, also with the app closed; a click opens the target in the app. | off; when turned on, initially only for Security |

| Topic | Events | For |
|---|---|---|
| Security | New sign-in, password changed or reset, email address change, multi-factor reset, authenticator app added or removed, recovery codes used or renewed | everyone |
| Account | Profile changed, email address confirmed, "Storage almost full" | everyone |
| Team | Invitation accepted, new invitation requested, role changed, user locked | administrators only |
| System | Updates, backups, maintenance mode ([Administration](administration.md)) | administrators only |
| News | Welcome after setup or invitation; "New in version …" follows with the updates | everyone |

**Security** always comes in the app and by email; only push is selectable for it. Security notices are separate emails that go out immediately, regardless of digest and quiet hours. Only administrators see **Team** and **System**; whether someone is an administrator is, for email and push, only evaluated at sending time. Channels and status are evaluated at sending time as well: whoever has turned off a channel in the meantime or is locked no longer gets the queued message.

## Requirements

- **HTTPS:** Signing in needs it anyway ([Operations › Configuration](../ops.md#configuration)). Service worker and push are likewise only available in the browser in a secure context (HTTPS or `localhost`).
- **Public address** (`ROEDY_PUBLIC_URL`, required for the server to start, [Operations › Configuration](../ops.md#configuration)): the emails link into the app. Push names it to the push services as the contact (`sub` in the VAPID token).
- **System emails** for the Email channel: a sender account as in [Stalwart › Sender account for system emails](stalwart.md#sender-account-for-system-emails). Without system emails, due entries are dropped; entries not yet due wait.
- **Outgoing HTTPS (port 443) to the push services:** Every browser registers an endpoint with its push service; the server sends to it. Typical are (without guarantee of completeness; what counts is the endpoint the browser reports):

  | Browser | Push service, typical host |
  |---|---|
  | Firefox | Mozilla autopush, `updates.push.services.mozilla.com` |
  | Chrome and many Chromium browsers | Firebase Cloud Messaging, `fcm.googleapis.com` |
  | Edge | Windows Push Notification Services, `*.notify.windows.com` |
  | Safari (macOS, iPhone, iPad) | Apple Web Push, `web.push.apple.com` |

  The server connects **directly, without an HTTP proxy** (variables such as `HTTPS_PROXY` do not apply to this), and **only to public addresses**: if a name resolves into a private network, for example with a DNS filter that answers `0.0.0.0`, no connection is made (SSRF protection). Timeouts: 5 seconds for the connection, 10 for the request. Push needs nothing incoming: the push services keep their own connection to the browser.
- **Reverse proxy:** A proxy with its own sign-in exempts `/branding/push-icon.png` (icon of the messages; the server delivers it without sign-in) like `/branding/mail-logo.png` for the emails; whether a browser sends the proxy's sign-in along when loading the icon is untested. The service worker itself is at `/service-worker.js` at the root (scope `/`) and needs no special headers; the server delivers it as `text/javascript` with `Cache-Control: no-cache` like all files outside `/_app/immutable/`. A proxy should neither rewrite it nor cache it longer, otherwise changes reach the browsers late.

## VAPID keys

With VAPID (RFC 8292) the server identifies itself to the push services. There is nothing to set up:

- **Creation:** on first need – when a browser turns on push (`GET /api/v1/push/vapid-public-key`) or the server sends for the first time. It generates a key pair (ECDSA P-256) and stores it in the database (`app_settings`, entry `vapid`), encrypted with the instance key (`ROEDY_SECRET_KEY`, `ROEDY_SECRET_KEY_FILE` or `/data/secret.key`). The log reports `VAPID key for web push generated` once. There is no `vapid.json` file.
- **Backup:** The key is stored in the same database as the subscriptions and, like all secrets, is only readable with the instance key. Back up both together.
- **Different instance key:** The server cannot decrypt the VAPID key and **does not replace it** (otherwise no subscription would be valid anymore). Push then fails: `GET push/vapid-public-key` and "Send test" respond with a server error (log `internal error: VAPID key for web push not decrypted`), the job `push_sender` reports `Job failed` with the same reason on every run in which there is something to send, and queued messages stay pending. The same affects the other secrets (sender account, OAuth clients, tokens of the mail accounts). Remedy: put the correct key back in place and restart the container.
- **Renewing:** There is no command and no setting for this; the server never replaces an existing key. Only a new database gets a new one (newly set up instance, backup of another instance). No push service accepts old subscriptions then. The app notices this on the next start with a session, after the next sign-in or when opening Settings › Notifications, unsubscribes the browser and subscribes it again with the new key – without asking for permission again.

## Push in detail

- **Subscription per browser and session:** When turning it on, the browser asks once for permission, then the app registers it with the server. The subscription belongs to the session and ends with it: sign-out, expiry, signing out a device and "Sign out all others" also end push on that device. After every sign-in the app re-registers a browser with permission by itself. If the channel is on (for example turned on on another device) and a browser with permission has no subscription yet, the app subscribes it silently at start, after sign-in and when opening Settings › Notifications; if that fails, the channel shows as off on this device and turning it on there subscribes it. Consequence for security notices: "Password reset" no longer reaches any device via push, "Password changed" only the changing one; the email about it always arrives.
- **Shared devices:** A browser always belongs to the most recently signed-in session, even that of another person. At most 20 browsers per person; beyond that the oldest are dropped.
- **"Turn off on this device"** (Push dialog under Settings › Notifications) unsubscribes this browser and turns off the Push channel for the whole account, on all devices. The "Push" switch under "Channels" toggles the channel for the whole account as well and unsubscribes this device's [new emails](#new-emails); the browsers stay subscribed. The other browsers keep their subscriptions; while the channel is off they receive no notifications from the server. Their [new emails](#new-emails) come directly from the mail server: a browser that stays open keeps receiving them until its next start, when it unsubscribes them.
- **"Send test"** only goes to the browsers of this session, regardless of channels and quiet hours, at most ten times in ten minutes per person (more frequent tests could make the push services throttle the key of the whole instance). If no browser is subscribed, the app re-registers it and tries again; if no push service accepts, the server responds with `502 push_failed`.
- **Endpoints:** only `https://`, without credentials in the address, at most 2048 characters; IP addresses only public ones, names are checked by the resolver on every connection. Otherwise the server rejects the subscription (`invalid`, `private`, with an expired `expirationTime` `expired`).
- **Sending:** Title, text and target as in the bell, icon `/branding/push-icon.png`; the same message goes to all of the person's browsers at once. The push service keeps it for 24 hours for a device without a connection (`TTL`), security notices with `Urgency: high`. The response decides about the rest:

  | Response of the push service | Consequence |
  |---|---|
  | 2xx | delivered |
  | 404, 410 | Subscription deleted (browser unsubscribed or expired), without a log entry |
  | 429, 5xx, no connection | temporary: new attempt after 5 minutes, at most three attempts |
  | anything else (such as 400, 403, 413) | rejected, no new attempt |

  If at least one browser accepted or no error was temporary, the message is done. Every run removes subscriptions with an expired `expirationTime`. The log only names the host of the push service, never the endpoint (it is the device's address).
- **Browsers:** Firefox, Chrome and Edge on the desktop as well as Safari on macOS support web push; desktop browsers usually only receive while they are running. On **iPhone and iPad** Apple only offers web push to web apps on the home screen (from iOS or iPadOS 16.4); in the browser the app therefore shows "Add to Home Screen first". Roedy Mail ships the web manifest needed for this since v0.8.0 ([installed app](app.md)).
- **Test status:** Push is tested against a push service in tests, the example from RFC 8291 and Chromium without a push service. It is not yet tested against the real push services (Firefox, Chrome, Safari, iPhone/iPad).

## New emails

New emails are not reported by Roedy Mail but by the mail server directly to the browser ([Stalwart › Push for new emails](stalwart.md#push-for-new-emails)). The backend is not involved and stores nothing about it.

- **Switch:** Under **Settings › Notifications**, tab "New emails", there is one switch per mail account. It only applies to this device; the default is off. It requires the active Push channel on this device. Only the inbox is reported; emails that a rule puts into a folder or into spam do not appear.
- **Channel off:** If someone turns off the Push channel or push on this device, the app unsubscribes this device's subscriptions at the mail servers. The selection stays and applies again as soon as the channel is active here. Another device notices this on its next start.
- **Content:** One email shows sender and subject, several show "‹n› new emails" with the senders, with several mail accounts also the account. The mail server's message only names IDs; the browser fetches sender and subject itself, and the push service sees nothing of it. A click opens the conversation, for several emails the inbox.
- **Without a session:** If the sign-in has expired or the server does not respond, only "New email" with the account appears, because browsers require a visible notification for every message. If the mail account needs to sign in again, "Sign-in required" appears once.
- **Quiet hours:** New emails appear immediately, but without sound and vibration; they cannot be held back, because the push bypasses the backend. The browser works with a copy of the quiet hours that only picks up changes from another device once the app has been open here again. "Sound" under "Delivery" only applies in the app.
- **App visible:** Then nothing else appears; the list syncs immediately.
- **Expiry:** A subscription is valid at the mail server for at most 7 days. The app renews it on every start, the browser when an email arrives. If the app stays closed for 7 days and no email arrives in the inbox during that time, it expires; the row then shows "Expired" if the renewal fails on the next start.
- **Language:** The service worker writes the notification in the language the app last had on this device ([Web app › Language](app.md#language)).
- **Test status:** Tested are the service worker in Chromium with delivered messages and the subscriptions against a local Stalwart. Stalwart only sends to public hosts; delivery via real push services, the effect of "without sound" per browser and iPhone/iPad are not yet tested.

## Schedule

| Job | Interval | Task |
|---|---|---|
| `push_sender` | first run after 1 minute, then every minute; additionally right after every event with push | Send push: security immediately, otherwise outside quiet hours; again after 5 minutes, at most three attempts |
| `notification_mailer` | after 1 minute, then every minute | Due emails ("Instant" and digests); after a sending error again after 30 minutes, at most three attempts |
| `quota_check` | after 15 minutes, then hourly | Storage of every signed-in mail account of active users at most once in 24 hours; from 90 % "Storage almost full" |
| `notification_cleanup` | after 5 minutes, then daily | Delete notifications older than 90 days and beyond the newest 200 per user |

The intervals count from the process start, with up to 10 % jitter; the jobs have no fixed times. Fixed times only apply to the digest, in the user's time zone (Settings › Language & region):

- **"Instant":** every notification as its own email (template `digest_instant`), usually within a minute.
- **"Daily"** (default) at 07:00, **"Weekly"** on Mondays at 07:00 (template `digest`), with everything since the last digest – including read items and items removed from the bell; the email lists at most the newest 50 entries. If 07:00 falls into the quiet hours, it arrives at their end. There is no stored appointment: changed settings apply on the next run; after an outage the next run catches up on the digest.
- **Quiet hours** (off by default, suggested 22:00–07:00): the start belongs to them, the end does not, also across midnight; start equal to end counts as no quiet hours. During this time no emails (neither "Instant" nor digest) and no push messages go out. Whatever was held back arrives at the end: "Instant" emails and push messages individually, oldest first. **Still immediately** arrive security notices by email and, if chosen, by push; the bell shows everything immediately.
- **"Storage almost full":** The job `quota_check` queries every mail account with the status "signed in" at most once a day, first 15 minutes after the start. From 90 % it reports once per crossing; once storage is below again, it reports the next crossing again. A failed attempt counts too (the next follows the next day; the reason is only in the log). It does not check accounts with "Sign-in required".
- **Retention:** In the bell notifications stay for 90 days, at most the newest 200 per user, read or not. Queued emails and push messages stay until sent; removing in the bell takes nothing out of the digest.

## Troubleshooting

The jobs write to the container's log (default JSON, one line per event):

```sh
docker logs roedy-mail 2>&1 | grep -E 'Push|push|VAPID|Notifications|System mail|Storage'
```

| Message | Meaning |
|---|---|
| `push service not reached` (`host`) | no connection: firewall, DNS, mandatory proxy; new attempt after 5 minutes |
| `push service did not accept the message` (`host`, `status`) | 429 or 5xx: again later; other status: rejected |
| `push message dropped after 3 attempts` | three temporary errors in a row |
| `Job failed` (`job` = `push_sender`) | for example VAPID key not decrypted ([above](#vapid-keys)) |
| `System mail not sent` (`template` = `digest` or `digest_instant`, `reason`) | sender account, reasons as in [Stalwart › Sender account](stalwart.md#sender-account-for-system-emails) |
| `notifications by email dropped after 3 attempts` | three sending errors; the cause is in the log as well |
| `no public address, notifications by email are dropped` | public address missing |
| `storage not checked` (`account`, `reason`) | `quota_check` could not read the storage |

Missing system emails are only reported at level `debug` (`no system mail configured, notifications by email are dropped`): `ROEDY_LOG=info,roedy_mail_server=debug`.

Typical causes:

1. **Channel or topic off:** Push is off by default and afterwards only on for Security; choose further topics under "Topics". For Team and System, check whether the person is still an administrator.
2. **Browser not subscribed:** The Push dialog must show "Active on this device"; "Send test" checks the route up to the device. After signing out and in, the app re-registers the browser by itself; otherwise open Settings › Notifications.
3. **Permission denied:** The dialog shows "Blocked by the browser"; allow notifications in the browser's site settings. The operating system can also suppress the browser's notifications.
4. **No HTTPS:** Without HTTPS (except `localhost`) the sign-in already fails because of the `Secure` cookie; behind a proxy, check whether the app is really served via `https://`. If the Push dialog reports "Not supported", the browser lacks web push (for example an outdated version); on iPhone and iPad in the browser instead of as an app it shows "Add to Home Screen first".
5. **Push service not reachable:** Log `push service not reached`. The image has no shell; so check the hosts above from the container's host and look at the firewall, a mandatory outgoing proxy and DNS filters.
6. **iPhone or iPad:** Push only as an app on the home screen (see [Browsers](#push-in-detail)).
7. **Quiet hours:** Email and push only arrive at their end, in the person's time zone; only Security arrives immediately.
8. **Emails missing:** System emails set up, public address set? Digests only go out at 07:00 or on Mondays; `system mail sent` with `template` = `digest` in the log shows the sending.
9. **"Send test" fails:** `502 push_failed` means no push service accepted (log); after ten tests in ten minutes the server throttles.
