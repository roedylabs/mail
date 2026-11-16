//! Daily storage check: for
//! every signed-in mail account of active users the job asks once a day
//! with an access token from the broker for `Quota/get` and stores the storage
//! like "Check connection" on the mail account overview. From 90 % it reports
//! "storage almost full" (`account.quota`) – once, until the storage is back
//! below. The job runs hourly like `server_probe` so that restarts do not
//! shift the rhythm; a failed attempt counts too, otherwise it would ask
//! a broken server every hour.

use std::time::Duration;

use roedy_jmap::Storage;
use rusqlite::Connection;
use url::Url;

use super::Job;
use crate::{
    app::AppState,
    broker::{account, token},
    db::{
        self,
        repo::{
            mail_accounts::{self, MailAccount},
            servers,
        },
    },
    events::{self, Account},
};

/// Interval between checks per account.
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// From this share on the storage is "almost full" – as in the account's
/// overview (`full`).
const THRESHOLD: u8 = 90;

pub fn job() -> Job<AppState> {
    Job {
        name: "quota_check",
        first: Duration::from_secs(15 * 60),
        every: Duration::from_secs(60 * 60),
        run: |state| Box::pin(run(state)),
        wake: None,
    }
}

/// Outcome of a check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    /// Storage according to the mail server (`None` without a limit).
    Checked(Option<Storage>),
    /// Failed (written to the log); counts as the day's attempt.
    Failed,
    /// The broker is currently throttling the server (`Limited`, e.g. after a
    /// temporary error of another account): no attempt, the
    /// next run asks again – otherwise a single error would shift all
    /// other accounts of the server by a day.
    Later,
}

async fn run(state: AppState) -> anyhow::Result<()> {
    let due = db::call(&state.db, |conn| {
        Ok(mail_accounts::due_for_quota_check(conn, EVERY)?)
    })
    .await?;
    for account in due {
        // One after the other; an error only affects this account.
        let outcome = check(&state, &account).await;
        if outcome == Outcome::Later {
            continue;
        }
        let id = account.id.clone();
        let saved = db::call(&state.db, move |conn| {
            let tx = conn.transaction()?;
            record(&tx, &account, outcome)?;
            tx.commit()?;
            Ok(())
        })
        .await;
        if let Err(error) = saved {
            tracing::warn!(account = %id, "storage not stored: {error:#}");
        }
    }
    Ok(())
}

/// Asks the mail server for the storage. Unlike "Check connection" without a
/// second attempt with a refreshed token: the next day there is a
/// new one anyway.
async fn check(state: &AppState, account: &MailAccount) -> Outcome {
    let id = &account.id;
    let access = match token::for_backend(state, id).await {
        Ok(access) => access,
        Err(token::Error::Limited(_)) => {
            tracing::debug!(account = %id, "check storage later: server throttled");
            return Outcome::Later;
        }
        Err(token::Error::Internal(error)) => {
            tracing::warn!(account = %id, "storage not checked: {error:#}");
            return Outcome::Failed;
        }
        Err(error) => {
            tracing::info!(account = %id, reason = error.reason(), "storage not checked");
            return Outcome::Failed;
        }
    };
    let base_url = match Url::parse(&account.base_url) {
        Ok(url) => url,
        Err(error) => {
            tracing::warn!(account = %id, "storage not checked: {error}");
            return Outcome::Failed;
        }
    };
    // Look it up now, not at the start of the run: a server removed in the
    // meantime is a custom one and only goes through the SSRF guard.
    let origin = account.base_url.clone();
    let registered = db::call(&state.db, move |conn| {
        Ok(servers::find_by_base_url(conn, &origin)?.is_some())
    })
    .await;
    let registered = match registered {
        Ok(registered) => registered,
        Err(error) => {
            tracing::warn!(account = %id, "storage not checked: {error:#}");
            return Outcome::Failed;
        }
    };
    let http = state.mail_http(registered);
    match account::storage(http, &base_url, access.access_token).await {
        Ok(storage) => Outcome::Checked(storage),
        Err(error) => {
            tracing::info!(account = %id, reason = error.reason(), "storage not checked");
            Outcome::Failed
        }
    }
}

