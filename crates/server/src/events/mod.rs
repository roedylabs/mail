//! Event catalogue: what appears in the app as a notification
//! (`notifications`) and which events trigger a security notice by mail
//! right away.
//!
//! Channels: global `nCh` (app, email, push), per topic `nMx`; security
//! notices always arrive in the app and by email, those two channels are
//! locked for the topic. A malicious session must not be able to switch the
//! warning off. The channels are in the recipient's settings
//! (`crate::settings`), without them the default settings apply. Events
//! without their own mail are queued for email by [`notify`]
//! (`notification_deliveries`); the job `notification_mailer` sends them
//! immediately or as a digest according to [`schedule`]. Web Push is queued
//! by [`notify`] and [`security`] alike if the recipient wants it for the
//! topic and a browser is signed in; the job `push_sender` sends security
//! notices at once, everything else outside the quiet hours.
//!
//! Event and details are stored, no finished texts: icon, title, text and
//! target are built when reading in [`texts`]; names and details follow the
//! catalogue.
//!
//! Callers report an event in the transaction of the change
//! ([`security`], [`account`], [`team`], [`news`], [`update_available`],
//! [`update_installed`], [`maintenance`]; "Storage almost full" is reported by
//! the job `quota_check`). Mails are collected in an [`Outbox`] that callers
//! send after the commit with [`Outbox::send`] – in the background, so the
//! response does not wait for the mail server.

mod mail;
pub mod schedule;
pub mod texts;

use std::net::IpAddr;

use jiff::Timestamp;
use rusqlite::Connection;
use serde_json::{Value, json};

pub use mail::Outbox;
use mail::{EventMail, Seen};

use crate::{
    auth::{AuthUser, device::Device, session::Origin},
    db::repo::{
        notification_deliveries::{self, Channel as Delivery},
        notifications, push_subscriptions,
        users::{self, Profile},
    },
    mailer::format::short_ip,
    settings::{self, ChannelSet, Settings},
};

/// Topic of a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Topic {
    Security,
    Account,
    Team,
    System,
    News,
}

impl Topic {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Security => "security",
            Self::Account => "account",
            Self::Team => "team",
            Self::System => "system",
            Self::News => "news",
        }
    }

    /// Topic from the stored name; `None` for unknown ones.
    pub fn parse(name: &str) -> Option<Self> {
        [
            Self::Security,
            Self::Account,
            Self::Team,
            Self::System,
            Self::News,
        ]
        .into_iter()
        .find(|topic| topic.as_str() == name)
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// Channel of a topic (`nCh`, `nMx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    App,
    Mail,
    Push,
}

/// Channels of a recipient from `nCh` and `nMx`. By default `nCh` is
/// `{ app, mail }` and `nMx` has email for security and account, push only for
/// security (effective only with `nCh.push`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Channels {
    /// `nCh`: app, email, push.
    global: [bool; 3],
    /// `nMx` per topic in the order of [`Topic`]: app, email, push.
    topics: [[bool; 3]; 5],
}

impl Default for Channels {
    fn default() -> Self {
        Self::from(&Settings::default())
    }
}

impl From<&Settings> for Channels {
    fn from(settings: &Settings) -> Self {
        let pick = |set: ChannelSet| [set.app, set.mail, set.push];
        let mx = &settings.n_mx;
        Self {
            global: pick(settings.n_ch),
            topics: [mx.security, mx.account, mx.team, mx.system, mx.news].map(pick),
        }
    }
}

impl Channels {
    /// From the recipient's settings.
    pub fn of(conn: &Connection, user_id: &str) -> anyhow::Result<Self> {
        Ok(Self::from(&settings::load(conn, user_id)?.settings))
    }

    pub fn wants(&self, topic: Topic, channel: Channel) -> bool {
        // Security notices always arrive in the app and by email, even
        // with the channel turned off: otherwise a stolen session could
        // turn off the warning before, say, adding an app. Push
        // stays selectable.
        if topic == Topic::Security && matches!(channel, Channel::App | Channel::Mail) {
            return true;
        }
        let i = channel as usize;
        self.global[i] && self.topics[topic.index()][i]
    }
}

/// Recipient of an event.
#[derive(Debug, Clone, Copy)]
pub struct Recipient<'a> {
    pub id: &'a str,
    pub email: &'a str,
    pub name: &'a str,
}

impl<'a> From<&'a AuthUser> for Recipient<'a> {
    fn from(user: &'a AuthUser) -> Self {
        Self {
            id: &user.id,
            email: &user.email,
            name: &user.display_name,
        }
    }
}

impl<'a> From<&'a Profile> for Recipient<'a> {
    fn from(user: &'a Profile) -> Self {
        Self {
            id: &user.id,
            email: &user.email,
            name: &user.display_name,
        }
    }
}

/// Where a session is: place if known, and the IP address.
#[derive(Debug, Clone, Copy)]
pub struct Whereabouts<'a> {
    pub device: Device,
    pub place: Option<&'a str>,
    pub ip: IpAddr,
}

impl<'a> From<&'a Origin> for Whereabouts<'a> {
    fn from(origin: &'a Origin) -> Self {
        Self {
            device: origin.device(),
            place: origin.place.as_deref(),
            ip: origin.ip,
        }
    }
}

