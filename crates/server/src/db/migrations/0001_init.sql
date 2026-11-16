-- Migration 0001: initial schema.
--
-- Timestamps are UTC text (ISO 8601 with milliseconds), so they compare as
-- text. IDs visible to the outside are ULIDs (`db::new_id`). Secrets are
-- stored only encrypted (`broker::crypto`) or as SHA-256 hashes.

CREATE TABLE schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Instance settings as JSON per key (public_url, org, branding, …).
CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    json       TEXT NOT NULL CHECK (json_valid(json)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- App accounts.
CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    -- Login name next to the email address; auth::username checks the format.
    username            TEXT NOT NULL UNIQUE
                        CHECK (username = lower(username) AND length(username) BETWEEN 2 AND 32),
    -- Unique ignoring case (NOCASE folds ASCII only).
    email               TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (email <> ''),
    display_name        TEXT NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked')),
    -- Argon2id PHC string.
    password_hash       TEXT NOT NULL,
    password_changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at        TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Signed-in browsers and installed apps.
CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- SHA-256 of the cookie token; the token itself is never stored.
    token_hash   BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    user_agent   TEXT,
    ip           TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Moves with activity (30 days after last_seen_at).
    expires_at   TEXT NOT NULL,
    -- "Stay signed in": 1 = cookie with a lifetime, 0 = cookie until the
    -- browser closes. On the server the session expires in both cases after
    -- 30 days without activity.
    persistent   INTEGER NOT NULL DEFAULT 1 CHECK (persistent IN (0, 1)),
    -- Place from GeoIP (`ROEDY_GEOIP_DB`), otherwise empty. `auth::device`
    -- derives device and kind (desktop, phone, tablet) from the user agent
    -- when reading.
    place        TEXT,
    -- Session of the installed app, which cannot be told from the user
    -- agent; the web app reports it at sign-in (`X-Roedy-App`).
    app          INTEGER NOT NULL DEFAULT 0 CHECK (app IN (0, 1))
) STRICT;

CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Admin and security actions.
CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    category   TEXT NOT NULL CHECK (category IN ('login', 'users', 'settings', 'system')),
    -- Action as a key, e.g. `auth.login`; texts are built when reading.
    action     TEXT NOT NULL,
    -- Who acted; the name stays readable once the user is deleted.
    actor_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
    actor_name TEXT,
    -- Affected object, e.g. the ID of a user or server.
    target     TEXT,
    ip         TEXT,
    details    TEXT CHECK (details IS NULL OR json_valid(details)),
    -- Place from GeoIP, if known.
    place      TEXT
) STRICT;

CREATE INDEX audit_log_at ON audit_log (at);

