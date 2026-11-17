//! Restore: the server keeps running. The backup is unpacked
//! into a working copy, checked, migrated to the schema of this program
//! version and prepared for operation; only then does the online backup API
//! copy it into the live database in one step. Until then nothing changes,
//! afterwards everything is done: the shared connection has nothing else to do
//! meanwhile, and SQLite writes the pages in one transaction.
//!
//! Only a backup of this instance gets that far: [`archive::read`] checks the
//! MAC over manifest and database. The audit log is not reset: it is the
//! history of the instance, including the restore itself.

use std::{collections::HashMap, error::Error, fmt, path::Path};

use anyhow::Context as _;
use rusqlite::{Connection, params_from_iter, types::Value};

use super::{Backup, Workspace, archive};
use crate::{
    api::{ApiError, users::admin_holds},
    app::AppState,
    auth::AuthUser,
    broker::crypto::SecretKey,
    db::{
        self, migrations,
        repo::{
            app_settings,
            audit_log::{self, Entry},
            sessions, update_state, users,
        },
    },
    instance::{self, CLIENT_CACHE_VERSION},
    updates,
};

/// Why a backup does not fit this instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Not a readable archive, a damaged database, too large to unpack, or
    /// changed since it was created (the MAC does not fit).
    Invalid,
    /// Created with a newer program version.
    Newer,
    /// In the first format, without MAC: where its database comes from cannot
    /// be checked.
    Older,
    /// Created with a different instance key: secrets such as multi-factor and
    /// mail account credentials would not be readable.
    OtherKey,
    /// The administrator's session ended during preparation.
    Unauthorized,
    /// The administrator was demoted during preparation.
    Forbidden,
}

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "backup not readable",
            Self::Newer => "backup from a newer program version",
            Self::Older => "backup in an older format without MAC",
            Self::OtherKey => "backup with a different instance key",
            Self::Unauthorized => "session ended",
            Self::Forbidden => "no longer an administrator",
        })
    }
}

impl Error for Refused {}

/// Resets all data to the state of `backup`. The session of `admin` stays if
/// its user is active there; all others end. `entry` is the audit log entry.
/// The caller holds the lock from [`super::Backups::try_begin`].
pub async fn restore(
    state: &AppState,
    backup: &Backup,
    admin: AuthUser,
    entry: Entry,
) -> anyhow::Result<()> {
    let backups = state.backups.clone();
    let path = backups.path(backup);
    let secrets = state.secrets.clone();
    let (work, mut copy) = db::blocking(move || {
        let work = Workspace::new(&backups)?;
        let copy = prepare(work.path(), &path, &secrets)?;
        Ok((work, copy))
    })
    .await?;
    let worker = state.clone();
    let result = db::call(&state.db, move |live| {
        // Unpacking, checks and migrations lie between request and copy;
        // whoever loses their session or role in that time no longer resets
        // anything.
        match admin_holds(live, &admin)? {
            Ok(()) => {}
            Err(ApiError::Forbidden) => return Err(Refused::Forbidden.into()),
            Err(_) => return Err(Refused::Unauthorized.into()),
        }
        let kept = sessions::stored(live, &admin.session_id)?;
        let version = instance::load_client_cache_version(live)?;
        let invitations = invitations(live)?;
        finish(&mut copy, live, kept.as_ref(), version, &invitations, entry)?;
        db::copy(&copy, live)?;
        drop(copy);
        // On the database thread, so that no request reads the new state
        // together with the old cache.
        worker.reload(live)?;
        // The data is replaced; a large `-wal` does not change that.
        if let Err(error) = db::checkpoint(live) {
            tracing::warn!("no checkpoint after restore: {error:#}");
        }
        Ok(())
    })
    .await;
    db::blocking(move || {
        drop(work);
        Ok(())
    })
    .await?;
    result
}

/// Unpacks and checks the backup and migrates the working copy to the schema
/// of this program version.
fn prepare(work: &Path, archive: &Path, secrets: &SecretKey) -> anyhow::Result<Connection> {
    let database = db::db_path(work);
    archive::read(archive, &database, secrets)?;
    let mut copy = open_checked(&database)?;
    migrations::run(&mut copy).context("working copy of the backup not prepared")?;
    Ok(copy)
}