/// Device as details: browser, operating system and kind as detected, no
/// finished name – that is only built when reading in the recipient's language.
/// Unknown parts are missing.
fn device_params(device: &Device) -> Value {
    json!({
        "browser": device.browser,
        "os": device.os,
        "device_type": device.kind.as_str(),
    })
}

/// Device with place (GeoIP, as stored) and truncated IP address – only
/// what the person may see about their own account.
fn whereabouts(at: &Whereabouts<'_>) -> Value {
    let mut params = device_params(&at.device);
    params["place"] = json!(at.place);
    params["ip"] = json!(short_ip(at.ip));
    params
}

/// Security events (to the person affected).
#[derive(Debug, Clone, Copy)]
pub enum Security<'a> {
    /// "New sign-in" from an unknown device; with mail
    /// `security_login`.
    Login {
        session_id: &'a str,
        at: Whereabouts<'a>,
    },
    /// "Password changed"; with mail `security_password`. `device` is the
    /// session that changed it, or the browser that opened the link from
    /// "Reset password" (`reset`). Without `reset` the mail
    /// advises "Forgot password" and the administration, and the sole
    /// administrator `roedy-mail reset-admin` ([`users::sole_admin`]).
    PasswordChanged {
        device: Device,
        sessions_ended: usize,
        reset: bool,
    },
    /// "Multi-factor reset" by an administrator (`by`, their
    /// display name); with mail `security_mfa_reset`. The person then signs
    /// in with the password only.
    MfaReset { by: &'a str },
    /// "Email address change requested": only in the app. The mails
    /// (`security_email` to the previous, `email_confirm` to the new
    /// address) are sent by the flow itself before the link is valid.
    EmailChangeRequested {
        new_email: &'a str,
        at: Whereabouts<'a>,
    },
    /// "Authenticator app added"; with mail `security_totp_add`. `at`
    /// is the session that added it. `first`: multi-factor is thereby
    /// on, removing it and changing the password require a code from exactly
    /// this app – the mail then advises notifying the administration,
    /// and the sole administrator to ask the operator for `roedy-mail reset-admin`
    /// ([`users::sole_admin`]).
    TotpAdded {
        name: &'a str,
        first: bool,
        at: Whereabouts<'a>,
    },
    /// "Authenticator app removed"; with mail `security_totp_remove`.
    /// `last`: multi-factor is off, the recovery codes are gone.
    TotpRemoved {
        name: &'a str,
        last: bool,
        at: Whereabouts<'a>,
    },
    /// "Recovery code used" (sign-in); with mail
    /// `security_recovery_used`. From an unknown device this is stated here
    /// (`new_device`) instead of in a second event "New sign-in": one
    /// mail, not two.
    RecoveryUsed {
        /// Still unused out of `total`.
        remaining: u32,
        total: u32,
        new_device: bool,
        session_id: &'a str,
        at: Whereabouts<'a>,
    },
    /// "New recovery codes generated": the previous ones are no longer
    /// valid; with mail `security_recovery_codes`. `at` is the session that
    /// created them.
    RecoveryCodesRenewed { at: Whereabouts<'a> },
}

impl Security<'_> {
    fn kind(&self) -> &'static str {
        match self {
            Self::Login { .. } => "security.login",
            Self::PasswordChanged { .. } => "security.password",
            Self::EmailChangeRequested { .. } => "security.email_change",
            Self::MfaReset { .. } => "security.mfa_reset",
            Self::TotpAdded { .. } => "security.totp_add",
            Self::TotpRemoved { .. } => "security.totp_remove",
            Self::RecoveryUsed { .. } => "security.recovery_used",
            Self::RecoveryCodesRenewed { .. } => "security.recovery_codes",
        }
    }

    /// Details for the text when reading. `sole_admin` only accompanies the first
    /// authenticator app: its advice depends on it like that of the mail.
    fn params(&self, sole_admin: bool) -> Value {
        let mut params = match self {
            Self::Login { session_id, at } => {
                let mut params = whereabouts(at);
                params["session_id"] = json!(session_id);
                params
            }
            Self::PasswordChanged {
                device,
                sessions_ended,
                reset,
            } => {
                let mut params = device_params(device);
                params["sessions_ended"] = json!(sessions_ended);
                params["reset"] = json!(reset);
                params
            }
            Self::EmailChangeRequested { new_email, at } => {
                let mut params = whereabouts(at);
                params["email"] = json!(new_email);
                params
            }
            Self::MfaReset { by } => json!({ "by": by }),
            Self::TotpAdded { name, first, at } => {
                let mut params = whereabouts(at);
                params["name"] = json!(name);
                params["first"] = json!(first);
                if *first {
                    params["sole_admin"] = json!(sole_admin);
                }
                params
            }
            Self::TotpRemoved { name, last, at } => {
                let mut params = whereabouts(at);
                params["name"] = json!(name);
                params["last"] = json!(last);
                params
            }
            Self::RecoveryUsed {
                remaining,
                total,
                new_device,
                session_id,
                at,
            } => {
                let mut params = whereabouts(at);
                params["remaining"] = json!(remaining);
                params["total"] = json!(total);
                params["new_device"] = json!(new_device);
                params["session_id"] = json!(session_id);
                params
            }
            Self::RecoveryCodesRenewed { at } => whereabouts(at),
        };
        if let Value::Object(map) = &mut params {
            map.retain(|_, value| !value.is_null());
        }
        params
    }

    /// Whether the mail's advice depends on whether the person is the sole active
    /// administrator: "Password changed" (not after "Reset password") and the
    /// first authenticator app.
    fn depends_on_sole_admin(&self) -> bool {
        matches!(
            self,
            Self::PasswordChanged { reset: false, .. } | Self::TotpAdded { first: true, .. }
        )
    }

    /// Immediate security notice by mail; every event with a mail has
    /// its own template.
    fn mail(&self, at: Timestamp, sole_admin: bool) -> Option<EventMail> {
        let seen = Seen::from;
        Some(match *self {
            Self::Login { at: w, .. } => EventMail::Login { seen: seen(w), at },
            Self::PasswordChanged { device, reset, .. } => EventMail::Password {
                device,
                reset,
                sole_admin,
                at,
            },
            Self::EmailChangeRequested { .. } => return None,
            Self::MfaReset { by } => EventMail::MfaReset {
                by: by.to_owned(),
                at,
            },
            Self::TotpAdded { name, first, at: w } => EventMail::TotpAdded {
                app: name.to_owned(),
                first,
                sole_admin,
                seen: seen(w),
                at,
            },
            Self::TotpRemoved { name, last, at: w } => EventMail::TotpRemoved {
                app: name.to_owned(),
                last,
                seen: seen(w),
                at,
            },
            Self::RecoveryUsed {
                remaining,
                total,
                new_device,
                at: w,
                ..
            } => EventMail::RecoveryUsed {
                remaining,
                total,
                new_device,
                seen: seen(w),
                at,
            },
            Self::RecoveryCodesRenewed { at: w } => EventMail::RecoveryCodes { seen: seen(w), at },
        })
    }
}