-- Mail server registry. Its contents also define the app's CSP
-- (`connect-src`).
CREATE TABLE servers (
    id                      TEXT PRIMARY KEY,
    label                   TEXT NOT NULL CHECK (label <> '' AND length(label) <= 100),
    -- Only scheme, host and port (`https://mail.example.com`), no trailing `/`;
    -- checked by api::servers. One server per address.
    base_url                TEXT NOT NULL UNIQUE,
    -- Domains of the email addresses the server serves (lowercase, without `@`);
    -- each domain belongs to at most one server (checked by api::servers).
    domains_json            TEXT NOT NULL DEFAULT '[]'
                            CHECK (json_valid(domains_json) AND json_type(domains_json) = 'array'),
    -- OAuth client in Stalwart (created by hand or via DCR, RFC 7591).
    oauth_client_id         TEXT CHECK (oauth_client_id IS NULL OR oauth_client_id <> ''),
    -- Confidential clients only; encrypted, never sent to the browser.
    oauth_client_secret_enc BLOB CHECK (oauth_client_secret_enc IS NULL OR oauth_client_id IS NOT NULL),
    -- Last diagnosis (broker::probe): ok, err or unk (not checked).
    reach                   TEXT NOT NULL DEFAULT 'unk' CHECK (reach IN ('ok', 'err', 'unk')),
    cors                    TEXT NOT NULL DEFAULT 'unk' CHECK (cors IN ('ok', 'err', 'unk')),
    oauth                   TEXT NOT NULL DEFAULT 'unk' CHECK (oauth IN ('ok', 'err', 'unk')),
    tested_at               TEXT,
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Registry policy, exactly one row.
CREATE TABLE server_policy (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    -- May users connect accounts on servers outside the list? Then the CSP
    -- allows `connect-src https:`.
    allow_custom_servers INTEGER NOT NULL DEFAULT 0 CHECK (allow_custom_servers IN (0, 1)),
    updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO server_policy (id) VALUES (1);

-- Authenticator apps (TOTP, RFC 6238). A row without confirmed_at is a
-- started enrolment (`auth/totp/devices/enroll`); it only counts as a device
-- after confirmation with a code.
CREATE TABLE totp_devices (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Name of the app ("Authenticator app 2"), set on confirmation.
    name         TEXT CHECK (name IS NULL OR (name <> '' AND length(name) <= 64)),
    -- Secret, encrypted with purpose and row ID.
    secret_enc   BLOB NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    confirmed_at TEXT,
    last_used_at TEXT,
    -- Last accepted time step: a code is valid only once (RFC 6238, 5.2);
    -- checked and set in one UPDATE.
    last_step    INTEGER,
    CHECK (confirmed_at IS NULL OR name IS NOT NULL)
) STRICT;

CREATE INDEX totp_devices_user ON totp_devices (user_id);

-- Recovery codes: ten per user, each valid once. Only a hash is stored
-- (auth::recovery).
CREATE TABLE recovery_codes (
    id         INTEGER PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash  BLOB NOT NULL CHECK (length(code_hash) = 32),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    used_at    TEXT,
    UNIQUE (user_id, code_hash)
) STRICT;

-- Known devices per user: hash of user agent family and network
-- (`auth::device`). A sign-in from an unknown device triggers the "New
-- sign-in" event.
CREATE TABLE known_devices (
    user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_hash   BLOB NOT NULL CHECK (length(device_hash) = 32),
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, device_hash)
) STRICT, WITHOUT ROWID;

-- In-app notifications (bell). Stored are the event and its parameters, not
-- finished texts: title, text, icon and link are built when reading, in the
-- recipient's language.
CREATE TABLE notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    topic      TEXT NOT NULL
               CHECK (topic IN ('security', 'account', 'team', 'system', 'news')),
    -- Event from the catalogue (`events::Kind`), e.g. `security.login`.
    kind       TEXT NOT NULL,
    params     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    read_at    TEXT
) STRICT;

CREATE INDEX notifications_user ON notifications (user_id, created_at);

-- Links from mails for "Reset password" and the email address change. Only
-- the SHA-256 of the token is stored; the token itself appears only in the
-- link of the mail.

-- "Reset password": valid for 60 minutes and only once (`used_at`). A new
-- request replaces older links not used yet.
CREATE TABLE password_resets (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NOT NULL,
    used_at    TEXT
) STRICT;

CREATE INDEX password_resets_user ON password_resets (user_id);

-- Email address change, the only source of the pending address: one row per
-- link. `sent_at` is empty while the link is only reserved (mails not sent
-- yet); only after that does it confirm. Each user has at most one sent,
-- unconfirmed link – releasing deletes the others. Confirmed rows stay until
-- they expire (state "Already confirmed").
CREATE TABLE email_changes (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    new_email    TEXT NOT NULL COLLATE NOCASE CHECK (new_email <> ''),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at   TEXT NOT NULL,
    sent_at      TEXT,
    confirmed_at TEXT
) STRICT;

CREATE INDEX email_changes_user ON email_changes (user_id);

