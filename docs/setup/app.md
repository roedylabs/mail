# Web app: installed app, offline and language

> Covered are the installable app with manifest and icons, the start without network, emails on the device, actions and drafts without a connection, renewing the caches and the languages English and German. New emails via push are described in [`notifications.md`](notifications.md#new-emails).

The web app runs in the browser or as an installed app (progressive web app) from the home screen or the start menu. Both are the same app from the same server; there is no separate package for app stores.

## Requirements

- **HTTPS:** Service worker, installation and push only exist in a secure context, i.e. via HTTPS or `http://localhost`. Signing in needs it anyway, because the session cookie is `Secure` ([Operations › Configuration](../ops.md#configuration)).
- **Own origin:** The app needs the root `/` of its origin (`start_url` and `scope` are `/`). It does not support a sub-path; it does not run there at all. `ROEDY_PUBLIC_URL`, which the server requires, is this origin ([Operations › Configuration](../ops.md#configuration)).
- **Reverse proxy:** `/manifest.webmanifest`, `/service-worker.js`, `/branding/…` and `/_app/…` must reach the backend unchanged. The backend sets the cache headers itself: files under `/_app/immutable/` one year (`immutable`), everything else `no-cache` with ETag. A proxy must not cache `/`, `/service-worker.js` and the manifest longer, otherwise new versions and a changed branding arrive late.
- **Production build only:** The service worker only caches in the built app (image or `ROEDY_WEB_DIR`). In the Vite dev server the cache stays off.

## Installed app

**Manifest:** The backend builds `GET /manifest.webmanifest` per request from the branding: name of the app, brand color as `theme_color`, the logo's tile as `background_color`, `display: standalone`. The icons (192 and 512 pixels, a `maskable` variant for Android and an `apple-touch-icon` with 180 pixels for iOS) are made from the logo, like the mail logo and the push icon ([Administration › Branding](administration.md#where-branding-appears)). If the branding changes, the icons' addresses change; installed apps pick this up the next time the browser checks the manifest. When that happens is up to the system.

**Installing:** Chrome and Edge offer "Install app" in the address bar or in the menu, Android "Add to Home screen" or "Install app", Safari on iOS and iPadOS "Add to Home Screen", Safari on macOS "Add to Dock". Whether a browser installs web apps depends on browser, version and system.

**Device list:** Sessions that start in the installed app are listed under Account › Security with the app's name and the system. On Android and on the desktop the app shares the cookies with the browser: if you were already signed in in the browser, the entry keeps the browser's name (such as Chrome on Android) until the next sign-in in the app. Notice emails about new devices keep naming the name from the user agent.

**`mailto:`:** The installed app registers as a handler for `mailto:` links (`/compose/new?mailto=…`). Whether it becomes the default is decided by the system or the browser. If you are signed out, you land on the sign-in page, and the link is lost.

**Connecting a mail account:** Signing in at the mail server opens its page. If the system opens it in a separate window, the return still finds the attempt (it is stored in the installed app's `localStorage`). On iOS the system separates the app from the browser; if the return lands in the embedded Safari there, it finds neither session nor attempt. Whether this happens is not yet tested on real devices; then connect the mail account in the browser, it then applies in the app as well.

## New version

After an update the browser fetches the new service worker on the next load; open tabs and installed apps check every 5 minutes while the page is visible, when returning and after an offline phase. The new service worker fills its cache, takes over immediately and deletes the caches of older versions. Open tabs reload after the next navigation; there is no notice. Pages always come from the server first, so a faulty service worker does not keep the app stuck on an old version.

## Starting without network

- **App shell:** The service worker puts all files of the version into the cache `roedy-mail-shell-<version>` (about 3 MB). Pages come from the server first and only from the cache without a response or after 4 seconds. `/api`, the mail servers and `/branding` never go through the cache.
- **Startup copy:** For signed-in accounts the `localStorage` holds a copy of configuration, user, mail accounts and settings, without tokens. If the server does not respond on start (network error or 5 seconds), the app starts from it and then checks every minute. An error response from the server still shows the error page.
- **Guests** have no copy; without network the app shows the error page "Offline" from the cache.
- **Notice bar:** Without a connection it reports this, with pending changes also their number. If the browser reports that the connection is back, the app syncs immediately; if only the server fails without the browser noticing, sync follows the polling interval (on average about one minute).

## Emails on the device

The app stores mailboxes, lists and conversations in IndexedDB, one database per app user. It reads from the store first and syncs with the mail server in the background; the server wins.

| What | Limit |
|---|---|
| Lists | at most 200 conversations per list and 30 lists per mail account, roughly 10 MB per account; the oldest go first |
| Bodies | opened conversations and the top 20 of every shown list (not in the browser's data saver mode); up to 4 MiB per conversation, 32 MiB and 500 conversations per mail account, the least recently used go first |
| Attachments | never; without a connection they are locked |

- **Search without a connection:** If the mail server does not respond, the app searches the stored emails (list rows and conversation details, including attachment file names).
- **Accounts with "Sign-in required"** and blocked servers only show what is stored; the app rejects changes to them with a notice.
- **Eviction by the browser:** Under storage pressure the browser may delete the data, Safari also after seven days without a visit (except for installed apps). The app then loads as the first time.

## Working offline

**Actions:** Read, star, tags, move, spam, archive and delete to trash go into a queue without a response (separate database `roedy-mail-queue:<user>`) and are replayed as soon as the account responds again, at the end of an offline phase, on the poll every minute (only while the page is visible) or with "Try again". What counts is the failed attempt, not the browser's "offline" status. "Delete permanently", "Empty Trash" and everything that sends something do not go into the queue.

**Conflicts:** The server wins. Read, star and tags know no conflict; they only set a final state. If another device has deleted an email in the meantime, the replay discards all own changes to it; if it has moved it, it only discards the own move, so that the email does not end up in two folders. The notice bar "Not synced" names the number, for a single one the subject.

**Drafts:** Without a connection, compose saves to the device; the replay creates the draft on the mail server and then deletes the previous version. If another device has changed, deleted or sent the draft in the meantime, the offline version is kept as a separate draft, and the notice bar "Two versions" says so. Send and "Send later" are locked as long as no connection is known or a version is pending; attachments can only be uploaded with a connection. Compose opens a draft that only exists on the server without a connection from the emails on the device if it is stored there completely – with the full body and known Bcc –, otherwise "No connection" appears. The prefetch puts it there when "Drafts" is shown (the top 20 conversations); an entry that was stored there before this version and does not know the Bcc yet is only fetched again after a change to the draft, and opening it in compose with a connection stores nothing; continuing to write then goes into the queue as usual, and attachments are kept via their files on the server. With a connection, every save creates the draft anew and only then deletes the previous one; if the mail server rejects the creation, the previous state is kept and an error toast reports it.

**In the list before the replay:** Emails moved offline already appear in the target folder if the app knew their row from a loaded list (not after an action from the search); drafts created offline appear in "Drafts" (not in tags) and open compose. Actions on such a draft (star, delete, move) only work after the replay; in a selection it is left out.

**Offline or not:** The notice bar "Offline" appears when neither the backend nor any mail server responded last, and disappears with the first response. The browser's report only counts until a request shows something; so in a network without a default route (isolated LAN, where Chromium reports "offline") the bar does not stay permanently. Without an event from the browser, for example when only the server becomes unreachable, the app notices it on the next request, while the page is visible after about one minute at the latest; afterwards it checks every 10 s and notices the return correspondingly fast. If only one mail server does not respond, that does not count as offline; if changes are waiting for it, the bar names it ("‹n› changes waiting for ‹host›") with "Try again".

**Loss:** If the session ends (sign-out, expiry on the server, account deleted) or someone deletes the local data, pending changes and drafts are lost. If you have worked offline for a long time, open the app with a connection again before the session expires.

## Refreshing and clearing the cache

| Trigger | Effect |
|---|---|
| Maintenance › Storage › "Compact" or restoring a backup (both increase `client_cache_version` in `public/config`) | On the next fetch of the configuration all browsers clear the app shell cache and the mail store and fill both anew; pending changes stay |
| Settings › General › "Clear local data" | Cache, mail store, queue and copy of this device; the size is shown there |
| Sign-out, ended session, account deleted | Mail store, queue and copy of this device |
| Mail account removed (also on another device) | Data of this mail account |

## Language

The app is available in English and German. Every user chooses under Settings › Language & region or in the account menu; "System" follows the browser (German if its language starts with `de`, otherwise English) and changes along with it.

- **Without sign-in** (sign-in, setup, invitation, forgotten password) the language of the last account on this device applies, otherwise that of the browser, otherwise English. A new account takes over the language in which it signed in for the first time.
- **Emails, bell, audit log and export** come in the language of the recipient or of the signed-in user; with "System" in the language of their last sign-in. An invitation comes in the language of the inviting administrator, because the invited person has no settings yet. The preview of the mail templates shows the interface language.
- **New emails via push** are shown by the service worker in the language the app last had on this device.
- **Branding:** The app translates the default texts of the sign-in page; custom texts from the administration appear in every language as entered. The manifest names no language (`lang` is missing), because the app's name is a proper name and the manifest does not know the person's language.
- **Formats:** English uses the British order of dates ("Tue 10 November"); the numeric date format and 12/24 hours keep following the settings.

## Test status

Tested with Chromium (headless), against the real backend and a local Stalwart v1.0.2: manifest and icons, service worker in the production build, start without network, store, queue and replay against the server, search suggestions, rules, English interface and emails. Only testable on real devices and not yet tested: installation and icons on Android, iOS and the desktop, return from the sign-in at the mail server in the installed app on iOS, `mailto:` as default, start without network from the home screen, update of an installed app, full storage and eviction by the browser, Firefox and Safari, English emails in real mail clients.

## Troubleshooting

| Observation | Cause | Remedy |
|---|---|---|
| Browser does not offer installation | no HTTPS, sub-path, browser without installation of web apps or manifest not reachable | `https://…/manifest.webmanifest` must return JSON; check the proxy |
| Icon of the installed app outdated | The system rarely checks the manifest | Wait or reinstall the app |
| Start without network shows the error page "Offline" | not signed in, app never started with network, or storage full | Sign in and open once with network |
| Still the old version after an update | Proxy caches `/` or `/service-worker.js` | Pass the backend's cache headers through |
| New mail server blocked after a start without network | Page from the cache with the previous CSP | Heals itself with the next navigation with network |
| Banner "Offline" stays despite a connection | Offline simulation of the Developer page, or neither backend nor mail server respond (the bar follows the requests; a network without a default route no longer interferes) | End the simulation; otherwise check the reachability of backend and mail server – the bar goes away with the first response, while the page is visible after at most about 10 s; sending is locked meanwhile |
| "Not synced" | Another device was faster (conflict) | Check the state on the server, repeat the action |
| Email in the wrong language | Language of the recipient, or for invitations of the inviting person | Settings › Language & region of the recipient |
