//! Load test of the backend: many users and sessions, one
//! mail account per user at the local test server `fake_stalwart`, then per
//! phase many concurrent requests via the router: `auth/me`, tokens from the
//! broker's memory, refresh of all accounts at once and sessions that are
//! extended on the next call (a write per request). Measured without network
//! (router with `oneshot`) and without Argon2 (sessions created directly), so
//! the path through middleware, rate limit, broker and the one SQLite
//! connection. Manual only, in a release build:
//!
//!   cargo test -p roedy-mail-server --release --test load -- --ignored --nocapture
//!
//! For memory as in the image, with the mimalloc options from the Dockerfile
//! in front: `MIMALLOC_PURGE_DELAY=0 MIMALLOC_ALLOW_THP=0`.
//!
//! `LOAD_TEST_USERS`, `LOAD_TEST_SESSIONS`, `LOAD_TEST_REQUESTS` and `LOAD_TEST_CONCURRENCY`
//! change the sizes (defaults 1000, 10, 20000, 64). After each step the
//! process memory is printed below it.

mod fake_stalwart;

use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Method, Request, StatusCode, header},
};
use fake_stalwart::{CLIENT_ID, MAIL_TOKEN, MAIL_USER, Options, REFRESH_TOKEN, Server};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    api,
    app::{AppState, router},
    auth::session::{self, Client},
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db,
        repo::users::{self, NewUser, Role},
    },
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tokio::{sync::Semaphore, task::JoinSet};
use tower::ServiceExt as _;
use url::Url;

// The same allocator as in the binary (`src/main.rs`), otherwise the memory
// figures would be glibc's.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn size(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn app(state: &AppState) -> Router {
    router(state.clone()).layer(MockConnectInfo(SocketAddr::from(([203, 0, 113, 9], 4711))))
}

