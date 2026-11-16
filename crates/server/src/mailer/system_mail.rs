//! Sending account of the system mails in `app_settings.system_mail`: an
//! account on a registry server with user and app password or with a token,
//! plus identity, sender name, reply-to address and copy in "Sent". The secret
//! is stored encrypted with its own purpose in the AAD. The setup creates the
//! account, Administration › Email changes it.
//!
//! Plus the last check of the stored account ([`Check`]): from
//! "Test connection", after saving a new connection and from
//! every send ([`record`]).

use anyhow::{Context as _, anyhow};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use jiff::Timestamp;
use roedy_jmap as jmap;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use url::Url;

use super::{Account, MailError};
use crate::{
    broker::crypto::SecretKey,
    db::repo::{app_settings, servers},
};

/// Purpose for the app password's AAD; the row is the key in
/// `app_settings`.
pub const PASSWORD_PURPOSE: &str = "app_settings.system_mail.app_password";
/// Purpose for the token's AAD.
pub const TOKEN_PURPOSE: &str = "app_settings.system_mail.token";

/// Sign-in of the sending account: "Password" or "Token".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Auth {
    /// User and app password via Basic (accounts from the setup).
    #[default]
    Password,
    /// Access token via Bearer, e.g. an API key from Stalwart.
    Token,
}

impl Auth {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "password" => Some(Self::Password),
            "token" => Some(Self::Token),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Token => "token",
        }
    }

    /// Name of the secret in requests and in the audit log.
    pub fn secret_field(self) -> &'static str {
        match self {
            Self::Password => "app_password",
            Self::Token => "token",
        }
    }

    fn purpose(self) -> &'static str {
        match self {
            Self::Password => PASSWORD_PURPOSE,
            Self::Token => TOKEN_PURPOSE,
        }
    }
}

/// Identity of the account for the selection on the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub email: String,
}

impl From<jmap::Identity> for Identity {
    fn from(identity: jmap::Identity) -> Self {
        Self {
            id: identity.id,
            name: identity.name,
            email: identity.email,
        }
    }
}

/// Last check of the stored account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Check {
    /// Time like `servers.tested_at` (UTC, milliseconds).
    pub at: String,
    pub ok: bool,
    /// Reason of an error ([`MailError::reason`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// For `no_mailbox` the role of the missing mailbox
    /// ([`MailError::mailbox_role`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Identities from the last successful check, without placeholders.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub identities: Vec<Identity>,
}

/// Stored sending account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemMail {
    /// Registry server. If it is deleted, the account counts as not
    /// configured (`system_mail_configured`).
    pub server_id: String,
    /// Sign-in with an app password or a token.
    pub auth: Auth,
    /// User for the sign-in, usually the address (`noreply@…`); with a
    /// token irrelevant for the sign-in.
    pub user: String,
    /// App password, encrypted with [`PASSWORD_PURPOSE`], as Base64 –
    /// only with [`Auth::Password`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_password_enc: Option<String>,
    /// Token, encrypted with [`TOKEN_PURPOSE`] – only with [`Auth::Token`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_enc: Option<String>,
    /// Identity (`mail.identity`); without it the first applies.
    pub identity_id: Option<String>,
    /// Sender name instead of the identity's (`mail.name`).
    pub sender_name: Option<String>,
    /// Reply-to address (`mail.replyTo`).
    pub reply_to: Option<String>,
    /// Copy in "Sent" (`mail.keepSent`).
    pub keep_sent: bool,
    /// Last check; missing as long as the connection is unchecked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<Check>,
}

/// What makes up a check (including the identity that `Mailer::test` checks
/// too): a result only applies as long as server, sign-in, user (only with
/// password), identity and the encrypted secret are the same.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    server_id: String,
    auth: Auth,
    user: Option<String>,
    identity_id: Option<String>,
    secret_enc: Option<String>,
}