/// Reports a security event to `to`: in the app and by mail via
/// `outbox`, both always – the channels are locked for security
/// ([`Channels::wants`]). Push asks the channels and comes at once, even during
/// quiet hours. The mail names times in the person's time zone and
/// format. "Email address change requested" has no mail from the catalogue;
/// the flow sends those.
pub fn security(
    conn: &Connection,
    outbox: &mut Outbox,
    to: Recipient<'_>,
    event: Security<'_>,
) -> anyhow::Result<()> {
    let topic = Topic::Security;
    // In the event's transaction: the advice names `reset-admin` or
    // "Reset password" only if nobody else in the app can lock the
    // account.
    let sole_admin = event.depends_on_sole_admin() && users::sole_admin(conn, to.id)?;
    let params = event.params(sole_admin);
    let id = notifications::insert(conn, to.id, topic.as_str(), event.kind(), &params)?;
    if Channels::of(conn, to.id)?.wants(topic, Channel::Push) {
        queue_push(conn, to.id, topic, event.kind(), &params, Some(&id))?;
    }
    if let Some(mail) = event.mail(Timestamp::now(), sole_admin) {
        outbox.push(to, settings::format_of(conn, to.id)?, mail);
    }
    Ok(())
}

/// Team events (to all active administrators except the
/// acting one). A mail only comes via the digest (off by default).
#[derive(Debug, Clone, Copy)]
pub enum Team<'a> {
    /// "Invitation accepted": the new person.
    InviteAccepted { user_id: &'a str, name: &'a str },
    /// "Role changed".
    RoleChanged {
        user_id: &'a str,
        name: &'a str,
        role: &'a str,
    },
    /// "User suspended".
    UserLocked { user_id: &'a str, name: &'a str },
    /// "New invitation requested" from the page of an expired
    /// invitation, which tells the person that the inviter was notified.
    InviteRequested {
        invitation_id: &'a str,
        email: &'a str,
    },
}

impl Team<'_> {
    fn kind(&self) -> &'static str {
        match self {
            Self::InviteAccepted { .. } => "team.invite_accepted",
            Self::RoleChanged { .. } => "team.role_changed",
            Self::UserLocked { .. } => "team.user_locked",
            Self::InviteRequested { .. } => "team.invite_requested",
        }
    }

    fn params(&self) -> Value {
        match self {
            Self::InviteAccepted { user_id, name } | Self::UserLocked { user_id, name } => {
                json!({ "user_id": user_id, "name": name })
            }
            Self::RoleChanged {
                user_id,
                name,
                role,
            } => json!({ "user_id": user_id, "name": name, "role": role }),
            Self::InviteRequested {
                invitation_id,
                email,
            } => json!({ "invitation_id": invitation_id, "email": email }),
        }
    }
}

/// Reports a team event to all active administrators except
/// `actor` who want it in the app or by email; returns the number of
/// recipients.
pub fn team(conn: &Connection, event: Team<'_>, actor: Option<&str>) -> anyhow::Result<usize> {
    let mut sent = 0;
    for admin in notifications::admin_recipients(conn, actor)? {
        sent += usize::from(notify(
            conn,
            &admin,
            Topic::Team,
            event.kind(),
            &event.params(),
        )?);
    }
    Ok(sent)
}

