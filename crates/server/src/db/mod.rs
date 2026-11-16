//! SQLite database: one file in the data directory, WAL mode,
//! accessed through one connection on its own thread ([`Db`]).

pub mod migrations;
pub mod repo;

use std::{
    fs::{DirBuilder, OpenOptions},
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context as _, anyhow, bail, ensure};
use rusqlite::{
    Connection, OpenFlags,
    backup::{Backup, StepResult},
};
use tokio::sync::oneshot;

use crate::random;

/// Async access for handlers and jobs through [`call`]: a
/// dedicated thread holds the single connection and runs the jobs in order;
/// clones share thread and connection. Once all clones are dropped, the
/// thread ends and closes the connection.
#[derive(Clone)]
pub struct Db {
    sender: mpsc::Sender<Message>,
}

enum Message {
    Run(Box<dyn FnOnce(&mut Connection) + Send>),
    Close(oneshot::Sender<rusqlite::Result<()>>),
}

impl From<Connection> for Db {
    fn from(conn: Connection) -> Self {
        let (sender, receiver) = mpsc::channel();
        // Name for panic messages and `top -H`; fails only when the system
        // has no threads left, like `thread::spawn`.
        thread::Builder::new()
            .name("roedy-db".into())
            .spawn(move || serve(conn, &receiver))
            .expect("database thread not started");
        Self { sender }
    }
}

impl Db {
    /// Closes the connection after the jobs queued before; SQLite writes back
    /// the WAL file. Afterwards [`call`] fails for all clones, another `close`
    /// succeeds at once. If closing fails, the connection stays open.
    pub async fn close(self) -> anyhow::Result<()> {
        let (reply, result) = oneshot::channel();
        if self.sender.send(Message::Close(reply)).is_err() {
            return Ok(());
        }
        // Without a reply the thread has already ended and the connection is closed.
        if let Ok(closed) = result.await {
            closed?;
        }
        Ok(())
    }
}

/// Runs `f` on the shared connection (handlers and jobs). Errors from `f`
/// come back unchanged, a closed connection as an error. A free function
/// instead of a method because rustfmt breaks `state.db.call(…)` as a chain
/// and indents every body one level deeper.
pub async fn call<T: Send + 'static>(
    db: &Db,
    f: impl FnOnce(&mut Connection) -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    let (reply, result) = oneshot::channel();
    db.sender
        .send(Message::Run(Box::new(move |conn| {
            // If nobody waits any more (cancelled request), the result is dropped.
            let _ = reply.send(f(conn));
        })))
        .map_err(|_| unavailable())?;
    // Without a reply the thread has ended: closed, or `f` panicked.
    result.await.map_err(|_| unavailable())?
}

fn unavailable() -> anyhow::Error {
    anyhow!("database unavailable")
}

fn serve(mut conn: Connection, receiver: &mpsc::Receiver<Message>) {
    while let Ok(message) = receiver.recv() {
        match message {
            Message::Run(job) => job(&mut conn),
            Message::Close(reply) => match conn.close() {
                Ok(()) => {
                    let _ = reply.send(Ok(()));
                    return;
                }
                Err((open, error)) => {
                    conn = open;
                    let _ = reply.send(Err(error));
                }
            },
        }
    }
}

/// File name of the database in the data directory.
pub const DB_FILE: &str = "roedy.sqlite3";

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DB_FILE)
}

/// Opens the database in the data directory and applies pending migrations.
/// Creates the directory (0700) and file (0600) when needed. Blocks; call it
/// through [`blocking`] in async code.
pub fn open(data_dir: &Path) -> anyhow::Result<Connection> {
    create_private_dir(data_dir)
        .with_context(|| format!("cannot create data directory {}", data_dir.display()))?;
    let path = db_path(data_dir);
    create_private_file(&path)
        .with_context(|| format!("cannot create database {}", path.display()))?;
    connect(&path, OpenFlags::default())
}

