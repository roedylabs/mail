-- Migration 0002: who obtained the grant of a mail account.
--
-- `1`: the backend exchanged the code itself (confidential client, secret in
-- the registry); only then does the token broker refresh with the client
-- secret. `0`: the browser sent the tokens (public client) or the user's
-- access token (`token`); the broker refreshes as a public client, so that a
-- refresh token from the browser never gets access tokens with the secret.
--
-- Existing rows get `0`: the kind of their grant is unknown, and refreshing
-- without the secret is the safe side. An account whose grant came from the
-- code exchange then requires a new sign-in ("Sign in again") at its next
-- refresh, because the mail server rejects its client without the secret.
ALTER TABLE mail_accounts ADD COLUMN backend_exchange INTEGER NOT NULL DEFAULT 0
    CHECK (backend_exchange IN (0, 1) AND (backend_exchange = 0 OR auth_kind = 'oauth'));