/// Events about one's own account (to the person themselves). A mail
/// only comes via the digest (on by default).
#[derive(Debug, Clone, Copy)]
pub enum Account<'a> {
    /// "Profile changed" (`PATCH auth/me`): which fields.
    Profile { name: bool, username: bool },
    /// "Email address confirmed" (link from the mail): the new address.
    EmailConfirmed { email: &'a str },
    /// "Storage almost full" (job `quota_check`): address of the mail account,
    /// used and limit in bytes, share in percent. The ID takes the app
    /// to the account's overview.
    Quota {
        mail_account_id: &'a str,
        account: &'a str,
        used: u64,
        limit: u64,
        percent: u8,
    },
}

impl Account<'_> {
    fn kind(&self) -> &'static str {
        match self {
            Self::Profile { .. } => "account.profile",
            Self::EmailConfirmed { .. } => "account.email_confirmed",
            Self::Quota { .. } => "account.quota",
        }
    }

    fn params(&self) -> Value {
        match *self {
            Self::Profile { name, username } => {
                let fields: Vec<&str> = [name.then_some("name"), username.then_some("username")]
                    .into_iter()
                    .flatten()
                    .collect();
                json!({ "fields": fields })
            }
            Self::EmailConfirmed { email } => json!({ "email": email }),
            Self::Quota {
                mail_account_id,
                account,
                used,
                limit,
                percent,
            } => json!({
                "mail_account_id": mail_account_id,
                "account": account,
                "used": used,
                "limit": limit,
                "percent": percent,
            }),
        }
    }
}

/// Reports an account event to the person `user_id` if they want it in the
/// app or by email; `true` if it is reported.
pub fn account(conn: &Connection, user_id: &str, event: Account<'_>) -> anyhow::Result<bool> {
    notify(conn, user_id, Topic::Account, event.kind(), &event.params())
}

/// News (to everyone).
#[derive(Debug, Clone, Copy)]
pub enum News<'a> {
    /// "Welcome" on account creation (setup, invitation
    /// accepted).
    Welcome,
    /// "New in version …" after an update, with the first item of the
    /// release notes if they are known.
    Release {
        version: &'a str,
        summary: Option<&'a str>,
    },
}

impl News<'_> {
    fn kind(self) -> &'static str {
        match self {
            Self::Welcome => "news.welcome",
            Self::Release { .. } => "news.release",
        }
    }

    fn params(self) -> Value {
        match self {
            Self::Welcome => json!({}),
            Self::Release {
                version,
                summary: Some(summary),
            } => json!({ "version": version, "summary": summary }),
            Self::Release {
                version,
                summary: None,
            } => json!({ "version": version }),
        }
    }
}

/// Reports a news item to the person `user_id` if they want it in the app
/// or by email; `true` if it is reported.
pub fn news(conn: &Connection, user_id: &str, event: News<'_>) -> anyhow::Result<bool> {
    notify(conn, user_id, Topic::News, event.kind(), &event.params())
}

/// "Update available" to all active administrators; a mail
/// only comes via the digest (off by default).
pub fn update_available(conn: &Connection, version: &str) -> anyhow::Result<usize> {
    system(
        conn,
        "system.update_available",
        &json!({ "version": version }),
    )
}

/// "Maintenance mode turned on/off" to all active administrators,
/// including the acting `by`; a mail only comes via
/// the digest (off by default).
pub fn maintenance(conn: &Connection, on: bool, by: &str) -> anyhow::Result<usize> {
    let kind = if on {
        "system.maintenance_on"
    } else {
        "system.maintenance_off"
    };
    system(conn, kind, &json!({ "by": by }))
}

/// Reports a system event without its own mail to all active administrators;
/// returns the number of recipients.
fn system(conn: &Connection, kind: &str, params: &Value) -> anyhow::Result<usize> {
    let mut sent = 0;
    for admin in notifications::admin_recipients(conn, None)? {
        sent += usize::from(notify(conn, &admin, Topic::System, kind, params)?);
    }
    Ok(sent)
}

/// "Update installed" to all active administrators. The mail
/// is the system notice `system_update` instead of an entry in the digest,
/// according to the topic's channels.
pub fn update_installed(
    conn: &Connection,
    outbox: &mut Outbox,
    version: &str,
    previous: &str,
) -> anyhow::Result<usize> {
    system_with_mail(
        conn,
        outbox,
        "system.update_installed",
        &json!({ "version": version, "from": previous }),
        &EventMail::SystemUpdate {
            version: version.to_owned(),
            previous: previous.to_owned(),
        },
    )
}

/// "Backup created" to all active administrators after a scheduled
/// backup, with the system notice `system_backup` instead of an entry in the
/// digest.
pub fn backup_created(
    conn: &Connection,
    at: Timestamp,
    size: u64,
    keep_days: u32,
) -> anyhow::Result<Outbox> {
    let mut outbox = Outbox::default();
    system_with_mail(
        conn,
        &mut outbox,
        "system.backup_ok",
        &json!({ "size": size }),
        &EventMail::SystemBackup {
            at,
            size,
            keep_days,
        },
    )?;
    Ok(outbox)
}