-- Invitations, one row per open invitation: revoking and accepting delete it,
-- so there are no old tokens that could still be valid somewhere. An expired
-- invitation stays until it is revoked or resent.
CREATE TABLE invitations (
    id              TEXT PRIMARY KEY,
    -- Unique ignoring case like `users.email`; the address counts as taken
    -- while the invitation exists.
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (email <> ''),
    -- Name from the form, only for a single address ("Last name, First name").
    name            TEXT CHECK (name IS NULL OR name <> ''),
    role            TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    -- SHA-256 of the token for lookups, plus the token encrypted (row = ID)
    -- so that "Copy link" can show it.
    token_hash      BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    token_enc       BLOB NOT NULL,
    -- Who invited or last resent; the invitation page names them
    -- ("Invitation from …").
    invited_by      TEXT REFERENCES users (id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Seven days from creation or from the last successful send.
    expires_at      TEXT NOT NULL,
    -- Last successful send; empty = "Not sent".
    mail_sent_at    TEXT,
    -- Authenticator app secret from the invitation's "Multi-factor" step,
    -- encrypted; accepting turns it into the first app.
    totp_secret_enc BLOB,
    -- Last "Request new invitation" (at most once per 24 hours).
    requested_at    TEXT
) STRICT;

-- Per-user settings: one JSON document; `settings.rs` checks it and fills in
-- defaults. Without a row the defaults apply (version 0).
CREATE TABLE user_settings (
    user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    json       TEXT    NOT NULL CHECK (json_valid(json)),
    -- Increases with every save; `PUT settings` names the version the change
    -- is based on and fails when it is no longer current.
    version    INTEGER NOT NULL CHECK (version > 0),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Users' mail accounts. Tokens are stored here only encrypted and leave the
-- backend only through the token broker.
CREATE TABLE mail_accounts (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Origin of the mail server like `servers.base_url`. The account is
    -- linked to the registry through this address, not through the server's
    -- ID: the tokens belong to exactly this server.
    base_url          TEXT NOT NULL,
    -- Address of the signed-in account (lowercase), as the session names it.
    email             TEXT NOT NULL CHECK (email <> ''),
    -- Primary mail account and username of the JMAP session: by these the
    -- app recognises the same account again (duplicates, signing in again).
    account_id        TEXT NOT NULL CHECK (account_id <> ''),
    username          TEXT NOT NULL,
    -- `oauth`: sign-in at the mail server (refresh token), `token`: the
    -- user's access token.
    auth_kind         TEXT NOT NULL CHECK (auth_kind IN ('oauth', 'token')),
    -- OAuth client the tokens were issued for (needed for the refresh).
    client_id         TEXT CHECK ((auth_kind = 'oauth') = (client_id IS NOT NULL)),
    -- Refresh token (`oauth`) or access token (`token`), encrypted.
    secret_enc        BLOB NOT NULL,
    -- Last access token (`oauth`) and when it expires.
    access_token_enc  BLOB CHECK (access_token_enc IS NULL OR auth_kind = 'oauth'),
    access_expires_at TEXT,
    -- JMAP session at the last sign-in.
    session_json      TEXT NOT NULL CHECK (json_valid(session_json)),
    -- `needs_reauth`: the refresh failed ("Sign-in required").
    state             TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'needs_reauth')),
    -- Index into the web app's account colours.
    color             INTEGER NOT NULL CHECK (color BETWEEN 0 AND 5),
    -- Storage as of the last check.
    last_check_at     TEXT,
    quota_used        INTEGER,
    quota_total       INTEGER,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- When the browser last fetched an access token for the account: the
    -- early refresh renews active accounts before their token expires.
    token_used_at     TEXT,
    -- Last attempt of the job `quota_check`, even if it failed: so it asks a
    -- broken server again only the next day, not every hour.
    quota_job_at      TEXT,
    -- Since when "Storage almost full" has been reported; empty while the
    -- storage is below the threshold or not reported yet.
    quota_alert_at    TEXT,
    UNIQUE (user_id, base_url, account_id)
) STRICT;

-- Linked accounts per server (Administration › Mail servers).
CREATE INDEX mail_accounts_base_url ON mail_accounts (base_url);

