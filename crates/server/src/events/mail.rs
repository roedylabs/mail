//! Security notices and system notices by mail:
//! collected in the transaction, sent in the background after the commit. Without
//! system mail or a public address the mail is dropped (only in the log); a
//! sending error does not change the event.

use std::net::IpAddr;

use jiff::Timestamp;

use super::{Recipient, Whereabouts};
use crate::{
    app::AppState,
    auth::device::Device,
    mailer::{
        Mail,
        delivery::{Delivery, Unavailable},
        format::Format,
        templates::{
            Context, Place, SecurityLogin, SecurityMfaReset, SecurityPassword,
            SecurityRecoveryCodes, SecurityRecoveryUsed, SecurityTotpAdded, SecurityTotpRemoved,
            SystemBackup, SystemUpdate,
        },
    },
};

/// Where a session is: device (the name is built when rendering in the
/// recipient's language, "Safari on iPhone"), place if known, and the
/// IP address.
#[derive(Debug, Clone)]
pub(super) struct Seen {
    device: Device,
    place: Option<String>,
    ip: IpAddr,
}

impl From<Whereabouts<'_>> for Seen {
    fn from(at: Whereabouts<'_>) -> Self {
        Self {
            device: at.device,
            place: at.place.map(str::to_owned),
            ip: at.ip,
        }
    }
}

impl Seen {
    fn place(&self) -> Place<'_> {
        Place {
            place: self.place.as_deref(),
            ip: self.ip,
        }
    }
}

/// Content of a mail for an event.
#[derive(Debug, Clone)]
pub(super) enum EventMail {
    Login {
        seen: Seen,
        at: Timestamp,
    },
    Password {
        device: Device,
        reset: bool,
        /// Sole active administrator.
        sole_admin: bool,
        at: Timestamp,
    },
    MfaReset {
        /// Display name of the administrator.
        by: String,
        at: Timestamp,
    },
    TotpAdded {
        app: String,
        first: bool,
        /// Sole active administrator.
        sole_admin: bool,
        seen: Seen,
        at: Timestamp,
    },
    TotpRemoved {
        app: String,
        last: bool,
        seen: Seen,
        at: Timestamp,
    },
    RecoveryUsed {
        remaining: u32,
        total: u32,
        new_device: bool,
        seen: Seen,
        at: Timestamp,
    },
    RecoveryCodes {
        seen: Seen,
        at: Timestamp,
    },
    /// System notice "Backup" to the administrators.
    SystemBackup {
        at: Timestamp,
        size: u64,
        keep_days: u32,
    },
    /// System notice "Update" to the administrators.
    SystemUpdate {
        version: String,
        previous: String,
    },
}

#[derive(Debug, Clone)]
struct Pending {
    to: String,
    name: String,
    /// Time zone and formats of the person.
    format: Format,
    mail: EventMail,
}