/// Like [`open`], but creates nothing. For commands that need the running
/// server's database: a wrong `ROEDY_DATA_DIR` shows up instead of silently
/// creating a second database.
pub fn open_existing(data_dir: &Path) -> anyhow::Result<Connection> {
    let path = db_path(data_dir);
    ensure!(
        path.is_file(),
        "no database at {} – does ROEDY_DATA_DIR match the server's?",
        path.display()
    );
    connect(
        &path,
        OpenFlags::default().difference(OpenFlags::SQLITE_OPEN_CREATE),
    )
}

/// New ID for rows visible to the outside (`users/:id`,
/// `auth/sessions/:id`): a ULID – sortable by time, 80 random bits, not
/// enumerable like a sequence number.
pub fn new_id() -> anyhow::Result<String> {
    let random = random::bytes::<16>()?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    Ok(ulid::Ulid::from_parts(millis, u128::from_le_bytes(random)).to_string())
}

fn connect(path: &Path, flags: OpenFlags) -> anyhow::Result<Connection> {
    let mut conn = Connection::open_with_flags(path, flags)
        .with_context(|| format!("cannot read database {}", path.display()))?;
    configure(&conn)?;
    migrations::run(&mut conn)?;
    Ok(conn)
}

/// Space used by the database in bytes: all pages, including free ones that
/// only [`compact`] returns; the `-wal` file does not count.
pub fn size(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
        [],
        |row| row.get(0),
    )
}

/// Compacts the database (`storage/compact`). In WAL mode `VACUUM`
/// writes the whole database into the `-wal` file; only the checkpoint frees
/// both. Requests wait for the shared connection meanwhile.
pub fn compact(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("VACUUM")?;
    checkpoint(conn)
}

/// Writes the `-wal` file back into the database and frees it.
pub fn checkpoint(conn: &Connection) -> anyhow::Result<()> {
    let busy: bool = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
    if busy {
        tracing::warn!("checkpoint blocked, the -wal file stays large for now");
    }
    Ok(())
}

/// Replaces the database `to` with `from` in one step (online backup API):
/// one transaction in `to` that applies fully or not at all, also in WAL mode.
/// The shared connection waits meanwhile, as with [`compact`].
pub fn copy(from: &Connection, to: &mut Connection) -> anyhow::Result<()> {
    let backup = Backup::new(from, to)?;
    match backup.step(-1)? {
        StepResult::Done => Ok(()),
        result => bail!("database copy not finished: {result:?}"),
    }
}

/// Opens a copy of the database without WAL: unlike the data directory, the
/// backup directory may live on a volume without shared memory, such as a
/// network share. With an exclusive lock SQLite does not need it even for a
/// file whose header still says WAL.
pub fn open_copy(path: &Path) -> anyhow::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "locking_mode", "EXCLUSIVE")?;
    let _: String =
        conn.pragma_update_and_check(None, "journal_mode", "DELETE", |row| row.get(0))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

/// Writes a snapshot of `conn` into the new file `target` (0600).
pub fn snapshot(conn: &Connection, target: &Path) -> anyhow::Result<()> {
    create_private_file(target)
        .with_context(|| format!("cannot create file {}", target.display()))?;
    copy(conn, &mut Connection::open(target)?)
}

/// Runs blocking database work (opening, migrations) outside the async
/// workers.
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .context("background task aborted")?
}

fn configure(conn: &Connection) -> anyhow::Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let mode: String =
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
    ensure!(
        mode.eq_ignore_ascii_case("wal"),
        "WAL mode unavailable (journal_mode = {mode}); is the data directory on a \
         network drive?"
    );
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

pub fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

