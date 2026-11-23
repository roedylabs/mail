//! Backups (admin API `backups`, scheduled job, events; managed under
//! Administration › Maintenance).
//!
//! - The files in `<ROEDY_DATA_DIR>/backups` are the list: the name carries the
//!   time, kind and ID, the size comes from the file system. That way they
//!   survive a restore, and a copied-in file shows up by itself. Only the page
//!   also reads the manifest's format ([`Backups::legacy`]).
//! - [`create`] writes a snapshot through the online backup API and packs it
//!   ([`archive`]). Finished files only appear by being renamed; intermediate
//!   files live in [`Workspace`] and go with it.
//! - [`scheduled`] is the job: daily or weekly, followed by retention
//!   ([`Backups::prune`]), event and system notice.
//! - [`restore()`] resets all data, without a restart.

pub mod archive;
pub mod restore;

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::Context as _;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use jiff::{SignedDuration, Timestamp, civil::DateTime, tz::TimeZone};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{Mutex, OwnedMutexGuard};
use ulid::Ulid;

pub use restore::{Refused, restore};

use crate::{
    app::AppState,
    broker::crypto::SecretKey,
    db::{
        self, migrations,
        repo::{
            app_settings,
            audit_log::{self, Category, Entry},
            users,
        },
    },
    events, instance,
};

/// Subdirectory in the data directory.
const DIR: &str = "backups";
/// Key of the settings in `app_settings`.
pub const KEY: &str = "backups";
/// Key in `app_settings`: start of the last scheduled attempt, including a
/// failed one.
const ATTEMPTED_AT: &str = "backups_attempted_at";
/// Retention in days (`bkKeepOpts`).
pub const KEEP_DAYS: [u32; 3] = [7, 30, 90];

const NAME_PREFIX: &str = "roedy-mail-";
const NAME_SUFFIX: &str = ".tar.zst";
const NAME_TIME: &str = "%Y%m%dT%H%M%SZ";
const AUTO: &str = "auto";
const MANUAL: &str = "manual";
/// Intermediate files (directories); no list counts them.
const WORK_PREFIX: &str = ".tmp-";
/// Purpose of the fingerprint in the manifest ([`key_mark`]).
const KEY_PURPOSE: &str = "backups.key";
const SECONDS_PER_DAY: i64 = 24 * 60 * 60;

/// Interval between two backups (`BK_EVERY`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Every {
    #[default]
    #[serde(rename = "daily")]
    Daily,
    #[serde(rename = "weekly")]
    Weekly,
}

impl Every {
    fn interval(self) -> SignedDuration {
        SignedDuration::from_secs(match self {
            Self::Daily => SECONDS_PER_DAY,
            Self::Weekly => 7 * SECONDS_PER_DAY,
        })
    }
}

/// Settings in `app_settings.backups`; defaults like the initial state of the
/// shell (`bkAuto`, `bkEvery`, `bkKeep`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub auto: bool,
    pub every: Every,
    /// Retention in days, see [`KEEP_DAYS`].
    pub keep: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto: true,
            every: Every::default(),
            keep: 30,
        }
    }
}

impl Settings {
    /// Next scheduled backup (`bkNext`); `None` if none is scheduled. Without a
    /// previous one it is due right away.
    pub fn next_at(&self, last: Option<Timestamp>, now: Timestamp) -> Option<Timestamp> {
        self.auto.then(|| {
            last.map_or(now, |last| {
                last.checked_add(self.every.interval()).unwrap_or(last)
            })
        })
    }
}

/// Settings from the database; if they are not readable, the defaults
/// apply.
pub fn load(conn: &Connection) -> anyhow::Result<Settings> {
    Ok(instance::load(conn, KEY, |_| Settings::default())?.unwrap_or_default())
}

pub fn save(conn: &Connection, settings: &Settings) -> anyhow::Result<()> {
    app_settings::set(conn, KEY, settings)
}