impl Pending {
    fn template(&self) -> &'static str {
        match self.mail {
            EventMail::Login { .. } => "security_login",
            EventMail::Password { .. } => "security_password",
            EventMail::MfaReset { .. } => "security_mfa_reset",
            EventMail::TotpAdded { .. } => "security_totp_add",
            EventMail::TotpRemoved { .. } => "security_totp_remove",
            EventMail::RecoveryUsed { .. } => "security_recovery_used",
            EventMail::RecoveryCodes { .. } => "security_recovery_codes",
            EventMail::SystemBackup { .. } => "system_backup",
            EventMail::SystemUpdate { .. } => "system_update",
        }
    }

    fn render(&self, ctx: &Context<'_>) -> anyhow::Result<Mail> {
        let (to, name) = (self.to.as_str(), self.name.as_str());
        let lang = ctx.format.lang();
        match &self.mail {
            EventMail::Login { seen, at } => SecurityLogin {
                to,
                name,
                device: &seen.device.label(lang),
                place: seen.place(),
                at: *at,
            }
            .render(ctx),
            EventMail::Password {
                device,
                reset,
                sole_admin,
                at,
            } => SecurityPassword {
                to,
                name,
                device: &device.label(lang),
                reset: *reset,
                sole_admin: *sole_admin,
                at: *at,
            }
            .render(ctx),
            EventMail::MfaReset { by, at } => SecurityMfaReset {
                to,
                name,
                by: Some(by.as_str()),
                at: *at,
            }
            .render(ctx),
            EventMail::TotpAdded {
                app,
                first,
                sole_admin,
                seen,
                at,
            } => SecurityTotpAdded {
                to,
                name,
                app,
                first_app: *first,
                sole_admin: *sole_admin,
                device: &seen.device.label(lang),
                place: seen.place(),
                at: *at,
            }
            .render(ctx),
            EventMail::TotpRemoved {
                app,
                last,
                seen,
                at,
            } => SecurityTotpRemoved {
                to,
                name,
                app,
                last: *last,
                device: &seen.device.label(lang),
                place: seen.place(),
                at: *at,
            }
            .render(ctx),
            EventMail::RecoveryUsed {
                remaining,
                total,
                new_device,
                seen,
                at,
            } => SecurityRecoveryUsed {
                to,
                name,
                remaining: *remaining,
                total: *total,
                new_device: *new_device,
                device: &seen.device.label(lang),
                place: seen.place(),
                at: *at,
            }
            .render(ctx),
            EventMail::RecoveryCodes { seen, at } => SecurityRecoveryCodes {
                to,
                name,
                device: &seen.device.label(lang),
                place: seen.place(),
                at: *at,
            }
            .render(ctx),
            EventMail::SystemBackup {
                at,
                size,
                keep_days,
            } => SystemBackup {
                to,
                name,
                at: *at,
                size: *size,
                keep_days: *keep_days,
            }
            .render(ctx),
            EventMail::SystemUpdate { version, previous } => SystemUpdate {
                to,
                name,
                version,
                previous,
            }
            .render(ctx),
        }
    }
}

/// Mails that go out after the commit. If it is not sent (error,
/// rollback), nothing goes out.
#[derive(Debug, Default)]
#[must_use = "send with Outbox::send after the commit"]
pub struct Outbox(Vec<Pending>);

impl Outbox {
    pub(super) fn push(&mut self, to: Recipient<'_>, format: Format, mail: EventMail) {
        self.0.push(Pending {
            to: to.email.to_owned(),
            name: to.name.to_owned(),
            format,
            mail,
        });
    }

    /// Sends the mails one after the other in the background (the mailer sends
    /// one at a time anyway).
    pub fn send(self, state: &AppState) {
        if self.0.is_empty() {
            return;
        }
        let worker = state.clone();
        state.background.spawn(async move {
            for pending in self.0 {
                if let Err(error) = deliver(&worker, &pending).await {
                    tracing::warn!(template = pending.template(), "notice not sent: {error:#}");
                }
            }
        });
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[cfg(test)]
    pub(super) fn templates(&self) -> Vec<&'static str> {
        self.0.iter().map(Pending::template).collect()
    }

    /// The mails as text, rendered as when sending, for tests.
    #[cfg(test)]
    pub(super) fn texts(&self, now: Timestamp) -> Vec<String> {
        use crate::mailer::templates::{Brand, Theme};
        let (brand, url) = (
            Brand::default(),
            url::Url::parse("https://app.example.com").unwrap(),
        );
        self.0
            .iter()
            .map(|pending| {
                let ctx = Context {
                    brand: &brand,
                    theme: Theme::Light,
                    format: &pending.format,
                    public_url: &url,
                    now,
                    inline_logo: false,
                };
                pending.render(&ctx).unwrap().text
            })
            .collect()
    }
}

async fn deliver(state: &AppState, pending: &Pending) -> anyhow::Result<()> {
    let delivery = match Delivery::prepare(state).await? {
        Ok(delivery) => delivery,
        Err(Unavailable::NoSystemMail) => {
            tracing::debug!(
                template = pending.template(),
                "no system mail configured, notice dropped"
            );
            return Ok(());
        }
        Err(Unavailable::NoPublicUrl) => {
            tracing::warn!(
                template = pending.template(),
                "no public address, notice dropped"
            );
            return Ok(());
        }
    };
    // The mailer writes the result to the log itself.
    let _ = delivery
        .send(state, &pending.format, |ctx| pending.render(ctx))
        .await?;
    Ok(())
}
