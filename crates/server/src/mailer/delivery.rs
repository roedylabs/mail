//! Sending a system mail with sending account, public address and
//! branding – for flows that wait for the result (email change),
//! and for mails in the background (security notices, "Forgot
//! password"). The result of every send keeps the status of the
//! sending account up to date.

use jiff::Timestamp;
use url::Url;

use super::{
    Account, Mail, MailError,
    format::Format,
    system_mail::{self, Credentials, Outcome},
    templates::{Brand, Context, Theme},
};
use crate::{app::AppState, db};

/// Everything a system mail needs.
pub struct Delivery {
    account: Account,
    /// Connection of the stored account for the status; `None` when
    /// testing a draft with a different connection ([`Self::for_account`]).
    credentials: Option<Credentials>,
    public_url: Url,
    brand: Brand,
}

/// Why no mail goes out before it is rendered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    /// No system mail configured (or its server is deleted).
    NoSystemMail,
    /// No public address, hence no links.
    NoPublicUrl,
}

impl Delivery {
    /// Loads the sending account and public address.
    pub async fn prepare(state: &AppState) -> anyhow::Result<Result<Self, Unavailable>> {
        let secrets = state.secrets.clone();
        let account = db::call(&state.db, move |conn| {
            system_mail::account_with_credentials(conn, &secrets)
        })
        .await?;
        let Some((account, credentials)) = account else {
            return Ok(Err(Unavailable::NoSystemMail));
        };
        Ok(Self::for_account(state, account, Some(credentials))
            .await?
            .ok_or(Unavailable::NoPublicUrl))
    }

    /// For a specific account, also from a draft (the test email from
    /// Administration › Email). The send only writes the status with
    /// `credentials`, i.e. for the stored connection. `None` without a
    /// public address.
    pub async fn for_account(
        state: &AppState,
        account: Account,
        credentials: Option<Credentials>,
    ) -> anyhow::Result<Option<Self>> {
        let Some(public_url) = state.public_url().await? else {
            return Ok(None);
        };
        Ok(Some(Self {
            account,
            credentials,
            public_url,
            brand: state.brand(),
        }))
    }

    /// Renders the mail with `render` in the recipient's time zone and format
    /// (`format`, from their settings; without an account the defaults)
    /// and sends it; the mailer writes the result to the log itself.
    /// It is sent light.
    pub async fn send(
        &self,
        state: &AppState,
        format: &Format,
        render: impl FnOnce(&Context<'_>) -> anyhow::Result<Mail>,
    ) -> anyhow::Result<Result<(), MailError>> {
        self.send_at(state, format, Timestamp::now(), render).await
    }

    /// Like [`Self::send`] with `now` as the reference for "Today" and "… ago".
    pub async fn send_at(
        &self,
        state: &AppState,
        format: &Format,
        now: Timestamp,
        render: impl FnOnce(&Context<'_>) -> anyhow::Result<Mail>,
    ) -> anyhow::Result<Result<(), MailError>> {
        let ctx = Context {
            brand: &self.brand,
            theme: Theme::Light,
            format,
            public_url: &self.public_url,
            now,
            inline_logo: false,
        };
        let mail = render(&ctx)?;
        let result = state.mailer.send(&self.account, &mail).await;
        if let (Some(credentials), Some(outcome)) =
            (self.credentials.clone(), Outcome::of_send(&result))
        {
            // The status is secondary: if writing it fails, the
            // send still counts.
            let written = db::call(&state.db, move |conn| {
                system_mail::record(conn, &credentials, Timestamp::now(), outcome)
            })
            .await;
            if let Err(error) = written {
                tracing::warn!(%error, "system mail status not stored");
            }
        }
        Ok(result)
    }
}