/// One request via the router; returns status and body.
async fn send(
    app: Router,
    method: Method,
    path: impl Into<String>,
    token: impl Into<String>,
    body: Option<Value>,
) -> (StatusCode, String) {
    let (path, token) = (path.into(), token.into());
    let mut builder = Request::builder()
        .method(method)
        .uri(format!("/api/v1{path}"))
        .header(api::CSRF_HEADER, "fetch")
        .header(header::COOKIE, format!("{}={token}", session::COOKIE));
    let body = match body {
        Some(body) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

/// Token from the cookie of a new session.
fn cookie_token(started: &session::Started) -> String {
    let cookie = started.cookie.to_str().unwrap();
    cookie
        .strip_prefix(&format!("{}=", session::COOKIE))
        .and_then(|rest| rest.split(';').next())
        .unwrap()
        .to_owned()
}

type Job = std::pin::Pin<Box<dyn Future<Output = (StatusCode, String)> + Send>>;

/// Result of a phase: duration, throughput and latency percentiles.
/// Memory of the test process from `/proc/self/status` in MB (10^6 bytes as
/// in `release.yml`): current (VmRSS) and peak (VmHWM); Linux only. Besides
/// the router the process contains the test server and the test's sessions
/// and tasks, so the values are an upper bound for the backend.
fn memory() -> Option<(f64, f64)> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let field = |name: &str| -> Option<f64> {
        let kib: f64 = status
            .lines()
            .find_map(|line| line.strip_prefix(name))?
            .trim()
            .strip_suffix("kB")?
            .trim()
            .parse()
            .ok()?;
        Some(kib * 1024.0 / 1e6)
    };
    Some((field("VmRSS:")?, field("VmHWM:")?))
}

fn print_memory() {
    if let Some((rss, peak)) = memory() {
        println!("{:<34} RSS {rss:.1} MB, peak {peak:.1} MB", "  Memory");
    }
}

struct Stats {
    name: &'static str,
    requests: usize,
    total: Duration,
    latencies: Vec<Duration>,
}

impl Stats {
    fn percentile(&self, p: f64) -> f64 {
        let i = ((self.latencies.len() as f64 - 1.0) * p).round() as usize;
        self.latencies[i].as_secs_f64() * 1000.0
    }

    fn print(&self) {
        println!(
            "{:<34} {:>7} req. {:>8.0} ms {:>8.0}/s  p50 {:>7.2} ms  p95 {:>7.2} ms  p99 {:>7.2} ms  max {:>7.2} ms",
            self.name,
            self.requests,
            self.total.as_secs_f64() * 1000.0,
            self.requests as f64 / self.total.as_secs_f64(),
            self.percentile(0.5),
            self.percentile(0.95),
            self.percentile(0.99),
            self.percentile(1.0),
        );
    }
}

/// `jobs` concurrently (at most `concurrency`); every response must be 200.
async fn run<F, Fut>(name: &'static str, count: usize, concurrency: usize, job: F) -> Stats
where
    F: Fn(usize) -> Fut,
    Fut: Future<Output = (StatusCode, String)> + Send + 'static,
{
    let mut tasks = JoinSet::new();
    let mut latencies = Vec::with_capacity(count);
    let started = Instant::now();
    for i in 0..count {
        // At most `concurrency` open. Collect finished tasks right away: until
        // collected the JoinSet keeps each in memory (with 20 000 requests about
        // 28 MB), which would distort the memory measurement.
        if tasks.len() >= concurrency {
            latencies.push(tasks.join_next().await.unwrap().unwrap());
        }
        let fut = job(i);
        tasks.spawn(async move {
            let t = Instant::now();
            let (status, body) = fut.await;
            assert_eq!(status, StatusCode::OK, "{name}: {body}");
            t.elapsed()
        });
    }
    latencies.extend(tasks.join_all().await);
    let total = started.elapsed();
    latencies.sort();
    let stats = Stats {
        name,
        requests: count,
        total,
        latencies,
    };
    stats.print();
    print_memory();
    stats
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "load test, manual only in a release build"]
async fn many_sessions_and_token_requests() {
    let users = size("LOAD_TEST_USERS", 1000);
    let per_user = size("LOAD_TEST_SESSIONS", 10);
    let requests = size("LOAD_TEST_REQUESTS", 20_000);
    let concurrency = size("LOAD_TEST_CONCURRENCY", 64);
    // One fetch per user more than the phase "token from memory" (refresh);
    // beyond that the rate limit `mail_accounts.token` (60 per minute and user)
    // applies and the phase only measures 429.
    assert!(
        users > 0 && per_user > 0 && requests > 0 && concurrency > 0,
        "LOAD_TEST_USERS, LOAD_TEST_SESSIONS, LOAD_TEST_REQUESTS and LOAD_TEST_CONCURRENCY must be greater than 0"
    );
    assert!(
        requests.div_ceil(users) < 60,
        "at most 59 token requests per user: LOAD_TEST_REQUESTS ≤ 59 × LOAD_TEST_USERS"
    );

    // Stalwart v1 rotates strictly; here all accounts share the refresh token,
    // hence without rotation. 20 ms per response of the token endpoint.
    let fake = Server::start(Options {
        keep_refresh: true,
        token_delay: Duration::from_millis(20),
        ..Options::default()
    })
    .await;
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(
        Db::from(db::open(tmp.path()).unwrap()),
        Arc::new(WebAssets::None),
        &Config::default(),
        Url::parse("https://app.example.com").unwrap(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    state.load().await.unwrap();
    let router = app(&state);
    println!("\nStarted empty");
    print_memory();

    // Users and sessions directly in the database (without Argon2).
    let started = Instant::now();
    let sessions: Vec<Vec<String>> = db::call(&state.db, move |conn| {
        let tx = conn.unchecked_transaction()?;
        let mut all = Vec::with_capacity(users + 1);
        for u in 0..=users {
            let username = format!("last{u}");
            let id = users::insert(
                &tx,
                &NewUser {
                    username: &username,
                    email: &format!("{username}@example.com"),
                    display_name: "Last Test",
                    role: if u == 0 { Role::Admin } else { Role::User },
                    password_hash: "$argon2id$test",
                },
            )?;
            let mut tokens = Vec::with_capacity(per_user);
            for _ in 0..per_user {
                tokens.push(cookie_token(&session::start(
                    &tx,
                    &id,
                    &Client::default(),
                    true,
                )?));
            }
            all.push(tokens);
        }
        tx.commit()?;
        Ok(all)
    })
    .await
    .unwrap();
    let admin = sessions[0][0].clone();
    let sessions = Arc::new(sessions[1..].to_vec());
    println!(
        "\n{} users, {} sessions created in {:.0} ms",
        users,
        users * per_user,
        started.elapsed().as_secs_f64() * 1000.0
    );
    print_memory();

    let (status, body) = send(
        router.clone(),
        Method::POST,
        "/admin/servers",
        &admin,
        Some(json!({ "label": "Stalwart", "url": fake.url, "client_id": CLIENT_ID })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let server: Value = serde_json::from_str(&body).unwrap();
    let server = server["id"].as_str().unwrap().to_owned();

    // One mail account per user via the API (checks the JMAP session at the test server).
    let started = Instant::now();
    let mut tasks = JoinSet::new();
    let gate = Arc::new(Semaphore::new(16));
    for u in 0..users {
        let (router, token, server) = (router.clone(), sessions[u][0].clone(), server.clone());
        let permit = gate.clone().acquire_owned().await.unwrap();
        tasks.spawn(async move {
            let (status, body) = send(
                router,
                Method::POST,
                "/mail-accounts",
                &token,
                Some(json!({
                    "email": MAIL_USER,
                    "server_id": server,
                    "auth_kind": "oauth",
                    "access_token": MAIL_TOKEN,
                    "refresh_token": REFRESH_TOKEN,
                    "expires_in": 3600,
                })),
            )
            .await;
            drop(permit);
            assert_eq!(status, StatusCode::CREATED, "{body}");
            let created: Value = serde_json::from_str(&body).unwrap();
            (u, created["id"].as_str().unwrap().to_owned())
        });
    }
    let mut accounts = vec![String::new(); users];
    for (u, id) in tasks.join_all().await {
        accounts[u] = id;
    }
    let accounts = Arc::new(accounts);
    println!(
        "{} mail accounts via the API in {:.0} ms",
        users,
        started.elapsed().as_secs_f64() * 1000.0
    );
    print_memory();
    println!(
        "\nConcurrency: {concurrency}; requests per phase: {requests}; token endpoint response: 20 ms\n"
    );

    // Spread evenly over all sessions.
    let pick = {
        let sessions = sessions.clone();
        move |i: usize| {
            let u = i % sessions.len();
            (u, sessions[u][(i / sessions.len()) % per_user].clone())
        }
    };

    run("auth/me sequential", 2000, 1, |i| {
        let (_, token) = pick(i);
        send(router.clone(), Method::GET, "/auth/me", token, None)
    })
    .await;

    run("auth/me", requests, concurrency, |i| {
        let (_, token) = pick(i);
        send(router.clone(), Method::GET, "/auth/me", token, None)
    })
    .await;

    run("token from memory", requests, concurrency, |i| {
        let (u, token) = pick(i);
        let path = format!("/mail-accounts/{}/token", accounts[u]);
        send(router.clone(), Method::GET, path, token, None)
    })
    .await;

    // All access tokens expired: every account refreshes once.
    db::call(&state.db, |conn| {
        conn.execute(
            "UPDATE mail_accounts SET access_expires_at = \
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 seconds')",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let before = fake.token_requests().len();
    run("refresh of all accounts", users, concurrency, |u| {
        let token = sessions[u][0].clone();
        let path = format!("/mail-accounts/{}/token", accounts[u]);
        send(router.clone(), Method::GET, path, token, None)
    })
    .await;
    assert_eq!(fake.token_requests().len() - before, users);

    // Sessions idle for more than a minute: every request extends its session
    // (a write).
    db::call(&state.db, |conn| {
        conn.execute(
            "UPDATE sessions SET last_seen_at = \
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes')",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let all = users * per_user;
    run("auth/me with extension", all, concurrency, |i| {
        let token = sessions[i % users][i / users].clone();
        send(router.clone(), Method::GET, "/auth/me", token, None)
    })
    .await;

    // Reads and writes mixed: every tenth request stores settings.
    run(
        "auth/me alongside PUT settings",
        requests,
        concurrency,
        |i| -> Job {
            let (u, token) = pick(i);
            let router = router.clone();
            if i % 10 != 0 {
                return Box::pin(send(router, Method::GET, "/auth/me", token, None));
            }
            Box::pin(async move {
                let (_, body) = send(
                    router.clone(),
                    Method::GET,
                    "/settings",
                    token.clone(),
                    None,
                )
                .await;
                let version = serde_json::from_str::<Value>(&body).unwrap()["version"].clone();
                let mode = if (u + i) % 2 == 0 { "light" } else { "dark" };
                let (status, body) = send(
                    router,
                    Method::PUT,
                    "/settings",
                    token,
                    Some(json!({ "version": version, "settings": { "mode": mode } })),
                )
                .await;
                // Two requests of the same session can overtake each other.
                let status = if status == StatusCode::CONFLICT {
                    StatusCode::OK
                } else {
                    status
                };
                (status, body)
            })
        },
    )
    .await;

    let size = db::call(&state.db, |conn| Ok(db::size(conn)?))
        .await
        .unwrap();
    println!("\nDatabase: {:.1} MB", size as f64 / 1_048_576.0);
    fake.stop().await;
}