/// A backup in the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backup {
    pub id: String,
    pub at: Timestamp,
    pub auto: bool,
    pub size: u64,
    /// File name, also for the download.
    pub file: String,
}

impl Backup {
    fn file_name(id: &str, at: Timestamp, auto: bool) -> String {
        let kind = if auto { AUTO } else { MANUAL };
        let at = at.strftime(NAME_TIME);
        format!("{NAME_PREFIX}{at}-{kind}-{id}{NAME_SUFFIX}")
    }

    /// `None` for anything that is not a backup of this program.
    fn parse(file: &str, size: u64) -> Option<Self> {
        let rest = file.strip_prefix(NAME_PREFIX)?.strip_suffix(NAME_SUFFIX)?;
        let [at, kind, id]: [&str; 3] = rest.split('-').collect::<Vec<_>>().try_into().ok()?;
        let at = DateTime::strptime(NAME_TIME, at)
            .ok()?
            .to_zoned_datetime(TimeZone::UTC)
            .ok()?
            .timestamp();
        let auto = match kind {
            AUTO => true,
            MANUAL => false,
            _ => return None,
        };
        Ulid::from_string(id).ok()?;
        Some(Self {
            id: id.to_owned(),
            at,
            auto,
            size,
            file: file.to_owned(),
        })
    }
}

/// The backup directory and the lock for everything that writes into it or
/// replaces the database.
#[derive(Debug)]
pub struct Backups {
    dir: PathBuf,
    running: Arc<Mutex<()>>,
}