-- Users' tags. A tag applies to all mail accounts of its user; per mail
-- account it is linked to a JMAP mailbox under the root "Tags"
-- (`tag_links`), which the browser creates when the tag is first set.
CREATE TABLE tags (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Parent tag, empty = top level. Deleting it also deletes the subtags.
    parent_id  TEXT REFERENCES tags (id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (name <> ''),
    -- Index into the web app's account colours, empty = colour of the parent
    -- tag.
    color      INTEGER CHECK (color BETWEEN 0 AND 5),
    -- Order among siblings, from 0 without gaps.
    position   INTEGER NOT NULL CHECK (position >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Names are unique per level, ignoring case. `NOCASE` knows ASCII only; the
-- API compares the other letters beforehand.
CREATE UNIQUE INDEX tags_name ON tags (user_id, COALESCE(parent_id, ''), name COLLATE NOCASE);
CREATE INDEX tags_parent ON tags (parent_id);

-- One mailbox per tag and mail account, at most one tag per mailbox. The
-- links go with the tag and with the mail account.
CREATE TABLE tag_links (
    tag_id          TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    mail_account_id TEXT NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
    -- ID of the mailbox in the account's JMAP session.
    mailbox_id      TEXT NOT NULL CHECK (mailbox_id <> ''),
    PRIMARY KEY (tag_id, mail_account_id),
    UNIQUE (mail_account_id, mailbox_id)
) STRICT;

-- Notifications still to be delivered by email or web push: "Instant" mails
-- until the end of quiet hours, digest entries until the next digest in the
-- recipient's time zone, push messages held back during quiet hours.
-- Independent of `notifications`: an event can arrive by email without showing
-- in the app, and removing it in the bell does not take it out of the digest.
-- Security events go by push only (immediately, without quiet hours); by
-- email they have their own immediate mails.
CREATE TABLE notification_deliveries (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel         TEXT NOT NULL CHECK (channel IN ('mail', 'push')),
    topic           TEXT NOT NULL
        CHECK (topic IN ('security', 'account', 'team', 'system', 'news')),
    kind            TEXT NOT NULL,
    params          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params)),
    -- Entry in the bell, if there is one; push uses it as `tag`.
    notification_id TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Failed attempts and earliest next attempt.
    attempts        INTEGER NOT NULL DEFAULT 0,
    retry_at        TEXT,
    CHECK (topic <> 'security' OR channel = 'push')
) STRICT;

CREATE INDEX notification_deliveries_user
    ON notification_deliveries (channel, user_id, created_at);

-- Web push: one subscription per browser (`PushSubscription` with endpoint and
-- keys from RFC 8291), bound to the session it was registered in: signing the
-- device out (also by expiry or "Sign out all others") ends push on it as
-- well. The same endpoint always belongs to the browser's most recently
-- registered session.
CREATE TABLE push_subscriptions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    -- The browser's public key (P-256, uncompressed) and authentication
    -- secret.
    p256dh     BLOB NOT NULL CHECK (length(p256dh) = 65),
    auth       BLOB NOT NULL CHECK (length(auth) = 16),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- The browser's `expirationTime`, if it gives one.
    expires_at TEXT
) STRICT;

CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
CREATE INDEX push_subscriptions_session ON push_subscriptions (session_id);

-- Uploaded branding logo, checked and (SVG) sanitised. The ID is a hash of
-- the content; `app_settings.branding` names it in `image`. Only the image
-- the branding points to is kept. The server redraws the mail logo and push
-- icon at startup and after every change; they live in memory only.
CREATE TABLE assets (
    id         TEXT PRIMARY KEY,
    mime       TEXT NOT NULL
               CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml')),
    data       BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Update state, exactly one row: the result of the last check against the
-- GitHub releases (`latest`, `summary`, `checked_at`, `reason`), the last
-- reported version ("Update available" once per version) and the one
-- installed at the last start (version change, "Update installed"). Settings
-- and token live in `app_settings.updates`.
CREATE TABLE update_state (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    latest                TEXT,
    summary               TEXT,
    checked_at            TEXT,
    reason                TEXT,
    last_notified_version TEXT,
    installed_version     TEXT
) STRICT;

INSERT INTO update_state (id) VALUES (1);