/// Empty account (without server and secret) with the defaults: sign-in with
/// password, copy in "Sent".
impl Default for SystemMail {
    fn default() -> Self {
        Self {
            server_id: String::new(),
            auth: Auth::Password,
            user: String::new(),
            app_password_enc: None,
            token_enc: None,
            identity_id: None,
            sender_name: None,
            reply_to: None,
            keep_sent: true,
            check: None,
        }
    }
}

impl SystemMail {
    /// New sending account with app password; sender name and reply-to address
    /// empty, copy in "Sent" by default.
    pub fn new(
        secrets: &SecretKey,
        server_id: &str,
        user: &str,
        app_password: &str,
        identity_id: Option<String>,
    ) -> anyhow::Result<Self> {
        let mut mail = Self {
            server_id: server_id.to_owned(),
            user: user.to_owned(),
            identity_id,
            ..Self::default()
        };
        mail.set_secret(secrets, Auth::Password, app_password)?;
        Ok(mail)
    }

    /// The encrypted secret of the chosen sign-in.
    pub fn secret_enc(&self) -> Option<&str> {
        match self.auth {
            Auth::Password => self.app_password_enc.as_deref(),
            Auth::Token => self.token_enc.as_deref(),
        }
    }

    /// Switches to the sign-in `auth` with the secret `plain`; the secret of the
    /// other sign-in is dropped.
    pub fn set_secret(
        &mut self,
        secrets: &SecretKey,
        auth: Auth,
        plain: &str,
    ) -> anyhow::Result<()> {
        let sealed = secrets.seal(auth.purpose(), app_settings::SYSTEM_MAIL, plain.as_bytes())?;
        let sealed = Some(STANDARD.encode(sealed));
        self.auth = auth;
        (self.app_password_enc, self.token_enc) = match auth {
            Auth::Password => (sealed, None),
            Auth::Token => (None, sealed),
        };
        Ok(())
    }

    /// Forgets the secret of both sign-ins, e.g. because another server
    /// or a new address must not get it.
    pub fn forget_secret(&mut self) {
        self.app_password_enc = None;
        self.token_enc = None;
    }

    /// Switches to the sign-in `auth` without a new secret: the stored one
    /// stays only if it belongs to `auth`.
    pub fn set_auth(&mut self, auth: Auth) {
        if auth != self.auth {
            self.auth = auth;
            self.app_password_enc = None;
            self.token_enc = None;
        }
    }

    /// Decrypted secret of the chosen sign-in, if there is one.
    pub fn secret(&self, secrets: &SecretKey) -> anyhow::Result<Option<String>> {
        let Some(encoded) = self.secret_enc() else {
            return Ok(None);
        };
        let sealed = STANDARD
            .decode(encoded)
            .context("app_settings.system_mail: secret is not Base64")?;
        let plain = secrets.open(self.auth.purpose(), app_settings::SYSTEM_MAIL, &sealed)?;
        String::from_utf8(plain)
            .map(Some)
            .context("app_settings.system_mail: secret is not UTF-8")
    }

    pub fn credentials(&self) -> Credentials {
        Credentials {
            server_id: self.server_id.clone(),
            auth: self.auth,
            // Bearer needs no user.
            user: (self.auth == Auth::Password).then(|| self.user.clone()),
            identity_id: self.identity_id.clone(),
            secret_enc: self.secret_enc().map(str::to_owned),
        }
    }

    /// Sign-in and sender for [`super::Mailer`] with the server's base
    /// URL.
    pub fn account(&self, base_url: Url, secrets: &SecretKey) -> anyhow::Result<Account> {
        let secret = self
            .secret(secrets)?
            .ok_or_else(|| anyhow!("app_settings.system_mail: no secret for the sign-in"))?;
        let auth = match self.auth {
            Auth::Password => jmap::Auth::Basic {
                username: self.user.clone(),
                password: secret,
            },
            Auth::Token => jmap::Auth::Bearer(secret),
        };
        Ok(Account {
            base_url,
            auth,
            identity_id: self.identity_id.clone(),
            sender_name: self.sender_name.clone(),
            reply_to: self.reply_to.clone(),
            keep_sent: self.keep_sent,
        })
    }
}