impl Backups {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join(DIR),
            running: Arc::default(),
        }
    }

    /// One backup or restore at a time; `None` if one is already running.
    pub fn try_begin(&self) -> Option<OwnedMutexGuard<()>> {
        self.running.clone().try_lock_owned().ok()
    }

    /// All backups, newest first. Foreign files are ignored.
    pub fn list(&self) -> io::Result<Vec<Backup>> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut backups = Vec::new();
        for entry in entries {
            let entry = entry?;
            let backup = entry.file_name().to_str().and_then(|name| {
                let meta = entry.metadata().ok().filter(fs::Metadata::is_file)?;
                Backup::parse(name, meta.len())
            });
            backups.extend(backup);
        }
        backups.sort_by(|a, b| (b.at, &b.id).cmp(&(a.at, &a.id)));
        Ok(backups)
    }

    /// The backup `id`. The path only ever comes from the list, never from the
    /// request.
    pub fn find(&self, id: &str) -> io::Result<Option<Backup>> {
        Ok(self.list()?.into_iter().find(|backup| backup.id == id))
    }

    pub fn path(&self, backup: &Backup) -> PathBuf {
        self.dir.join(&backup.file)
    }

    /// Whether `backup` is in the older format without an authenticity value
    /// ([`archive::legacy`]); only the list needs this, so [`Self::list`]
    /// reads no file. Blocks.
    pub fn legacy(&self, backup: &Backup) -> bool {
        archive::legacy(&self.path(backup))
    }

    /// `false` if the file is already gone.
    pub fn delete(&self, backup: &Backup) -> io::Result<bool> {
        match fs::remove_file(self.path(backup)) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Size of all backups in bytes and their count (`admin/storage`).
    pub fn usage(&self) -> io::Result<(u64, usize)> {
        let backups = self.list()?;
        Ok((backups.iter().map(|b| b.size).sum(), backups.len()))
    }

    /// Deletes automatic backups older than `keep_days` days. Only runs after a
    /// successful backup: if backups fail or are switched off,
    /// the last resort is kept.
    fn prune(&self, keep_days: u32, now: Timestamp) -> io::Result<usize> {
        let keep = SignedDuration::from_secs(i64::from(keep_days) * SECONDS_PER_DAY);
        let Ok(limit) = now.checked_sub(keep) else {
            return Ok(0);
        };
        let mut deleted = 0;
        for backup in self.list()? {
            if backup.auto && backup.at < limit && self.delete(&backup)? {
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    /// Removes intermediate files left behind by a crash or restart. At startup
    /// and with the lock held: then none of them is in use.
    pub fn sweep(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let leftover = entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(WORK_PREFIX));
            if leftover && let Err(error) = fs::remove_dir_all(entry.path()) {
                tracing::warn!("intermediate backup files not deleted: {error}");
            }
        }
    }

    /// Makes the finished file `name` from `work` visible. The file is already
    /// on disk ([`archive::write`]); the directory follows so that after a
    /// power failure retention has not deleted the last real backup. Some file
    /// systems (network shares, FUSE) refuse this; the backup is there
    /// anyway.
    fn publish(&self, work: &Workspace, name: &str, size: u64) -> anyhow::Result<Backup> {
        fs::rename(work.path().join(name), self.dir.join(name))?;
        if let Err(error) = fs::File::open(&self.dir).and_then(|dir| dir.sync_all()) {
            tracing::warn!("backup directory not synced: {error}");
        }
        Backup::parse(name, size).context("backup name not readable")
    }
}

/// Directory for intermediate files next to the backups, on the same volume;
/// goes with the value. The caller holds the lock.
struct Workspace(PathBuf);

impl Workspace {
    fn new(backups: &Backups) -> anyhow::Result<Self> {
        db::create_private_dir(&backups.dir)
            .with_context(|| format!("cannot create directory {}", backups.dir.display()))?;
        backups.sweep();
        let path = backups.dir.join(format!("{WORK_PREFIX}{}", db::new_id()?));
        db::create_private_dir(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            tracing::warn!("intermediate backup files not deleted: {error}");
        }
    }
}

/// Fingerprint of the instance key for the manifest. It does not reveal the
/// key, and it is the same in every backup: it only names the reason when the
/// MAC does not fit ([`Refused::OtherKey`]); the MAC
/// ([`archive::Manifest::mac`]) is the proof.
fn key_mark(secrets: &SecretKey) -> String {
    STANDARD.encode(secrets.mac(KEY_PURPOSE, &[]))
}

/// Creates a backup; the caller holds the lock from [`Backups::try_begin`].
/// The shared connection is only busy for the snapshot; packing runs
/// alongside.
pub async fn create(state: &AppState, auto: bool) -> anyhow::Result<Backup> {
    let backups = state.backups.clone();
    let work = db::blocking(move || Workspace::new(&backups)).await?;
    let at = Timestamp::now();
    let name = Backup::file_name(&db::new_id()?, at, auto);
    let database = db::db_path(work.path());
    let snapshot = database.clone();
    let manifest = db::call(&state.db, move |conn| {
        db::snapshot(conn, &snapshot)?;
        let schema = migrations::current_version(conn)?;
        Ok(archive::Manifest::new(at, auto, schema))
    })
    .await?;
    let backups = state.backups.clone();
    let secrets = state.secrets.clone();
    db::blocking(move || {
        let size = archive::write(&database, &manifest, &secrets, &work.path().join(&name))?;
        backups.publish(&work, &name, size)
    })
    .await
}

/// Last scheduled backup: the last attempt, otherwise the newest file from
/// `list`. The file counts too, because the attempt lives in the database and
/// a restore resets it.
pub fn last_run(conn: &Connection, list: &[Backup]) -> anyhow::Result<Option<Timestamp>> {
    let attempted: Option<String> = instance::load(conn, ATTEMPTED_AT, |_| None)?.flatten();
    let attempted = attempted.and_then(|at| at.parse().ok());
    let newest = list.iter().find(|b| b.auto).map(|b| b.at);
    Ok(attempted.max(newest))
}

/// The settings, if the scheduled backup is due. Before setup there is nothing
/// to back up and nobody to notify.
fn due(conn: &Connection, backups: &Backups, now: Timestamp) -> anyhow::Result<Option<Settings>> {
    let settings = load(conn)?;
    // An unreadable directory should be reported by the attempt, not this query.
    let list = backups.list().unwrap_or_default();
    let due = settings
        .next_at(last_run(conn, &list)?, now)
        .is_some_and(|next| next <= now);
    Ok((due && users::admin_exists(conn)?).then_some(settings))
}

/// The job: backs up when due. A failed attempt counts too, otherwise it would
/// run every minute on a full disk; the next one follows at the next
/// scheduled time.
pub async fn scheduled(state: &AppState) -> anyhow::Result<()> {
    let now = Timestamp::now();
    let backups = state.backups.clone();
    let settings = db::call(&state.db, move |conn| due(conn, &backups, now)).await?;
    let Some(settings) = settings else {
        return Ok(());
    };
    // If one is already running, the scheduled one follows a minute later.
    let Some(_running) = state.backups.try_begin() else {
        return Ok(());
    };
    db::call(&state.db, move |conn| {
        app_settings::set(conn, ATTEMPTED_AT, &now.to_string())
    })
    .await?;
    match create(state, true).await {
        Ok(backup) => created(state, &backup, settings.keep).await,
        Err(error) => failed(state, &error).await,
    }
}

/// Retention, event and audit log after a scheduled backup.
async fn created(state: &AppState, backup: &Backup, keep_days: u32) -> anyhow::Result<()> {
    let (at, size) = (backup.at, backup.size);
    let backups = state.backups.clone();
    match db::blocking(move || Ok(backups.prune(keep_days, at)?)).await {
        Ok(0) => {}
        Ok(deleted) => tracing::info!(deleted, "old backups deleted"),
        Err(error) => tracing::warn!("old backups not deleted: {error:#}"),
    }
    let outbox = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let outbox = events::backup_created(&tx, at, size, keep_days)?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::System, "backups.auto").details(json!({ "size": size })),
        )?;
        tx.commit()?;
        Ok(outbox)
    })
    .await?;
    outbox.send(state);
    Ok(())
}