/// Stores an attempt in the transaction: always the time, with a
/// result also the storage, and reports "storage almost full" when the
/// share has reached the threshold since the last report.
fn record(conn: &Connection, account: &MailAccount, outcome: Outcome) -> anyhow::Result<()> {
    mail_accounts::mark_quota_job(conn, &account.id)?;
    let Outcome::Checked(storage) = outcome else {
        return Ok(());
    };
    let quota = storage.map(|Storage { used, total }| (used, total));
    if mail_accounts::store_check(conn, &account.user_id, &account.id, quota)?.is_none() {
        // Removed in the meantime.
        return Ok(());
    }
    let full = match storage {
        Some(storage) => percent(storage)
            .filter(|percent| *percent >= THRESHOLD)
            .map(|percent| (storage, percent)),
        None => None,
    };
    let Some((Storage { used, total }, percent)) = full else {
        mail_accounts::set_quota_alert(conn, &account.id, false)?;
        return Ok(());
    };
    if mail_accounts::set_quota_alert(conn, &account.id, true)? {
        let event = Account::Quota {
            mail_account_id: &account.id,
            account: &account.email,
            used,
            limit: total,
            percent,
        };
        events::account(conn, &account.user_id, event)?;
    }
    Ok(())
}

/// Used share in whole percent, rounded and at most 100 – like the
/// account's overview; `None` without a limit.
fn percent(Storage { used, total }: Storage) -> Option<u8> {
    if total == 0 {
        return None;
    }
    let (used, total) = (u128::from(used), u128::from(total));
    let rounded = (used * 200 + total) / (total * 2);
    Some(u8::try_from(rounded.min(100)).unwrap_or(100))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::{
        mail_accounts::{AuthKind, NewAccount},
        notifications,
        users::{
            Role,
            tests::{add, conn},
        },
    };

    #[test]
    fn rounds_like_the_overview() {
        let of = |used, total| percent(Storage { used, total });
        assert_eq!(of(0, 100), Some(0));
        assert_eq!(of(895, 1000), Some(90));
        assert_eq!(of(894, 1000), Some(89));
        assert_eq!(of(999, 1000), Some(100));
        assert_eq!(of(2000, 1000), Some(100));
        assert_eq!(of(u64::MAX, u64::MAX), Some(100));
        assert_eq!(of(5, 0), None);
    }

    #[test]
    fn reports_once_per_crossing() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        mail_accounts::insert(
            &conn,
            &NewAccount {
                id: "A1",
                user_id: &max,
                base_url: "https://mail.example.com",
                email: "max@example.com",
                account_id: "a",
                username: "max@example.com",
                auth_kind: AuthKind::Token,
                client_id: None,
                secret_enc: b"sealed",
                access_token_enc: None,
                expires_in: None,
                session_json: "{}",
                color: 0,
            },
        )
        .unwrap();
        let account = mail_accounts::get(&conn, &max, "A1").unwrap().unwrap();
        let mib = 1024 * 1024;
        let check = |used: u64| {
            let storage = Storage {
                used,
                total: 100 * mib,
            };
            record(&conn, &account, Outcome::Checked(Some(storage))).unwrap();
            notifications::list(&conn, &max).unwrap()
        };

        assert!(check(50 * mib).is_empty());
        let stored = mail_accounts::get(&conn, &max, "A1").unwrap().unwrap();
        assert_eq!(stored.quota_used, Some(50 * 1024 * 1024));
        let got = check(92 * mib);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "account.quota");
        assert_eq!(got[0].topic, "account");
        assert_eq!(
            got[0].params,
            serde_json::json!({
                "mail_account_id": "A1",
                "account": "max@example.com",
                "used": 92 * mib,
                "limit": 100 * mib,
                "percent": 92,
            })
        );
        // If the storage stays full, no second report – not even after
        // a failed attempt in between.
        assert_eq!(check(97 * mib).len(), 1);
        record(&conn, &account, Outcome::Failed).unwrap();
        assert_eq!(check(98 * mib).len(), 1);
        // Below again, then above again: new report.
        assert_eq!(check(80 * mib).len(), 1);
        assert_eq!(check(95 * mib).len(), 2);
        record(&conn, &account, Outcome::Checked(None)).unwrap();
        let unlimited = mail_accounts::get(&conn, &max, "A1").unwrap().unwrap();
        assert_eq!(unlimited.quota_total, None);
        assert_eq!(check(91 * mib).len(), 3);
    }
}