pub fn load(conn: &Connection) -> anyhow::Result<Option<SystemMail>> {
    app_settings::get(conn, app_settings::SYSTEM_MAIL)
}

pub fn save(conn: &Connection, mail: &SystemMail) -> anyhow::Result<()> {
    app_settings::set(conn, app_settings::SYSTEM_MAIL, mail)
}

/// If the address of the server `server_id` changes, the sending account forgets
/// its secret if it uses this server: it never goes to an address it
/// was not entered for. Returns the field of the forgotten
/// secret (`app_password` or `token`) for the audit log.
pub fn forget_secret_of(
    conn: &Connection,
    server_id: &str,
) -> anyhow::Result<Option<&'static str>> {
    let Some(mut mail) = load(conn)? else {
        return Ok(None);
    };
    if mail.server_id != server_id || mail.secret_enc().is_none() {
        return Ok(None);
    }
    mail.forget_secret();
    save(conn, &mail)?;
    Ok(Some(mail.auth.secret_field()))
}

/// Base URL of a registry server; `None` if it does not exist.
pub fn base_url(conn: &Connection, server_id: &str) -> anyhow::Result<Option<Url>> {
    let Some(server) = servers::get(conn, server_id)? else {
        return Ok(None);
    };
    Url::parse(&server.base_url)
        .map(Some)
        .with_context(|| format!("servers.base_url of {} invalid", server.id))
}

/// Stored sending account with its server's base URL; `None` if
/// none is configured, the server is deleted or the secret of the chosen
/// sign-in is missing.
pub fn with_server(conn: &Connection) -> anyhow::Result<Option<(SystemMail, Url)>> {
    let Some(mail) = load(conn)?.filter(|mail| mail.secret_enc().is_some()) else {
        return Ok(None);
    };
    Ok(base_url(conn, &mail.server_id)?.map(|url| (mail, url)))
}

/// Whether a sending account is stored on a registry server, without a
/// connection test (`system_mail_configured` in `auth/me`).
pub fn is_configured(conn: &Connection) -> anyhow::Result<bool> {
    Ok(with_server(conn)?.is_some())
}

/// Sending account for [`super::Mailer::send`]; `None` if none is configured
/// (callers then do not send).
pub fn account(conn: &Connection, secrets: &SecretKey) -> anyhow::Result<Option<Account>> {
    with_server(conn)?
        .map(|(mail, base_url)| mail.account(base_url, secrets))
        .transpose()
}

/// Like [`account`], plus the connection for [`record`].
pub fn account_with_credentials(
    conn: &Connection,
    secrets: &SecretKey,
) -> anyhow::Result<Option<(Account, Credentials)>> {
    with_server(conn)?
        .map(|(mail, base_url)| Ok((mail.account(base_url, secrets)?, mail.credentials())))
        .transpose()
}

/// Result of a check or a send for [`record`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Connected; a check brings the identities along, a send
    /// does not (then the previous ones stay).
    Ok(Option<Vec<Identity>>),
    /// No connection, with a reason and, for `no_mailbox`, the role of the
    /// missing mailbox.
    Err(&'static str, Option<&'static str>),
}

impl Outcome {
    /// Failed check or failed send.
    pub fn failed(error: &MailError) -> Self {
        Self::Err(error.reason(), error.mailbox_role())
    }

    /// Result of a send; `None` for errors that only concern this mail
    /// and say nothing about the connection.
    pub fn of_send(result: &Result<(), MailError>) -> Option<Self> {
        match result {
            Ok(()) => Some(Self::Ok(None)),
            Err(error) if is_connection_error(error) => Some(Self::failed(error)),
            Err(_) => None,
        }
    }
}