/// Event and audit log after a failed scheduled backup. The cause is only in
/// the log.
async fn failed(state: &AppState, error: &anyhow::Error) -> anyhow::Result<()> {
    tracing::error!("backup failed: {error:#}");
    db::call(&state.db, |conn| {
        let tx = conn.transaction()?;
        events::backup_failed(&tx)?;
        audit_log::insert(&tx, &Entry::new(Category::System, "backups.failed"))?;
        tx.commit()?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    const ID: &str = "01KA0000000000000000000000";

    fn backups(dir: &Path) -> Backups {
        let backups = Backups::new(dir);
        fs::create_dir(&backups.dir).unwrap();
        backups
    }

    /// Creates a backup as a file with `size` bytes.
    fn file(backups: &Backups, id: &str, time: &str, auto: bool, size: usize) -> String {
        let name = Backup::file_name(id, at(time), auto);
        fs::write(backups.dir.join(&name), vec![0; size]).unwrap();
        name
    }

    #[test]
    fn the_name_carries_time_kind_and_id() {
        let name = Backup::file_name(ID, at("2026-11-04T00:30:15.5Z"), true);
        assert_eq!(
            name,
            format!("roedy-mail-20261104T003015Z-auto-{ID}.tar.zst")
        );
        assert_eq!(
            Backup::parse(&name, 7),
            Some(Backup {
                id: ID.to_owned(),
                at: at("2026-11-04T00:30:15Z"),
                auto: true,
                size: 7,
                file: name.clone(),
            })
        );
        let manual = Backup::file_name(ID, at("2026-11-04T00:30:15Z"), false);
        assert!(!Backup::parse(&manual, 7).unwrap().auto);
    }

    #[test]
    fn foreign_names_are_no_backups() {
        for name in [
            "roedy-mail.tar.zst",
            "notes.txt",
            ".tmp-01KA0000000000000000000000",
            "roedy-mail-20261104T003015Z-auto.tar.zst",
            "roedy-mail-yesterday-auto-01KA0000000000000000000000.tar.zst",
            "roedy-mail-20261104T003015Z-other-01KA0000000000000000000000.tar.zst",
            "roedy-mail-20261104T003015Z-auto-short.tar.zst",
            "roedy-mail-20261104T003015Z-auto-01KA0000000000000000000000-x.tar.zst",
        ] {
            assert_eq!(Backup::parse(name, 1), None, "{name}");
        }
    }

    #[test]
    fn the_list_is_sorted_and_ignores_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = backups(tmp.path());
        assert_eq!(backups.list().unwrap(), []);
        file(&backups, ID, "2026-11-01T00:00:00Z", true, 10);
        file(&backups, ID, "2026-11-03T00:00:00Z", false, 20);
        file(&backups, ID, "2026-11-02T00:00:00Z", true, 30);
        fs::write(backups.dir.join("notes.txt"), "hello").unwrap();
        fs::create_dir(backups.dir.join(".tmp-rest")).unwrap();

        let list = backups.list().unwrap();
        let sizes: Vec<_> = list.iter().map(|b| b.size).collect();
        assert_eq!(sizes, [20, 30, 10]);
        assert_eq!(backups.usage().unwrap(), (60, 3));
    }

    #[test]
    fn a_missing_directory_is_an_empty_list() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = Backups::new(tmp.path());
        assert_eq!(backups.list().unwrap(), []);
        assert_eq!(backups.usage().unwrap(), (0, 0));
        backups.sweep();
    }

    #[test]
    fn retention_keeps_recent_and_manual_backups() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = backups(tmp.path());
        let old = file(&backups, ID, "2026-10-01T00:00:00Z", true, 1);
        let recent = file(&backups, ID, "2026-10-31T00:00:00Z", true, 2);
        let manual = file(&backups, ID, "2026-01-01T00:00:00Z", false, 3);

        let deleted = backups.prune(7, at("2026-11-04T00:00:00Z")).unwrap();

        assert_eq!(deleted, 1);
        assert!(!backups.dir.join(old).exists());
        assert!(backups.dir.join(recent).exists());
        assert!(backups.dir.join(manual).exists());
    }

    #[test]
    fn leftovers_are_swept_and_backups_stay() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = backups(tmp.path());
        let kept = file(&backups, ID, "2026-11-01T00:00:00Z", true, 1);
        fs::create_dir(backups.dir.join(".tmp-old")).unwrap();
        fs::write(backups.dir.join(".tmp-old/roedy.sqlite3"), "rest").unwrap();

        backups.sweep();

        assert!(!backups.dir.join(".tmp-old").exists());
        assert!(backups.dir.join(kept).exists());
    }

    #[test]
    fn the_workspace_goes_with_its_files() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = Backups::new(tmp.path());
        let work = Workspace::new(&backups).unwrap();
        let path = work.path().to_owned();
        fs::write(path.join("file"), "x").unwrap();

        drop(work);

        assert!(!path.exists());
    }

    #[test]
    fn the_next_run_follows_the_last_one() {
        let daily = Settings::default();
        let weekly = Settings {
            every: Every::Weekly,
            ..daily
        };
        let last = Some(at("2026-11-04T00:30:00Z"));
        let now = at("2026-11-04T09:00:00Z");

        assert_eq!(daily.next_at(last, now), Some(at("2026-11-05T00:30:00Z")));
        assert_eq!(weekly.next_at(last, now), Some(at("2026-11-11T00:30:00Z")));
        assert_eq!(daily.next_at(None, now), Some(now));
        let off = Settings {
            auto: false,
            ..daily
        };
        assert_eq!(off.next_at(last, now), None);
    }

    #[test]
    fn settings_have_the_documented_defaults() {
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap(),
            json!({ "auto": true, "every": "daily", "keep": 30 })
        );
        let weekly: Settings = serde_json::from_value(json!({ "every": "weekly" })).unwrap();
        assert_eq!(weekly.every, Every::Weekly);
        assert_eq!(weekly.keep, 30);
    }
}