/// "Backup failed" to all active administrators. The template
/// `system_backup` only knows success; a mail comes via the digest.
pub fn backup_failed(conn: &Connection) -> anyhow::Result<usize> {
    system(conn, "system.backup_failed", &json!({}))
}

/// Reports a system event with its own mail to all active administrators:
/// app and push like [`notify`], the mail into the `outbox` if the recipient
/// wants it for the topic.
fn system_with_mail(
    conn: &Connection,
    outbox: &mut Outbox,
    kind: &str,
    params: &Value,
    event: &EventMail,
) -> anyhow::Result<usize> {
    let topic = Topic::System;
    let mut sent = 0;
    for admin in users::active_admins(conn)? {
        let channels = Channels::of(conn, &admin.id)?;
        let shown = app_and_push(conn, &admin.id, channels, topic, kind, params)?;
        let mail = channels.wants(topic, Channel::Mail);
        if mail {
            outbox.push(
                Recipient::from(&admin),
                settings::format_of(conn, &admin.id)?,
                event.clone(),
            );
        }
        sent += usize::from(shown || mail);
    }
    Ok(sent)
}

/// Reports an event without its own mail according to the recipient's channels:
/// in the app as a notification, queued by email for immediate delivery or
/// the digest – also without the app, e.g. `nMx.account` with
/// `app: false, mail: true` –, queued by Web Push for the job
/// `push_sender`. `true` if at least one channel gets it.
fn notify(
    conn: &Connection,
    user_id: &str,
    topic: Topic,
    kind: &str,
    params: &Value,
) -> anyhow::Result<bool> {
    debug_assert!(topic != Topic::Security, "security has its own mails");
    let channels = Channels::of(conn, user_id)?;
    let mail = channels.wants(topic, Channel::Mail);
    if mail {
        notification_deliveries::insert(
            conn,
            user_id,
            Delivery::Mail,
            topic.as_str(),
            kind,
            params,
            None,
        )?;
    }
    Ok(app_and_push(conn, user_id, channels, topic, kind, params)? || mail)
}

/// The part of [`notify`] without email, for events with their own mail.
/// `true` if the app or Web Push gets it.
fn app_and_push(
    conn: &Connection,
    user_id: &str,
    channels: Channels,
    topic: Topic,
    kind: &str,
    params: &Value,
) -> anyhow::Result<bool> {
    let app = channels.wants(topic, Channel::App);
    let id = if app {
        Some(notifications::insert(
            conn,
            user_id,
            topic.as_str(),
            kind,
            params,
        )?)
    } else {
        None
    };
    let push = channels.wants(topic, Channel::Push)
        && queue_push(conn, user_id, topic, kind, params, id.as_deref())?;
    Ok(app || push)
}