/// Errors that affect the account as a whole: sign-in, reachability,
/// session, identity, mailboxes.
fn is_connection_error(error: &MailError) -> bool {
    match error {
        MailError::Locked(_) => true,
        MailError::Jmap(error) => matches!(
            error,
            jmap::Error::Unreachable
                | jmap::Error::AuthFailed
                | jmap::Error::Forbidden
                | jmap::Error::Throttled
                | jmap::Error::ForeignOrigin
                | jmap::Error::Unsupported(_)
                | jmap::Error::NoIdentity
                | jmap::Error::NoMailbox(_)
        ),
    }
}

/// After a successful result, a further success from sending writes
/// nothing for this long.
const REFRESH_SECS: i64 = 60;

/// Time like `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` in SQLite.
pub fn timestamp(at: Timestamp) -> String {
    at.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Writes the result to the stored account if it still has the connection
/// `credentials`; otherwise (changed or removed meanwhile) it is dropped.
/// Returns whether it was written.
pub fn record(
    conn: &mut Connection,
    credentials: &Credentials,
    at: Timestamp,
    outcome: Outcome,
) -> anyhow::Result<bool> {
    let tx = conn.transaction()?;
    let Some(mut mail) = load(&tx)? else {
        return Ok(false);
    };
    if mail.credentials() != *credentials {
        return Ok(false);
    }
    // A further success shortly after the last one only changes the time:
    // do not write on every mail (e.g. in the job `notification_mailer`).
    if outcome == Outcome::Ok(None)
        && mail.check.as_ref().is_some_and(|check| {
            check.ok
                && check.at.parse::<Timestamp>().is_ok_and(|last| {
                    at.duration_since(last) < jiff::SignedDuration::from_secs(REFRESH_SECS)
                })
        })
    {
        return Ok(false);
    }
    let identities = mail
        .check
        .take()
        .map(|check| check.identities)
        .unwrap_or_default();
    mail.check = Some(match outcome {
        Outcome::Ok(found) => Check {
            at: timestamp(at),
            ok: true,
            reason: None,
            role: None,
            identities: found.unwrap_or(identities),
        },
        Outcome::Err(reason, role) => Check {
            at: timestamp(at),
            ok: false,
            reason: Some(reason.to_owned()),
            role: role.map(str::to_owned),
            identities,
        },
    });
    save(&tx, &mail)?;
    tx.commit()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::{
        broker::probe::Status,
        db::{migrations, repo::servers::Fields},
    };

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn add_server(conn: &Connection, id: &str) {
        servers::insert(
            conn,
            id,
            &Fields {
                label: "VPS 1",
                base_url: "https://mail.s1.test",
                domains: &[],
                client_id: None,
            },
            None,
        )
        .unwrap();
        assert_eq!(servers::get(conn, id).unwrap().unwrap().reach, Status::Unk);
    }

    fn json_of(conn: &Connection) -> String {
        conn.query_row(
            "SELECT json FROM app_settings WHERE key = 'system_mail'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn stores_password_sealed_and_builds_account() {
        let conn = conn();
        let secrets = SecretKey::random().unwrap();
        assert!(!is_configured(&conn).unwrap());
        assert!(account(&conn, &secrets).unwrap().is_none());

        add_server(&conn, "s1");
        let mail =
            SystemMail::new(&secrets, "s1", "noreply@example.com", "kT9v-Qm2x", None).unwrap();
        save(&conn, &mail).unwrap();
        let json = json_of(&conn);
        assert!(!json.contains("kT9v"), "{json}");
        assert!(
            !json.contains("token_enc") && !json.contains("check"),
            "{json}"
        );
        assert_eq!(load(&conn).unwrap(), Some(mail));
        assert!(is_configured(&conn).unwrap());

        let account = account(&conn, &secrets).unwrap().unwrap();
        assert_eq!(account.base_url.as_str(), "https://mail.s1.test/");
        assert_eq!(
            account.auth,
            jmap::Auth::Basic {
                username: "noreply@example.com".into(),
                password: "kT9v-Qm2x".into(),
            }
        );
        assert!(account.keep_sent);
        assert_eq!(account.identity_id, None);

        // Another key cannot read the password.
        let other = SecretKey::random().unwrap();
        assert!(super::account(&conn, &other).is_err());
    }

    /// Stored accounts without `auth` and `check` read as password sign-in
    /// that has not been checked.
    #[test]
    fn token_replaces_the_password_and_signs_in_with_bearer() {
        let conn = conn();
        let secrets = SecretKey::random().unwrap();
        add_server(&conn, "s1");
        let mut mail = SystemMail::new(&secrets, "s1", "noreply@example.com", "pw", None).unwrap();
        mail.set_secret(&secrets, Auth::Token, "api-key-1").unwrap();
        assert_eq!(mail.app_password_enc, None);
        save(&conn, &mail).unwrap();
        let json = json_of(&conn);
        assert!(json.contains(r#""auth":"token""#), "{json}");
        assert!(!json.contains("api-key"), "{json}");

        let account = account(&conn, &secrets).unwrap().unwrap();
        assert_eq!(account.auth, jmap::Auth::Bearer("api-key-1".into()));

        // The token is bound to its purpose.
        let sealed = STANDARD.decode(mail.token_enc.as_ref().unwrap()).unwrap();
        assert!(
            secrets
                .open(PASSWORD_PURPOSE, app_settings::SYSTEM_MAIL, &sealed)
                .is_err()
        );

        // Back to the password without a new secret: none left.
        mail.set_auth(Auth::Password);
        assert_eq!(mail.secret(&secrets).unwrap(), None);
        assert!(
            mail.account("https://a.b".parse().unwrap(), &secrets)
                .is_err()
        );
    }

    /// With a token the user does not count towards the connection; without a secret
    /// the account counts as not configured.
    #[test]
    fn token_ignores_the_user_and_no_secret_is_not_configured() {
        let conn = conn();
        let secrets = SecretKey::random().unwrap();
        add_server(&conn, "s1");
        let mut mail = SystemMail::new(&secrets, "s1", "a@example.com", "pw", None).unwrap();
        mail.set_secret(&secrets, Auth::Token, "t").unwrap();
        let credentials = mail.credentials();
        mail.user = "b@example.com".into();
        assert_eq!(mail.credentials(), credentials);
        mail.set_auth(Auth::Password);
        assert_ne!(mail.credentials(), credentials);

        save(&conn, &mail).unwrap();
        assert!(!is_configured(&conn).unwrap());
        assert!(account(&conn, &secrets).unwrap().is_none());
    }

    #[test]
    fn not_configured_once_the_server_is_gone() {
        let conn = conn();
        let secrets = SecretKey::random().unwrap();
        add_server(&conn, "s1");
        save(
            &conn,
            &SystemMail::new(&secrets, "s1", "noreply@example.com", "x", None).unwrap(),
        )
        .unwrap();
        servers::delete(&conn, "s1").unwrap();
        assert!(!is_configured(&conn).unwrap());
        assert!(account(&conn, &secrets).unwrap().is_none());
    }

    #[test]
    fn password_is_bound_to_its_purpose() {
        let secrets = SecretKey::random().unwrap();
        let mail = SystemMail::new(&secrets, "s1", "noreply@example.com", "x", None).unwrap();
        let sealed = STANDARD
            .decode(mail.app_password_enc.as_ref().unwrap())
            .unwrap();
        assert!(
            secrets
                .open("servers.oauth_client_secret", "s1", &sealed)
                .is_err()
        );
    }

    #[test]
    fn records_results_only_for_the_same_connection() {
        let mut conn = conn();
        let secrets = SecretKey::random().unwrap();
        add_server(&conn, "s1");
        let mail = SystemMail::new(&secrets, "s1", "noreply@example.com", "x", None).unwrap();
        save(&conn, &mail).unwrap();
        let credentials = mail.credentials();
        let at = Timestamp::from_second(1_793_880_000).unwrap();
        let identity = Identity {
            id: "i1".into(),
            name: "Example".into(),
            email: "noreply@example.com".into(),
        };

        // A missing mailbox remembers its role, a success
        // afterwards forgets it (`GET` only names it for `err`).
        let missing = Outcome::Err("no_mailbox", Some("sent"));
        assert!(record(&mut conn, &credentials, at, missing).unwrap());
        let check = load(&conn).unwrap().unwrap().check.unwrap();
        assert_eq!(
            (check.ok, check.reason.as_deref(), check.role.as_deref()),
            (false, Some("no_mailbox"), Some("sent"))
        );

        let found = Outcome::Ok(Some(vec![identity.clone()]));
        assert!(record(&mut conn, &credentials, at, found).unwrap());
        let check = load(&conn).unwrap().unwrap().check.unwrap();
        assert_eq!(check.at, "2026-11-05T12:00:00.000Z");
        assert!(check.ok);
        assert_eq!((check.reason, check.role), (None, None));
        assert_eq!(check.identities, vec![identity.clone()]);

        // An error keeps the identities, a send without them too.
        let later = at + Duration::from_secs(60);
        assert!(
            record(
                &mut conn,
                &credentials,
                later,
                Outcome::Err("auth_failed", None)
            )
            .unwrap()
        );
        let check = load(&conn).unwrap().unwrap().check.unwrap();
        assert_eq!(
            (check.ok, check.reason.as_deref()),
            (false, Some("auth_failed"))
        );
        assert_eq!(check.identities, vec![identity.clone()]);
        assert!(record(&mut conn, &credentials, later, Outcome::Ok(None)).unwrap());
        let check = load(&conn).unwrap().unwrap().check.unwrap();
        assert!(check.ok && check.reason.is_none());
        assert_eq!(check.identities, vec![identity]);
        // Further successes from sending only write after a minute.
        let soon = later + Duration::from_secs(30);
        assert!(!record(&mut conn, &credentials, soon, Outcome::Ok(None)).unwrap());
        let minute = later + Duration::from_secs(61);
        assert!(record(&mut conn, &credentials, minute, Outcome::Ok(None)).unwrap());
        assert_eq!(
            load(&conn).unwrap().unwrap().check.unwrap().at,
            "2026-11-05T12:02:01.000Z"
        );

        // Another identity: the result does not apply to the account.
        let mut other = load(&conn).unwrap().unwrap();
        other.identity_id = Some("i2".into());
        assert_ne!(other.credentials(), credentials);

        // New secret: the old result no longer applies to the account.
        let mut changed = load(&conn).unwrap().unwrap();
        changed.set_secret(&secrets, Auth::Password, "new").unwrap();
        changed.check = None;
        save(&conn, &changed).unwrap();
        assert!(!record(&mut conn, &credentials, later, Outcome::Ok(None)).unwrap());
        assert_eq!(load(&conn).unwrap().unwrap().check, None);
    }

    #[test]
    fn only_connection_errors_of_a_send_change_the_status() {
        assert_eq!(Outcome::of_send(&Ok(())), Some(Outcome::Ok(None)));
        for (error, reason) in [
            (MailError::Locked(Duration::from_secs(5)), "auth_locked"),
            (MailError::Jmap(jmap::Error::AuthFailed), "auth_failed"),
            (MailError::Jmap(jmap::Error::Unreachable), "unreachable"),
            (MailError::Jmap(jmap::Error::NoIdentity), "no_identity"),
        ] {
            assert_eq!(
                Outcome::of_send(&Err(error)),
                Some(Outcome::Err(reason, None))
            );
        }
        assert_eq!(
            Outcome::of_send(&Err(MailError::Jmap(jmap::Error::NoMailbox("sent")))),
            Some(Outcome::Err("no_mailbox", Some("sent")))
        );
        for error in [
            jmap::Error::NotCreated {
                kind: "invalidRecipients".into(),
                description: None,
            },
            jmap::Error::Method("serverFail".into()),
            jmap::Error::InvalidResponse,
        ] {
            assert_eq!(Outcome::of_send(&Err(MailError::Jmap(error))), None);
        }
    }
}
