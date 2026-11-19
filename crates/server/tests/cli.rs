//! End to end: starts the binary `roedy-mail` and checks the subcommands.

use std::{
    io::{BufRead as _, BufReader},
    path::Path,
    process::{Child, Command, Output, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_roedy-mail");
const STARTUP: Duration = Duration::from_secs(20);
/// Port 0: the system assigns a free port, the server reports it in the log.
const ANY_PORT: &str = "127.0.0.1:0";
/// `ROEDY_PUBLIC_URL` of the started servers; `serve` requires it.
const PUBLIC_URL: &str = "https://mail.example.com";

fn roedy(data_dir: &Path, listen: &str) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.env("ROEDY_DATA_DIR", data_dir)
        .env("ROEDY_LISTEN", listen)
        .env("ROEDY_LOG", "info")
        .env("ROEDY_LOG_FORMAT", "json")
        .env_remove("ROEDY_PUBLIC_URL")
        .env_remove("ROEDY_WEB_DIR");
    cmd
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn message(event: &Value) -> &str {
    event["message"].as_str().unwrap_or_default()
}

fn token_in(event: &Value) -> String {
    message(event)
        .split("Setup-Token: ")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap()
        .to_owned()
}

/// Running `serve` process; terminated when the test ends.
struct Server {
    child: Child,
    lines: Receiver<String>,
    log: Vec<Value>,
    /// Actual address from the start message.
    listen: String,
}

impl Server {
    fn start(data_dir: &Path) -> Self {
        Self::start_with(data_dir, Some(PUBLIC_URL))
    }

    /// Like [`Self::start`], `public_url` as `ROEDY_PUBLIC_URL` if given.
    fn start_with(data_dir: &Path, public_url: Option<&str>) -> Self {
        let mut cmd = roedy(data_dir, ANY_PORT);
        if let Some(url) = public_url {
            cmd.env("ROEDY_PUBLIC_URL", url);
        }
        let mut child = cmd
            .arg("serve")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut server = Self {
            child,
            lines,
            log: Vec::new(),
            listen: String::new(),
        };
        let started = server.wait_for_message("Roedy Mail started");
        server.listen = started["listen"].as_str().unwrap().to_owned();
        server
    }

    /// Reads log lines until a message contains `needle`.
    fn wait_for_message(&mut self, needle: &str) -> Value {
        let deadline = Instant::now() + STARTUP;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = self
                .lines
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("no log line with {needle:?}: {:#?}", self.log));
            let event: Value = serde_json::from_str(&line)
                .unwrap_or_else(|e| panic!("log line is not JSON ({e}): {line}"));
            self.log.push(event.clone());
            if message(&event).contains(needle) {
                return event;
            }
        }
    }

    fn logged(&self, needle: &str) -> Option<&Value> {
        self.log.iter().find(|e| message(e).contains(needle))
    }

    fn command(&self, data_dir: &Path, subcommand: &str) -> Output {
        roedy(data_dir, &self.listen)
            .arg(subcommand)
            .output()
            .unwrap()
    }

    fn terminate(mut self) -> (bool, Self) {
        let pid = self.child.id().to_string();
        assert!(
            Command::new("kill")
                .args(["-TERM", &pid])
                .status()
                .unwrap()
                .success()
        );
        let status = self.child.wait().unwrap();
        (status.success(), self)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn serve_and_subcommands() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");

    let server = Server::start(&data_dir);

    // Setup token in the log, as `docker logs … 2>&1 | grep Setup-Token` finds it.
    let event = server
        .logged("Setup-Token: ")
        .cloned()
        .expect("setup token missing in the log");
    assert_eq!(event["level"], "INFO");
    assert_eq!(event["target"], "setup");
    let token = token_in(&event);
    assert_eq!(token.len(), 14, "{token}");
    assert!(server.logged("migration applied").is_some());

    // Without ROEDY_SECRET_KEY the first start creates the key file.
    let key_file = data_dir.join("secret.key");
    let key = server
        .logged("secret key loaded")
        .expect("key missing in the log");
    assert!(
        key["source"].as_str().unwrap().ends_with("(newly created)"),
        "{key}"
    );
    let key_text = std::fs::read_to_string(&key_file).unwrap();
    assert!(!key.to_string().contains(key_text.trim()), "key in the log");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&key_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    let output = server.command(&data_dir, "healthcheck");
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stdout(&output), "ok");

    let output = server.command(&data_dir, "setup-token");
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stdout(&output), format!("Setup-Token: {token}"));

    let output = server.command(&data_dir, "migrate");
    assert!(output.status.success(), "{}", stderr(&output));
    let latest = roedy_mail_server::db::migrations::MIGRATIONS.len();
    assert_eq!(
        stdout(&output),
        format!("Database schema: version {latest}")
    );

    // Before the setup there is nobody to reset.
    let output = server.command(&data_dir, "reset-admin");
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("no administrator yet"),
        "{}",
        stderr(&output)
    );

    // SIGTERM ends cleanly and checkpoints the WAL file.
    let (success, mut server) = server.terminate();
    server.wait_for_message("Roedy Mail stopped");
    assert!(success, "{:#?}", server.log);
    assert!(!data_dir.join("roedy.sqlite3-wal").exists());

    let output = server.command(&data_dir, "healthcheck");
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("no connection"),
        "{}",
        stderr(&output)
    );

    // A restart without admin reports the same token.
    let server = Server::start(&data_dir);
    let again = server
        .logged("Setup-Token: ")
        .expect("setup token missing in the log");
    assert_eq!(token_in(again), token);
    assert!(server.logged("migration applied").is_none());
    let key = server
        .logged("secret key loaded")
        .expect("key missing in the log");
    assert_eq!(
        key["source"].as_str().unwrap(),
        key_file.display().to_string(),
        "the same key"
    );
    assert_eq!(std::fs::read_to_string(&key_file).unwrap(), key_text);
}