/// Queues Web Push if a browser of `user_id` is signed in, and
/// wakes the job `push_sender`; `notification_id` becomes the `tag`. `true`
/// if queued.
fn queue_push(
    conn: &Connection,
    user_id: &str,
    topic: Topic,
    kind: &str,
    params: &Value,
    notification_id: Option<&str>,
) -> anyhow::Result<bool> {
    if !push_subscriptions::any(conn, user_id)? {
        return Ok(false);
    }
    notification_deliveries::insert(
        conn,
        user_id,
        Delivery::Push,
        topic.as_str(),
        kind,
        params,
        notification_id,
    )?;
    crate::push::wake();
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };
    use crate::mailer::format::{DateFormat, Format, TimeFormat};

    fn wants_system_mail(conn: &Connection, id: &str) {
        let Value::Object(changes) = json!({
            "nMx": { "system": { "app": false, "mail": true, "push": false } },
        }) else {
            unreachable!()
        };
        let changed = Settings::default().apply(&changes).unwrap();
        settings::save(conn, id, 0, &changed).unwrap();
    }

    #[test]
    fn a_backup_has_its_own_mail_instead_of_the_digest() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let ben = add(&conn, "ben", "ben@example.com", Role::Admin);
        add(&conn, "mia", "mia@example.com", Role::User);
        wants_system_mail(&conn, &ben);

        let at = "2026-11-04T00:30:00Z".parse().unwrap();
        let outbox = backup_created(&conn, at, 1024 * 1024, 30).unwrap();

        // Anna: only in the app (default). Ben: only by email, and as a
        // system notice, not queued for the digest.
        let shown = notifications::list(&conn, &anna).unwrap();
        assert_eq!(shown[0].kind, "system.backup_ok");
        assert!(notifications::list(&conn, &ben).unwrap().is_empty());
        assert_eq!(outbox.templates(), ["system_backup"]);
        let text = &outbox.texts(Timestamp::now())[0];
        assert!(text.contains("30 days"), "{text}");
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM notification_deliveries", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(queued, 0);
    }

    #[test]
    fn a_failed_backup_goes_through_the_digest() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        add(&conn, "mia", "mia@example.com", Role::User);

        assert_eq!(backup_failed(&conn).unwrap(), 1);

        let shown = notifications::list(&conn, &anna).unwrap();
        assert_eq!(shown[0].kind, "system.backup_failed");
    }

    #[test]
    fn update_installed_has_its_own_mail_instead_of_the_digest() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let ben = add(&conn, "ben", "ben@example.com", Role::Admin);
        add(&conn, "mia", "mia@example.com", Role::User);
        wants_system_mail(&conn, &ben);
        let digest = |conn: &Connection| -> Vec<String> {
            conn.prepare("SELECT user_id FROM notification_deliveries WHERE channel = 'mail'")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };

        let mut outbox = Outbox::default();
        assert_eq!(
            update_installed(&conn, &mut outbox, "0.8.0", "0.7.0").unwrap(),
            2
        );
        // Anna: only in the app (default). Ben: only by email, and as a
        // system notice, not queued for the digest.
        assert_eq!(notifications::list(&conn, &anna).unwrap().len(), 1);
        assert!(notifications::list(&conn, &ben).unwrap().is_empty());
        assert_eq!(outbox.templates(), ["system_update"]);
        assert!(digest(&conn).is_empty());
        let text = &outbox.texts(Timestamp::now())[0];
        assert!(text.contains("0.8.0") && text.contains("0.7.0"), "{text}");

        // "Update available" has no mail of its own: Ben gets it via the
        // digest.
        assert_eq!(update_available(&conn, "0.9.0").unwrap(), 2);
        assert_eq!(digest(&conn), [ben]);
    }

    #[test]
    fn release_news_carries_the_summary_when_known() {
        let conn = conn();
        let mia = add(&conn, "mia", "mia@example.com", Role::User);
        let with = News::Release {
            version: "0.8.0",
            summary: Some("New page"),
        };
        let without = News::Release {
            version: "0.8.1",
            summary: None,
        };
        assert!(news(&conn, &mia, with).unwrap());
        assert!(news(&conn, &mia, without).unwrap());
        assert_eq!(
            with.params(),
            json!({ "version": "0.8.0", "summary": "New page" })
        );
        assert_eq!(without.params(), json!({ "version": "0.8.1" }));
        assert_eq!(with.kind(), "news.release");
    }

    #[test]
    fn default_channels() {
        let channels = Channels::default();
        assert!(channels.wants(Topic::Security, Channel::App));
        assert!(channels.wants(Topic::Security, Channel::Mail));
        assert!(channels.wants(Topic::Account, Channel::Mail));
        assert!(channels.wants(Topic::Team, Channel::App));
        assert!(!channels.wants(Topic::Team, Channel::Mail));
        assert!(!channels.wants(Topic::News, Channel::Mail));
        // Push is globally off (`nCh.push`), but preselected for security.
        assert!(!channels.wants(Topic::Security, Channel::Push));
        let push = Channels {
            global: [true, true, true],
            ..channels
        };
        assert!(push.wants(Topic::Security, Channel::Push));
        assert!(!push.wants(Topic::Account, Channel::Push));
        // Security stays on in the app and by email, even without the
        // channels and without the topic; push does not.
        let off = Channels {
            global: [false, false, false],
            topics: [[false, false, false]; 5],
        };
        assert!(off.wants(Topic::Security, Channel::App));
        assert!(off.wants(Topic::Security, Channel::Mail));
        assert!(!off.wants(Topic::Security, Channel::Push));
        assert!(!off.wants(Topic::Account, Channel::Mail));
        assert!(!off.wants(Topic::Team, Channel::App));
    }

    fn device() -> Device {
        Device::parse(Some(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Safari/604.1",
        ))
    }

    #[test]
    fn security_events_go_to_the_app_and_by_mail() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        let profile = Profile {
            id: id.clone(),
            username: "max".into(),
            email: "max@example.com".into(),
            display_name: "Max Mustermann".into(),
            role: Role::User,
        };
        let mut outbox = Outbox::default();
        let at = Whereabouts {
            device: device(),
            place: Some("Hamburg, Germany"),
            ip: "203.0.113.56".parse().unwrap(),
        };
        security(
            &conn,
            &mut outbox,
            (&profile).into(),
            Security::Login {
                session_id: "s1",
                at,
            },
        )
        .unwrap();
        security(
            &conn,
            &mut outbox,
            (&profile).into(),
            Security::TotpAdded {
                name: "Phone",
                first: true,
                at: Whereabouts { place: None, ..at },
            },
        )
        .unwrap();
        security(
            &conn,
            &mut outbox,
            (&profile).into(),
            Security::RecoveryCodesRenewed { at },
        )
        .unwrap();

        let listed = notifications::list(&conn, &id).unwrap();
        let kinds: Vec<&str> = listed.iter().map(|n| n.kind.as_str()).collect();
        assert_eq!(
            kinds,
            [
                "security.recovery_codes",
                "security.totp_add",
                "security.login"
            ]
        );
        assert_eq!(
            listed[2].params,
            json!({
                "browser": "Safari",
                "os": "iPhone",
                "device_type": "mobile",
                "place": "Hamburg, Germany",
                "ip": "203.0.x.x",
                "session_id": "s1",
            })
        );
        // Without a place it is also missing from the details.
        assert_eq!(
            listed[1].params,
            json!({
                "browser": "Safari",
                "os": "iPhone",
                "device_type": "mobile",
                "ip": "203.0.x.x",
                "name": "Phone",
                "first": true,
                "sole_admin": false,
            })
        );
        assert_eq!(
            listed[0].params,
            json!({
                "browser": "Safari",
                "os": "iPhone",
                "device_type": "mobile",
                "place": "Hamburg, Germany",
                "ip": "203.0.x.x",
            })
        );
        assert!(listed.iter().all(|n| n.topic == "security"));
        assert_eq!(
            outbox.templates(),
            [
                "security_login",
                "security_totp_add",
                "security_recovery_codes"
            ]
        );
    }

    /// The first app's advice depends, as in the mail, on whether the person
    /// is the sole active administrator.
    #[test]
    fn first_app_knows_whether_the_admin_is_alone() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let profile = Profile {
            id: anna.clone(),
            username: "anna".into(),
            email: "anna@example.com".into(),
            display_name: "Anna Becker".into(),
            role: Role::Admin,
        };
        let at = Whereabouts {
            device: device(),
            place: None,
            ip: "203.0.113.56".parse().unwrap(),
        };
        let add_app = |first| {
            security(
                &conn,
                &mut Outbox::default(),
                (&profile).into(),
                Security::TotpAdded {
                    name: "Phone",
                    first,
                    at,
                },
            )
            .unwrap();
            notifications::list(&conn, &anna).unwrap().remove(0).params
        };
        assert_eq!(add_app(true)["sole_admin"], json!(true));
        assert_eq!(add_app(false).get("sole_admin"), None, "only the first app");
        add(&conn, "lukas", "lukas@example.com", Role::Admin);
        assert_eq!(add_app(true)["sole_admin"], json!(false));
    }

    #[test]
    fn email_change_goes_to_the_app_only() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        let profile = Profile {
            id: id.clone(),
            username: "max".into(),
            email: "max@example.com".into(),
            display_name: "Max Mustermann".into(),
            role: Role::User,
        };
        let mut outbox = Outbox::default();
        let at = Whereabouts {
            device: device(),
            place: None,
            ip: "203.0.113.56".parse().unwrap(),
        };
        let event = Security::EmailChangeRequested {
            new_email: "new@example.com",
            at,
        };
        security(&conn, &mut outbox, (&profile).into(), event).unwrap();
        let reset = Security::PasswordChanged {
            device: device(),
            sessions_ended: 2,
            reset: true,
        };
        security(&conn, &mut outbox, (&profile).into(), reset).unwrap();
        // The mails of the email change are sent by the flow itself.
        assert_eq!(outbox.templates(), ["security_password"]);
        let listed = notifications::list(&conn, &id).unwrap();
        assert_eq!(listed[1].kind, "security.email_change");
        assert_eq!(listed[1].params["email"], "new@example.com");
        assert_eq!(listed[1].params["ip"], "203.0.x.x");
        assert_eq!(listed[0].kind, "security.password");
        assert_eq!(listed[0].params["reset"], true);
        assert_eq!(listed[0].params["sessions_ended"], 2);
    }

    #[test]
    fn mfa_reset_names_the_admin() {
        let conn = conn();
        let id = add(&conn, "lukas", "lukas@example.com", Role::User);
        let profile = Profile {
            id: id.clone(),
            username: "lukas".into(),
            email: "lukas@example.com".into(),
            display_name: "Lukas Wagner".into(),
            role: Role::User,
        };
        let mut outbox = Outbox::default();
        let event = Security::MfaReset {
            by: "Max Mustermann",
        };
        security(&conn, &mut outbox, (&profile).into(), event).unwrap();
        assert_eq!(outbox.templates(), ["security_mfa_reset"]);
        let listed = notifications::list(&conn, &id).unwrap();
        assert_eq!(listed[0].kind, "security.mfa_reset");
        assert_eq!(listed[0].params, json!({ "by": "Max Mustermann" }));
    }

    #[test]
    fn channels_and_mail_format_come_from_the_settings() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let lukas = add(&conn, "lukas", "lukas@example.com", Role::Admin);
        let Value::Object(changes) = json!({
            "nCh": { "app": false, "mail": false, "push": false },
            "tz": "America/New_York",
            "dateFmt": "us",
            "timeFmt": "12h",
        }) else {
            unreachable!()
        };
        let quiet = Settings::default().apply(&changes).unwrap();
        settings::save(&conn, &lukas, 0, &quiet).unwrap();
        let channels = Channels::of(&conn, &lukas).unwrap();
        assert!(!channels.wants(Topic::Team, Channel::App));
        assert!(!channels.wants(Topic::Account, Channel::Mail));
        // Security stays on in the app and by email.
        assert!(channels.wants(Topic::Security, Channel::App));
        assert!(channels.wants(Topic::Security, Channel::Mail));
        assert_eq!(Channels::of(&conn, &anna).unwrap(), Channels::default());

        // Team only to Anna: Lukas has turned off the app as a channel.
        let event = Team::UserLocked {
            user_id: "u1",
            name: "Mia Koch",
        };
        assert_eq!(team(&conn, event, None).unwrap(), 1);
        assert!(notifications::list(&conn, &lukas).unwrap().is_empty());

        // Security in the app anyway, the mail in his time zone and
        // formats.
        let profile = Profile {
            id: lukas.clone(),
            username: "lukas".into(),
            email: "lukas@example.com".into(),
            display_name: "Lukas Wagner".into(),
            role: Role::Admin,
        };
        let mut outbox = Outbox::default();
        let event = Security::PasswordChanged {
            device: device(),
            sessions_ended: 0,
            reset: false,
        };
        let before = Timestamp::now();
        security(&conn, &mut outbox, (&profile).into(), event).unwrap();
        let after = Timestamp::now();
        assert_eq!(notifications::list(&conn, &lukas).unwrap().len(), 1);
        // Read three days later so that the date is shown.
        let later = after
            .checked_add(jiff::SignedDuration::from_hours(72))
            .unwrap();
        let text = &outbox.texts(later)[0];
        let line = text
            .lines()
            .find(|line| line.starts_with("Time: "))
            .unwrap();
        let format = Format::new(
            "America/New_York",
            DateFormat::Us,
            TimeFormat::H12,
            crate::settings::Language::English,
        );
        let expected = [before, after].map(|at| format!("Time: {}", format.when(at, later)));
        assert!(
            expected.iter().any(|e| e == line),
            "{line} instead of {expected:?}"
        );
        assert!(line.contains('/') && line.ends_with('M'), "{line}");
    }

    #[test]
    fn team_events_reach_other_admins() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let lukas = add(&conn, "lukas", "lukas@example.com", Role::Admin);
        let max = add(&conn, "max", "max@example.com", Role::User);
        let event = Team::UserLocked {
            user_id: &max,
            name: "Max Mustermann",
        };
        assert_eq!(team(&conn, event, Some(&anna)).unwrap(), 1);
        assert!(notifications::list(&conn, &anna).unwrap().is_empty());
        assert!(notifications::list(&conn, &max).unwrap().is_empty());
        let got = notifications::list(&conn, &lukas).unwrap();
        assert_eq!(got[0].kind, "team.user_locked");
        assert_eq!(got[0].topic, "team");
        assert_eq!(got[0].params["name"], "Max Mustermann");

        // Without an acting administrator (public page) to everyone.
        let event = Team::InviteRequested {
            invitation_id: "i1",
            email: "jonas@example.com",
        };
        assert_eq!(team(&conn, event, None).unwrap(), 2);
        let got = notifications::list(&conn, &anna).unwrap();
        assert_eq!(got[0].kind, "team.invite_requested");
        assert_eq!(
            got[0].params,
            json!({ "invitation_id": "i1", "email": "jonas@example.com" })
        );
    }

    #[test]
    fn account_and_news_events_follow_the_catalog() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let event = Account::Profile {
            name: true,
            username: true,
        };
        assert!(account(&conn, &max, event).unwrap());
        let event = Account::EmailConfirmed {
            email: "new@example.com",
        };
        assert!(account(&conn, &max, event).unwrap());
        let event = Account::Quota {
            mail_account_id: "A1",
            account: "max@example.com",
            used: 96_636_764,
            limit: 104_857_600,
            percent: 92,
        };
        assert!(account(&conn, &max, event).unwrap());
        assert!(news(&conn, &max, News::Welcome).unwrap());
        let got: Vec<(String, String, Value)> = notifications::list(&conn, &max)
            .unwrap()
            .into_iter()
            .rev()
            .map(|n| (n.topic, n.kind, n.params))
            .collect();
        let row = |topic: &str, kind: &str, params: Value| (topic.into(), kind.into(), params);
        assert_eq!(
            got,
            [
                row(
                    "account",
                    "account.profile",
                    json!({ "fields": ["name", "username"] })
                ),
                row(
                    "account",
                    "account.email_confirmed",
                    json!({ "email": "new@example.com" })
                ),
                row(
                    "account",
                    "account.quota",
                    json!({
                        "mail_account_id": "A1",
                        "account": "max@example.com",
                        "used": 96_636_764,
                        "limit": 104_857_600,
                        "percent": 92,
                    })
                ),
                row("news", "news.welcome", json!({})),
            ]
        );
        let only_username = Account::Profile {
            name: false,
            username: true,
        };
        assert_eq!(only_username.params(), json!({ "fields": ["username"] }));

        // Without the app as the topic's channel no notification; with
        // email queued for immediate delivery or the digest.
        let Value::Object(changes) = json!({
            "nMx": {
                "account": { "app": false, "mail": true, "push": false },
                "news": { "app": false, "mail": false, "push": false },
            },
        }) else {
            unreachable!()
        };
        let quiet = Settings::default().apply(&changes).unwrap();
        settings::save(&conn, &max, 0, &quiet).unwrap();
        assert!(account(&conn, &max, only_username).unwrap());
        assert!(!news(&conn, &max, News::Welcome).unwrap());
        assert_eq!(notifications::list(&conn, &max).unwrap().len(), 4);
        let mails: Vec<String> =
            notification_deliveries::pending(&conn, Delivery::Mail, &max, "2999-01-01T00:00:00Z")
                .unwrap()
                .into_iter()
                .map(|pending| pending.kind)
                .collect();
        assert_eq!(
            mails,
            [
                "account.profile",
                "account.email_confirmed",
                "account.quota",
                "account.profile"
            ],
            "account by email as by default, news not"
        );
    }
}
