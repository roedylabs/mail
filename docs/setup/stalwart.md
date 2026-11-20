# Preparing Stalwart for Roedy Mail

> **Tested with Stalwart v1.1.0.** Covered are address, CORS and OAuth client – what Administration › Mail servers checks –, rate limit, bans and reverse proxy, the sender account for system emails, "Send later", push, rules (Sieve), token lifetimes, emptying trash and spam and the JMAP limits. Operating Roedy Mail itself is described in [`docs/ops.md`](../ops.md).

Roedy Mail speaks JMAP with Stalwart **directly from the browser**. The backend only issues short-lived access tokens. For this to work, every mail server needs three things, which "Test connection" under Administration › Mail servers checks (add the server there right after the initial setup):

| Diagnostic row | Condition | Section |
|---|---|---|
| JMAP session | `https://<server>/.well-known/jmap` is reachable from outside and returns a session with JMAP Core and Mail | [Address](#server-address) |
| CORS headers | The server allows requests from the browser from the app's address | [CORS](#cors) |
| OAuth client | An OAuth client with the app's redirect URI is configured | [OAuth client](#oauth-client) |

In addition, the address of the Roedy Mail server belongs on Stalwart's allow list ([Rate limit and bans](#rate-limit-and-bans)).

**Stalwart v1.x from v1.0.0** is supported, tested with v1.1.0 (after an update see [Updating Stalwart](#updating-stalwart)). Stalwart v0.16 and older are not supported; the diagnostics report such servers as unsupported (`unsupported_version`). Upgrade them first as described under "Upgrading from 0.16" in Stalwart's documentation. Stalwart's web interface is only available in English; the menu paths below follow it, and in parentheses is the name of the setting (Object.property) under which Stalwart's API and documentation also list it.

**Settings only take effect after reloading:** Stalwart only applies changes to settings such as CORS, rate limit, allow list, token lifetimes or retention with the action **Management › Actions › Reload settings** (`ReloadSettings`) or a restart.

**Summary** for a new server:

1. Decide on Stalwart's public HTTPS address; it is the base URL in Roedy Mail ([Address](#server-address)).
2. Turn on "Permissive CORS policy" ([CORS](#cors)).
3. Put the address of the Roedy Mail server on the allow list; behind a reverse proxy, set the source of the client address ([Rate limit and bans](#rate-limit-and-bans)).
4. Run **Reload settings**.
5. Create the server in Roedy Mail and register the OAuth client automatically ([OAuth client](#oauth-client)), then "Test connection".
6. Optional: a sender account with an app password for system emails ([Sender account](#sender-account-for-system-emails)), the contact for web push ([Push](#push-for-new-emails)).

Token lifetimes, trash retention and JMAP limits fit by default; what changing them means for Roedy Mail is described in the sections [Token lifetimes](#token-lifetimes), [Trash and spam](#trash-and-spam) and [JMAP limits](#jmap-limits).

## Updating Stalwart

Stalwart only creates the default roles on the first start of a new installation. Permissions introduced by a later release (v1.0.3; v1.1.0 `sysPasskey*` for passkeys) are therefore missing from them on an updated server, and the features behind them stay blocked. After the update, start Stalwart once with the environment variable `STALWART_UPDATE_ROLE_PERMISSIONS=true` (adds to every default role the permissions new since v1.0.0 that a new installation would give it) and remove the variable again afterwards. With customized default roles, check first: the start adds every permission new since v1.0.0 that the role neither allows nor blocks – including one that was deliberately just removed there –, and it stays after removing the variable. So enter permissions that should stay off among the role's disabled permissions beforehand (`Role.disabledPermissions`); the start skips those. Roedy Mail itself needs none of these permissions; `SysOAuthClientCreate` for the [OAuth client](#automatic-recommended) exists since v1.0.0. Then "Test connection" under Administration › Mail servers.

## Server address

- Enter the server's public HTTPS address without a path as the **base URL** in Roedy Mail: `https://mail.example.com` (not `…/jmap`). JMAP, OAuth and `/.well-known/` are at the root in Stalwart.
- It must be **the same address Stalwart uses itself** (visible in the session as `apiUrl`, in the OAuth metadata as `issuer`). Stalwart v1 takes it from the environment variable `STALWART_PUBLIC_URL`, otherwise with `STALWART_HTTPS_PORT` set from `https://<STALWART_HOSTNAME or machine name>:<port>`, otherwise from the host name of the JMAP service under Settings › Network › Services or the default host name under Settings › Network › General (`SystemSettings.services`, `defaultHostname`). If it does not match, the diagnostics report "unreachable" with the reason `api_url_mismatch`, or for the OAuth client `issuer_mismatch`: for security reasons (Content Security Policy) the app may only talk to the addresses of the server list.
- A port other than 443: include it (`https://mail.example.com:8443`). IPv6 addresses do not work as a base URL; please use a host name.
- **HTTP/2** is recommended: for real-time sync the browser keeps one connection open per mail account. Over HTTP/1.1 browsers allow only six connections per server, across all tabs together; several tabs with several accounts on one server can fill them. Once they are taken – with six accounts of one server already in a single tab –, every further request to the server waits, including adding an account (measured in the load test). Stalwart v1 itself only speaks HTTP/1.1; HTTP/2 is available with a reverse proxy in front that offers it towards the browser.
- An **internal address** from the Docker network (`http://stalwart:8080`) does not work: every user's browser connects directly to this address. `http://` is only allowed for `localhost` and `127.0.0.1`, and only for development without containers (`cargo run` on the machine that also runs Stalwart): the backend connects to the address too (diagnostics, registration, sign-in, system emails), and inside a container `localhost` is the container itself. Stalwart and Roedy Mail both listen on port 8080 by default; on the same machine change one of them, such as `ROEDY_LISTEN=127.0.0.1:3000` (for `pnpm dev` also `ROEDY_DEV_BACKEND=http://127.0.0.1:3000`).
- Domains: for every domain of the email addresses users have on this server (`example.com`), "Add account" picks the server automatically. Every domain belongs to at most one server.

## CORS

The browser may only talk to a foreign server if it allows this via CORS. In Stalwart:

1. Under **Settings › Network › HTTP › Security** turn on "Permissive CORS policy" (`Http.usePermissiveCors`, off by default).
2. Save and run **Management › Actions › Reload settings**.

Stalwart then sets `Access-Control-Allow-Origin: *` on every response and allows the headers `Authorization`, `Content-Type`, `Accept` and `X-Requested-With`. This is safe because Roedy Mail sends tokens in the `Authorization` header, not as a cookie. In bootstrap and recovery mode (Stalwart's first setup) CORS is always on – so the diagnostics say "OK" there even if the setting is missing; test again in normal operation.

The app can only read waiting times after a block by Stalwart (HTTP 429, `Retry-After`) if the response carries `Access-Control-Expose-Headers: Retry-After`. Stalwart does not set this header even with "Permissive CORS policy" (tested with v1.0.2 and v1.1.0); a reverse proxy in front of Stalwart can add it. Without it the app reports the block without a waiting time.

If you want to allow only the app's address instead of `*`, you can also set the headers in the reverse proxy in front of Stalwart. For this the diagnostics require, for a preflight (`OPTIONS` on the `apiUrl` with `Origin`, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: authorization, content-type`), a 2xx response with `Access-Control-Allow-Origin: <app address>` and `Access-Control-Allow-Headers` that names `Authorization` explicitly (the `*` does not count for it in the browser) and `Content-Type` (or `*`). Every normal response needs the same headers.

## OAuth client

Users sign in in the browser with Stalwart's OAuth flow (code with PKCE); afterwards Stalwart from v1.0.1 asks once for consent. From v1.1.0 Stalwart's sign-in page also offers passkeys ("Sign in with a passkey"); for Roedy Mail this changes nothing, because the sign-in runs entirely on Stalwart's side. A passkey replaces password and second factor there (Stalwart then does not ask for TOTP); its relying party ID is the host of Stalwart's public URL. For this every server needs an OAuth client with

- **redirect URI** `<app address>/oauth/callback`, e.g. `https://app.example.com/oauth/callback`, where the app address is `ROEDY_PUBLIC_URL` (required, [Operations › Configuration](../ops.md#configuration); Administration › Mail servers shows the URI for copying),
- the scopes `offline_access urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:contacts` (that is what they are called in Stalwart; Stalwart does not know `mail` alone). Stalwart v1 enforces them: a token only sees what its scope allows; Roedy Mail needs contacts for the recipient suggestions.

A newly registered client (new client ID) only applies to new sign-ins: Stalwart v1 binds every sign-in to its client, so all connected mail accounts require a new sign-in afterwards ("Sign in again"). If the app's address changes, register the client again – it only applies to its redirect URI.

### Automatic (recommended)

In the dialog "Add server" or "Edit server" under "OAuth client", choose **Automatic**, enter the user name and **app password** of an administrator of the mail server and click "Register client automatically". Roedy Mail then registers a **confidential client** (`client_secret_basic`) with redirect URI and scopes via Dynamic Client Registration (RFC 7591); Stalwart creates it as an OAuth client (visible and deletable under Management › Directory › OAuth Clients) and responds with client ID and secret. The secret stays encrypted in the backend and never goes to the browser: until "Add" or "Save", Roedy Mail holds it back (at most 30 days) and then stores it with the server under this client ID; the backend handles code exchange and refresh. The admin's credentials only apply to this request and are not stored.

- **Client ID:** During registration Stalwart assigns the client ID itself (20 random characters); in the list under Management › Directory › OAuth Clients the column "Description" says "Roedy Mail". If you want a meaningful ID such as `roedy-mail`, create the client [manually](#manual).
- The account needs the permission `SysOAuthClientCreate` in Stalwart; the roles "System Administrator" (accounts with the Admin role) and "Tenant Administrator" have it, also on an updated server (new permissions of later releases: [Updating Stalwart](#updating-stalwart)). Otherwise Stalwart responds with 403.
- **App password instead of password:** The admin creates the app password in Stalwart's Account Manager (`/account`, **Account › Credentials › App Passwords**; Stalwart shows it only once). It inherits the account's permissions and also works with a second factor. With the normal password it only works without a second factor; otherwise Stalwart responds "MFA code required" (402, reason `mfa_required`). The app password can be deleted there again after the registration.
- Failed sign-ins count in Stalwart against the address of the Roedy Mail server unless it is on the allow list ([Bans](#rate-limit-and-bans)). Roedy Mail therefore allows at most five rejected attempts in 15 minutes (`mfa_required` counts too).
- Roedy Mail rejects servers without the OAuth metadata of v1 (v0.16) before the credentials go out (`unsupported_version`).

### Manual

Under **Management › Directory › OAuth Clients** create an OAuth client (`OAuthClient`): client ID of your choice (e.g. `roedy-mail`), description "Roedy Mail", the redirect URI above, **scopes Mail and Contacts** (`mail`, `contacts`; in the token `urn:ietf:params:oauth:scope:mail`, `urn:ietf:params:oauth:scope:contacts`), grant types as preset (Authorization Code and Refresh Token). Enter the client ID in Roedy Mail's dialog under **Manual**. Roedy Mail requests both scopes on every sign-in; if the client lacks one of them, the sign-in fails with `invalid_scope` (without scopes Stalwart v1 only allows `openid` and `offline_access`).

- **Confidential** (recommended, like the automatic registration): In Stalwart's field "Client Secret" set a long, random secret, for example from `openssl rand -base64 32` (Stalwart only stores it as a hash; Stalwart does not generate one via the API, whether the web interface can is untested), and enter the same in Roedy Mail's field "Client secret". Stalwart requires it for the code exchange, the refresh and the revocation, so the backend handles all of that. The secret stays encrypted in the backend and never goes to the browser. If a user removes a mail account, the backend revokes its sign-in at Stalwart; likewise a sign-in it has just exchanged but does not keep (the account is already connected, "Sign in again" with a different account, or the account was removed in the meantime).
- **Public** (secret empty in Stalwart, only the client ID in Roedy Mail): the browser then exchanges the code itself; failed attempts hit its address instead of the backend's.
- **Secret only for its own sign-ins:** the backend refreshes with the secret only sign-ins whose code it exchanged itself. Tokens the browser exchanged (public client) it refreshes without the secret, even if the server has one by now. If you add a secret to a client that was public so far, its mail accounts therefore show "Sign-in required" at the next refresh; "Sign in again" switches them to the code exchange in the backend.
- Whether Stalwart accepts the client ID only shows on a user's first sign-in. Beforehand, the diagnostics check that the OAuth metadata (`/.well-known/oauth-authorization-server`) are those of Stalwart v1 (with `revocation_endpoint` and `protected_resources`), that a client ID is configured and that the metadata offer the `issuer` (the base URL), authorization, token and revocation endpoint under the base URL, refresh tokens, PKCE with S256 and clients without a secret (`none`) or with a secret (`client_secret_basic` or `client_secret_post`); if one of these lists is missing, the default of RFC 8414 applies (not offered; for client authentication only `client_secret_basic`).
- If the client ID changes, Roedy Mail discards a stored secret (it belongs to the old client) – unless the new one comes from "Automatic".

## Rate limit and bans

Diagnostics, registration, refresh and revocation run for **all users** via the Roedy Mail backend, i.e. from one address; with a confidential client also the code exchange (with a public one the browser exchanges it). Two mechanisms of Stalwart hit this address:

- **Anonymous rate limit:** requests without a user sign-in – token and revocation endpoint, OAuth metadata, `/.well-known/` – count per address, 100 per minute by default (Settings › Network › HTTP › Security › Rate Limit › Anonymous, `Http.rateLimitAnonymous`). Above that Stalwart responds with 429; the diagnostics then report `throttled`, and mail accounts cannot renew their access.
- **Automatic ban** after failed sign-ins (Fail2Ban; Settings › Security › Settings, `Security.authBanRate`, by default 100 failed attempts per day per address and per sign-in name): the ban applies without expiry until someone deletes the entry under Settings › Security › Blocked IPs and runs the action **Reload blocked IPs** under Management › Actions (`ReloadBlockedIps`; the label in the interface is untested).

So the address of the Roedy Mail server belongs on the **allow list**: under **Settings › Security › Allowed IPs** create an entry with the address (`AllowedIp`, an address or a network such as `198.51.100.0/24`), then **Reload settings**. Stalwart exempts entries of the list from the anonymous rate limit and from all bans. What counts is the address Stalwart sees: the public address via which the backend goes out (for a container, the host's), in the same network the internal one – not the users' address and not that of a proxy in front of Stalwart. Stalwart exempts loopback (`127.0.0.1`, `::1`) anyway.

### Behind a reverse proxy

If a reverse proxy sits in front of Stalwart, Stalwart must read the client's address from its header, otherwise all requests seem to come from the proxy: rate limit and bans would then hit all users together, and a ban would lock everyone out. In v1 two settings under **Settings › Network › HTTP › General › Proxy** replace the former `useXForwarded`:

- **Source of the address** (`Http.clientIpSource`): `peer` (default, the address of the connection, headers are ignored), `xForwardedFor` (`X-Forwarded-For`) or `forwarded` (`Forwarded`, RFC 7239) – depending on which header the proxy sets.
- **Number of proxies** (`Http.forwardedHops`, 1–16, default 1): Stalwart takes the address this many entries from the right of the header; in front of a CDN with its own proxy behind it, `2`.

Stalwart must then only be reachable via the proxy, otherwise a client could state its own address (including one on the allow list). Without the header Stalwart takes the address of the connection (another reason to block direct access); if the entry at the chosen position is missing, unreadable or names loopback, Stalwart responds with 400. The allow list still names the address of the Roedy Mail server, not that of the proxy. As an alternative to the header, the PROXY protocol works (`SystemSettings.proxyTrustedNetworks`, only after a restart); Stalwart also exempts the networks listed there from rate limit and bans.

## Sender account for system emails

Roedy Mail sends invitations, password reset links and security notices via JMAP through an account on a server of the list. It is set up under Administration › Email ([Administration](administration.md#email-system-email)) once its server is in the list. "Test connection" signs in as before sending (identity, mailbox "Drafts"), but sends nothing.

- **Account:** a mailbox of its own, e.g. `noreply@example.com`, with the right to send emails (JMAP Submission). The account's identity is the sender; name and reply-to address can be overridden in Roedy Mail. Stalwart rejects emails whose sender does not match the chosen identity.
- **Sign-in:** ideally an **app password** created in this account's Account Manager (Account › Credentials › App Passwords); it bypasses a second factor. Stalwart allows at most five app passwords per account (`Authentication.maxAppPasswords`). Alternatively an access token. Roedy Mail sends user and app password via Basic Auth only to the server's address, never to another one (not even after a redirect). The migration to v1 carries app passwords over.
- **Mailboxes:** the email is created as a draft in the mailbox with the role "Drafts" and ends up in "Sent" after sending (can be turned off; it is then deleted). Stalwart creates both mailboxes for every account.
- **Rejected sign-ins:** they count in Stalwart against the address of the Roedy Mail server ([Bans](#rate-limit-and-bans)). After five rejected sign-ins at one server within 15 minutes (counting from the first, including the tests under Administration › Email; a successful send or test resets the counter) Roedy Mail stops trying there for 15 minutes; invitations and confirmation links then report "Not sent". So after a new app password, change the credentials in Roedy Mail first.
- **Errors** of sending are in the server log (`System mail not sent` or `Sending account not usable` with `reason`, e.g. `auth_failed`, `unreachable`, `no_identity`, `no_mailbox`, `not_created` with Stalwart's error type such as `forbiddenFrom` or `forbiddenToSend`, `auth_locked`); Administration › Email shows the status, the test there also the reason.

## Send later

"Send later" and "Undo send" submit emails via JMAP with `HOLDUNTIL` or `HOLDFOR` (FUTURERELEASE, RFC 4865); the email waits in Stalwart's queue.

- **Limit:** How far ahead Stalwart accepts is set by the expression `futureRelease` of the SMTP extensions (`MtaExtensions`), by default 7 days for authenticated sessions, otherwise off. Regardless of that, the JMAP session reports a fixed 30 days (`maxDelayedSend`); Roedy Mail therefore offers at most 7 days. If the limit is set lower, the app only notices from the rejection: the message stays a draft, and the app reports "The mail server doesn’t accept this time. Please choose an earlier one."
- **Turned off:** Without `futureRelease` Stalwart rejects every delayed submission; "Undo send" then falls back to a delay in the browser, "Send later" reports "Your mail server doesn’t allow scheduled sending."

## Push for new emails

Stalwart reports new emails via web push directly to the browser; the app is not involved. The switches per mail account are under Settings › Notifications ([New emails](notifications.md#new-emails)).

- **Key:** Stalwart only creates the VAPID key (`webPushKey`) on a new installation. If it is missing, for example on a migrated server, the session does not list `urn:ietf:params:jmap:webpush-vapid`, and accounts on this server get no push.
- **Contact:** set `webPushContact` in the same object `Jmap`, as `mailto:…` or `https:…`. The default is empty; then `sub` is missing from the signature, and push services may reject the message. Roedy Mail cannot read the value, so the diagnostics do not report it.
- **Network:** Stalwart must reach the push services via HTTPS (list in `docs/setup/notifications.md`). The Roedy Mail instance does not need to be publicly reachable for this.
- **Lifetime:** A subscription is valid for at most 7 days. The app renews it on every start, the service worker when an email arrives. Stalwart logs failed deliveries with `Failed to deliver push subscription`.

## Rules and forwarding (Sieve)

Roedy Mail writes filter rules and forwarding as the Sieve script `roedy-mail` via JMAP for Sieve (RFC 9661). The page only exists if the session lists `urn:ietf:params:jmap:sieve` for the account; Stalwart does that already with the Mail scope.

- **One active script:** Sieve knows at most one per account. If a script from another program is active, saving in Roedy Mail replaces it as the active script; it stays stored.
- **Vacation reply:** Stalwart manages it itself as the script `vacation`. While it is on, the rules rest; Roedy Mail then saves them without activating them and turns them on again when the vacation reply is turned off in Roedy Mail.
- **Forwarding:** Stalwart performs at most one redirect per message (`maxNumberRedirects` 1 in the session); forwarding plus a rule with "Forward" at the same time exceed that.
- **Turning it on:** There is no separate switch; the role "User" contains the permissions for JMAP for Sieve. Limits: at most 100 scripts per account and 100 KiB per script (`SieveUserInterpreter.maxScripts`, `.maxScriptSize`, `.maxRedirects`); Roedy Mail's rules check size and redirects before saving.

## Token lifetimes

Stalwart decides how long the tokens of the OAuth sign-in are valid (object `OidcProvider`; values in the API in milliseconds, menu path of the web interface untested):

| Setting | Default | In Roedy Mail |
|---|---|---|
| `accessTokenExpiry` | 1 hour | The backend issues access tokens to the browser and renews them ten minutes before expiry if a browser used the account in the last hour, otherwise on the next request. |
| `refreshTokenExpiry` | 30 days (at least 1 day) | Every renewal returns a new refresh token (strict rotation); the period counts from the last renewal. An account not used for longer than this period then shows "Sign-in required". |
| `authCodeExpiry` | 10 minutes | Time between Stalwart's sign-in page and the return to the app |

- **Access token not below ten minutes:** If shorter, the advance refresh renews active accounts every minute, below five minutes every request does; every renewal is a request to the token endpoint and counts against the [anonymous rate limit](#rate-limit-and-bans).
- **Refresh token:** Longer means "Sign in again" less often for rarely used accounts. The tokens are stored encrypted in the backend, not in the browser; a lost device is signed out via Account › Security in Roedy Mail, not via this period.
- **Old refresh token:** Stalwart only accepts a replaced refresh token as long as the new one is unused; afterwards it revokes the whole sign-in. That is why mail accounts usually require a new sign-in after restoring an older Roedy Mail backup ([Operations › Backup](../ops.md#backup-and-restore)).

## Trash and spam

Roedy Mail does not permanently delete messages in the trash and spam folders by itself (except with "Empty Trash" or "Delete permanently"). Stalwart does that: `DataRetention.expungeTrashAfter`, default **30 days**, applies to the mailboxes with the roles trash and spam of all accounts. The period counts from moving into the folder, not from receipt. The job runs once a day (`DataRetention.expungeSchedule`, by default 0:00 in the server's time zone); so a message disappears after 30 to 31 days.

The empty trash in Roedy Mail always says "Deleted messages are permanently removed after 30 days." – the app cannot read the setting. If you change the period, it deviates from this text. The setting applies to the whole server, not per account.

## JMAP limits

Stalwart states the limits in the JMAP session; Roedy Mail follows them. If a value of JMAP Core (`maxSizeUpload` to `maxObjectsInSet`) is missing, the app takes the same values as the defaults of v1.0.2 and v1.1.0 (`packages/jmap/src/session.ts`). If `maxSizeAttachmentsPerEmail` is missing, it does not check the sum of the attachments; if `maxDelayedSend` is missing, "Send later" assumes 30 days and, as always, offers at most 7. They can be changed: Roedy Mail reloads the session as soon as a response from Stalwart names a new `sessionState`; otherwise the session of the mail account's last sign-in stays in effect (it comes with the token from the backend). At the latest after "Sign in again" the new values apply.

| In the session | Default | Setting | Effect in Roedy Mail |
|---|---|---|---|
| `maxSizeUpload` | 50 MB | `Jmap.maxUploadSize` | largest file as an attachment |
| `maxSizeAttachmentsPerEmail` | 50 MB | `Email.maxAttachmentSize` | all attachments of one email together |
| `maxConcurrentUpload` | 4 | `Jmap.maxConcurrentUploads` | concurrent uploads per mail account |
| `maxSizeRequest` | 10 MB | `Jmap.maxRequestSize` | largest request; the app rejects larger ones with an error before sending |
| `maxConcurrentRequests` | 4 | `Jmap.maxConcurrentRequests` | concurrent requests per mail account |
| `maxCallsInRequest` | 16 | `Jmap.maxMethodCalls` | methods per request; the app likewise rejects more beforehand |
| `maxObjectsInGet`, `maxObjectsInSet` | 500 | `Jmap.maxGetResults`, `Jmap.maxSetObjects` | page size during sync, batches when moving and marking many messages |
| `maxMailboxesPerEmail`, `maxMailboxDepth`, `maxSizeMailboxName` | 100, 10, 255 | `Email.maxMailboxesPerEmail`, `.maxMailboxDepth`, `.maxMailboxNameLength` | folders and tags |
| `maxDelayedSend` | 30 days | – | "Send later"; `MtaExtensions.futureRelease` is what takes effect ([Send later](#send-later)) |

- **Email size:** Stalwart accepts emails up to 75 MB (`Email.maxMessageSize`), via SMTP up to 100 MiB (`MtaStageData.maxMessageSize`). 50 MB of attachments become about 67 MB when encoded. When sending to other servers their limits apply, often 25 to 50 MB.
- **Uploads per account:** Stalwart adds up uploads not yet used in an email per account (`Jmap.uploadQuota` 50 MB, `Jmap.uploadTtl` one hour); several large attachments in quick succession can fail on this before the per-file limit is reached (not tested).

## Diagnostic reasons

"Test connection" answers each row with `ok`, `err` or `unk` (not checked) and names the cause in `reasons`; the app shows a hint for each reason. If the server is not reachable, CORS and OAuth stay unchecked (`not_reachable`). If Stalwart throttles the backend's requests (HTTP 429, [anonymous limit](#rate-limit-and-bans)), the affected row and all following ones stay unchecked (`throttled`), and the response names the waiting time in `retry_after` (seconds); so the address of the Roedy Mail server belongs on the allow list. If the server is reachable and there are only hints about CORS or OAuth, it can still be saved. Without CORS and an OAuth client, however, users cannot connect their accounts; after the correction in Stalwart, test the server again under Administration › Mail servers.

| Row | Reason | Meaning, remedy |
|---|---|---|
| JMAP session | `unreachable` | No connection (DNS, port, firewall, TLS certificate). |
| | `no_session` | No JMAP server responds at `/.well-known/jmap` (check the base URL). |
| | `no_mail` | The session does not offer JMAP Core or Mail. |
| | `api_url_mismatch` | Stalwart names a different address in the session than the base URL, see [Address](#server-address). |
| | `redirect_other_origin`, `too_many_redirects` | Redirect to another address or too many redirects. |
| | `auth_required` (ok) | Reachable, but the session requires a sign-in; CORS stays unchecked (`no_api_url`). |
| | `throttled` (unk) | Stalwart throttles the backend's requests (429); CORS and OAuth stay unchecked as well. Test again after `retry_after` seconds and put the address of the Roedy Mail server on the [allow list](#rate-limit-and-bans). Also occurs only for CORS or OAuth if the limit kicks in during the test. |
| CORS headers | `origin_not_allowed` | `Access-Control-Allow-Origin` is missing or does not match: turn on [CORS](#cors) and reload the settings. |
| | `authorization_not_allowed`, `content_type_not_allowed` | `Access-Control-Allow-Headers` does not name `Authorization` or `Content-Type`. |
| | `preflight_failed`, `preflight_status` | The preflight failed or did not get a 2xx response. |
| | `no_public_url` (unk) | The app's address is not known (`ROEDY_PUBLIC_URL`). |
| OAuth client | `unsupported_version` | The OAuth metadata are not those of Stalwart v1 (`revocation_endpoint` and `protected_resources` are missing): upgrade Stalwart to v1.x ("Upgrading from 0.16" in Stalwart's documentation). Also occurs without a client ID. |
| | `no_client_id` | No client ID configured: create an [OAuth client](#oauth-client). |
| | `no_metadata`, `metadata_unreachable` | No OAuth metadata at `/.well-known/oauth-authorization-server`. |
| | `issuer_mismatch` | The `issuer` of the metadata is missing or is not the base URL; the browser then discards every redirect back from the sign-in (`iss`, RFC 9207). See [Address](#server-address). |
| | `authorization_endpoint_mismatch`, `token_endpoint_mismatch`, `revocation_endpoint_mismatch` | The authorization, token or revocation endpoint is missing or is not under the base URL. |
| | `grant_types`, `pkce`, `no_public_client`, `no_confidential_client` | The server does not offer refresh tokens, PKCE with S256, or clients without a secret (with a secret). |