#[test]
fn bind_failure_is_logged_and_closes_database() {
    let tmp = tempfile::tempdir().unwrap();
    let running = Server::start(&tmp.path().join("first"));

    // Second server on the same port with a sparse log filter.
    let data_dir = tmp.path().join("second");
    let output = roedy(&data_dir, &running.listen)
        .env("ROEDY_PUBLIC_URL", PUBLIC_URL)
        .env("ROEDY_LOG", "warn")
        .arg("serve")
        .output()
        .unwrap();
    assert!(!output.status.success());

    let events: Vec<Value> = stderr(&output)
        .lines()
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("log line is not JSON ({e}): {line}"))
        })
        .collect();
    // The setup token appears despite `ROEDY_LOG=warn`.
    assert!(
        events
            .iter()
            .any(|e| message(e).starts_with("Setup-Token: ")),
        "{events:#?}"
    );
    let error = events
        .iter()
        .find(|e| e["level"] == "ERROR")
        .unwrap_or_else(|| panic!("no error in the log: {events:#?}"));
    assert!(message(error).starts_with("error: Address"), "{events:#?}");
    assert!(!data_dir.join("roedy.sqlite3-wal").exists());
}

#[test]
fn setup_token_requires_server_database() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("incorrect");
    let output = roedy(&data_dir, ANY_PORT)
        .arg("setup-token")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("no database"),
        "{}",
        stderr(&output)
    );
    assert!(!data_dir.exists());
}

#[tokio::test]
async fn reset_admin_restores_access() {
    use roedy_mail_server::{
        auth::{
            password::Hasher,
            session::{self, Client},
        },
        db::{
            self,
            repo::{
                totp_devices,
                users::{self, NewUser, Role},
            },
        },
    };

    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    let new_admin = |username: &str, email: &str| {
        users::insert(
            &conn,
            &NewUser {
                username,
                email,
                display_name: "Max Mustermann",
                role: Role::Admin,
                password_hash: "$argon2id$old",
            },
        )
        .unwrap()
    };
    let max = new_admin("max", "max@example.com");
    totp_devices::insert_pending(&conn, "t1", &max, b"x").unwrap();
    totp_devices::confirm(&conn, "t1", "Phone", 1).unwrap();
    session::start(&conn, &max, &Client::default(), true).unwrap();
    new_admin("anna", "anna@example.com");
    drop(conn);

    // Several administrators: only with --user.
    let output = roedy(tmp.path(), ANY_PORT)
        .arg("reset-admin")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(stderr(&output).contains("--user"), "{}", stderr(&output));

    let output = roedy(tmp.path(), ANY_PORT)
        .args(["reset-admin", "--user", "MAX@example.com"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let out = stdout(&output);
    assert!(
        out.starts_with("Access of Max Mustermann (max@example.com) reset."),
        "{out}"
    );
    assert!(
        out.contains("Authenticator apps removed: 1, sessions ended: 1."),
        "{out}"
    );
    let password = out
        .lines()
        .find_map(|line| line.strip_prefix("New password: "))
        .unwrap();
    // Not in the log (stderr), only in the output for the operator.
    assert!(!stderr(&output).contains(password));

    let conn = db::open(tmp.path()).unwrap();
    let after = users::credentials_by_id(&conn, &max).unwrap().unwrap();
    assert!(
        Hasher::default()
            .verify(password, Some(&after.password_hash))
            .await
            .unwrap()
    );
    assert!(!totp_devices::has_confirmed(&conn, &max).unwrap());
    let sessions: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sessions, 0);
}

#[test]
fn invalid_configuration_fails_fast() {
    let tmp = tempfile::tempdir().unwrap();
    let output = roedy(tmp.path(), "not-valid")
        .arg("serve")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let err = stderr(&output);
    assert!(err.starts_with("error: Invalid configuration"), "{err}");
    assert!(err.contains("ROEDY_LISTEN: "), "{err}");
}

#[test]
fn serve_requires_public_url() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let output = roedy(&data_dir, ANY_PORT).arg("serve").output().unwrap();
    assert!(!output.status.success());
    let err = stderr(&output);
    let events: Vec<Value> = err
        .lines()
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("log line is not JSON ({e}): {line}"))
        })
        .collect();
    let error = events
        .iter()
        .find(|e| e["level"] == "ERROR")
        .unwrap_or_else(|| panic!("no error in the log: {events:#?}"));
    assert!(
        message(error).starts_with("error: ROEDY_PUBLIC_URL is not set"),
        "{events:#?}"
    );
    // Stopped before the setup token: nobody can start a setup without it.
    assert!(!err.contains("Setup-Token: "), "{err}");
    assert!(!err.contains("Roedy Mail started"), "{err}");
    let conn = roedy_mail_server::db::open(&data_dir).unwrap();
    assert_eq!(
        roedy_mail_server::setup_token::current(&conn).unwrap(),
        None,
        "no setup token stored"
    );
}

#[test]
fn public_url_from_an_older_setup_still_starts() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let conn = roedy_mail_server::db::open(&data_dir).unwrap();
    conn.execute(
        "INSERT INTO app_settings (key, json) VALUES ('public_url', '\"https://mail.example.com/\"')",
        [],
    )
    .unwrap();
    drop(conn);

    let server = Server::start_with(&data_dir, None);
    assert!(server.logged("Setup-Token: ").is_some());
    let (success, server) = server.terminate();
    assert!(success, "{:#?}", server.log);
}