/// Creates the file with 0600 before SQLite opens it; SQLite applies these
/// permissions to `-wal` and `-shm`. Existing files stay unchanged.
pub fn create_private_file(path: &Path) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    match options.open(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_private_database_in_wal_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("new/data");

        let conn = open(&data_dir).unwrap();
        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let fk: bool = conn
            .pragma_query_value(None, "foreign_keys", |r| r.get(0))
            .unwrap();
        assert!(fk);
        assert_eq!(
            migrations::current_version(&conn).unwrap(),
            migrations::MIGRATIONS.len() as i64
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&data_dir), 0o700);
            assert_eq!(mode(&db_path(&data_dir)), 0o600);
            assert_eq!(mode(&data_dir.join("roedy.sqlite3-wal")), 0o600);
        }
    }

    #[test]
    fn open_existing_creates_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("missing");
        let err = open_existing(&data_dir).unwrap_err();
        assert!(err.to_string().contains("ROEDY_DATA_DIR"), "{err}");
        assert!(!data_dir.exists());

        open(&data_dir).unwrap();
        open_existing(&data_dir).unwrap();
    }

    #[test]
    fn new_ids_are_distinct_ulids() {
        let a = new_id().unwrap();
        let b = new_id().unwrap();
        assert_eq!(a.len(), 26, "{a}");
        assert_ne!(a, b);
        assert!(a.parse::<ulid::Ulid>().is_ok(), "{a}");
    }

    #[test]
    fn reopen_keeps_data() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, json) VALUES ('probe', '1')",
            [],
        )
        .unwrap();
        drop(conn);

        let conn = open(tmp.path()).unwrap();
        let json: String = conn
            .query_row(
                "SELECT json FROM app_settings WHERE key = 'probe'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(json, "1");
    }

    #[test]
    fn compact_returns_free_pages_and_empties_the_wal() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        conn.execute_batch("CREATE TABLE ballast (data BLOB NOT NULL)")
            .unwrap();
        for _ in 0..64 {
            conn.execute("INSERT INTO ballast (data) VALUES (zeroblob(65536))", [])
                .unwrap();
        }
        let full = size(&conn).unwrap();
        conn.execute("DELETE FROM ballast", []).unwrap();
        assert_eq!(size(&conn).unwrap(), full, "free pages count too");

        compact(&conn).unwrap();
        assert!(size(&conn).unwrap() < full / 2);
        let wal = tmp.path().join(format!("{DB_FILE}-wal"));
        assert_eq!(std::fs::metadata(wal).unwrap().len(), 0);
    }

    #[test]
    fn bundled_sqlite_has_the_wal_fix() {
        // RUSTSEC-2026-0459: fixed from SQLite 3.54.
        assert!(rusqlite::version_number() >= 3_054_000);
    }

    #[tokio::test]
    async fn call_shares_the_connection_and_passes_errors_through() {
        let db = Db::from(Connection::open_in_memory().unwrap());
        let other = db.clone();
        call(&db, |conn| {
            Ok(conn.execute_batch("CREATE TABLE t (v INTEGER)")?)
        })
        .await
        .unwrap();
        call(&other, |conn| {
            Ok(conn.execute("INSERT INTO t VALUES (7)", [])?)
        })
        .await
        .unwrap();
        let v: i64 = call(&db, |conn| {
            Ok(conn.query_row("SELECT v FROM t", [], |row| row.get(0))?)
        })
        .await
        .unwrap();
        assert_eq!(v, 7);

        let error = call(&db, |_| -> anyhow::Result<()> { bail!("own error") })
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "own error");
    }

    #[tokio::test]
    async fn close_writes_back_the_wal_and_ends_every_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::from(open(tmp.path()).unwrap());
        let other = db.clone();
        call(&db, |conn| {
            Ok(conn.execute_batch("CREATE TABLE t (v INTEGER)")?)
        })
        .await
        .unwrap();

        db.close().await.unwrap();
        assert!(!tmp.path().join(format!("{DB_FILE}-wal")).exists());
        let error = call(&other, |_| Ok(())).await.unwrap_err();
        assert_eq!(error.to_string(), "database unavailable");
        other.close().await.unwrap();
    }

    #[tokio::test]
    async fn panic_in_a_job_reports_the_database_as_unavailable() {
        let db = Db::from(Connection::open_in_memory().unwrap());
        let error = call(&db, |_| -> anyhow::Result<()> { panic!("test panic") })
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "database unavailable");
        // The thread has ended (as before; in release builds the process aborts).
        let error = call(&db, |_| Ok(())).await.unwrap_err();
        assert_eq!(error.to_string(), "database unavailable");
        db.close().await.unwrap();
    }
}