/// Opens the working copy and checks it before the migrations, so that a newer
/// or damaged database is recognized as such.
fn open_checked(database: &Path) -> anyhow::Result<Connection> {
    let checked = (|| {
        let conn = db::open_copy(database)?;
        let check: String = conn.query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))?;
        let schema = migrations::current_version(&conn)?;
        anyhow::Ok((conn, check, schema))
    })();
    let (conn, check, schema) = checked.map_err(|error| {
        tracing::warn!("backup database not readable: {error:#}");
        Refused::Invalid
    })?;
    anyhow::ensure!(check == "ok" && schema >= 1, Refused::Invalid);
    anyhow::ensure!(schema <= migrations::latest_version(), Refused::Newer);
    Ok(conn)
}

/// Invitations in the live state: ID → role and expiry.
type Invitations = HashMap<String, (String, String)>;

fn invitations(conn: &Connection) -> rusqlite::Result<Invitations> {
    let mut statement = conn.prepare("SELECT id, role, expires_at FROM invitations")?;
    statement
        .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?
        .collect()
}

fn invitations_of(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT id FROM invitations")?;
    statement.query_map([], |row| row.get(0))?.collect()
}

/// Prepares the working copy. All sessions end, otherwise those
/// ended since the backup would be valid again; only `kept` stays. Likewise
/// links from mails: reset and email change links all end;
/// invitations only stay if they still exist in the live state
/// (`invitations`), with its role and expiry – otherwise revoked, already
/// accepted or demoted ones would be valid again. The cache version rises
/// above the live one (`version`), so that all browsers discard the old state.
/// The installed version is the running one, otherwise the next start after an
/// older backup would report an update. The audit log is the one of the live
/// state (`live`, see [`keep_audit_log`]). If the backup does not know the
/// acting person, the audit log keeps their name.
fn finish(
    copy: &mut Connection,
    live: &Connection,
    kept: Option<&sessions::Stored>,
    version: u64,
    invitations: &Invitations,
    mut entry: Entry,
) -> anyhow::Result<()> {
    let tx = copy.transaction()?;
    sessions::delete_all(&tx)?;
    if let Some(kept) = kept {
        sessions::put_back(&tx, kept)?;
    }
    tx.execute("DELETE FROM password_resets", [])?;
    tx.execute("DELETE FROM email_changes", [])?;
    for id in invitations_of(&tx)? {
        match invitations.get(&id) {
            Some((role, expires_at)) => tx.execute(
                "UPDATE invitations SET role = ?2, expires_at = ?3 WHERE id = ?1",
                (&id, role, expires_at),
            )?,
            None => tx.execute("DELETE FROM invitations WHERE id = ?1", [&id])?,
        };
    }
    let version = version.max(instance::load_client_cache_version(&tx)?) + 1;
    app_settings::set(&tx, CLIENT_CACHE_VERSION, &version)?;
    update_state::set_installed(&tx, updates::VERSION)?;
    keep_audit_log(&tx, live)?;
    if let Some(actor) = &entry.actor_id
        && users::credentials_by_id(&tx, actor)?.is_none()
    {
        entry.actor_id = None;
    }
    audit_log::insert(&tx, &entry)?;
    tx.commit()?;
    Ok(())
}

/// Replaces the audit log of the working copy with the live one, row by row
/// with all columns and IDs: entries since the backup stay (downloads,
/// exports, sign-ins), the older ones are the same in both. Entries of people
/// the backup does not know keep the name, but lose the reference
/// (`actor_id`), as after deleting a user.
fn keep_audit_log(copy: &Connection, live: &Connection) -> rusqlite::Result<()> {
    let mut select = live.prepare("SELECT * FROM audit_log ORDER BY id")?;
    let columns: Vec<String> = select
        .column_names()
        .map(|name| format!("\"{}\"", name.replace('"', "\"\"")))
        .collect();
    let marks: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();
    copy.execute("DELETE FROM audit_log", [])?;
    // The references are fixed below, before the commit.
    copy.pragma_update(None, "defer_foreign_keys", true)?;
    let mut insert = copy.prepare(&format!(
        "INSERT INTO audit_log ({}) VALUES ({})",
        columns.join(", "),
        marks.join(", ")
    ))?;
    let mut rows = select.query([])?;
    while let Some(row) = rows.next()? {
        let values = (0..columns.len())
            .map(|i| row.get::<_, Value>(i))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        insert.execute(params_from_iter(values))?;
    }
    copy.execute(
        "UPDATE audit_log SET actor_id = NULL WHERE actor_id NOT IN (SELECT id FROM users)",
        [],
    )?;
    Ok(())
}
