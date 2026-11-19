//! HTTP server: router, state and lifecycle of `roedy-mail serve`.

use std::{
    future::{Future, IntoFuture as _},
    net::{IpAddr, SocketAddr},
    sync::{Arc, PoisonError, RwLock, atomic::AtomicBool},
    time::Duration,
};

use anyhow::Context as _;
use axum::{Router, middleware, routing::get};
use rusqlite::Connection;
use tokio::{net::TcpListener, sync::oneshot, task::JoinSet};
use tower_http::{classify::SharedClassifier, trace::TraceLayer};
use url::Url;

use crate::{
    api::{self, health},
    auth::{challenge::Challenges, password::Hasher},
    backups::Backups,
    broker::{self, crypto::SecretKey},
    config::{Config, TrustProxy},
    db::{self, Db, repo::app_settings},
    geoip::GeoIp,
    instance::Instance,
    jobs,
    locks::KeyedLocks,
    logging::{self, SETUP_TARGET},
    logo::IMAGE_PATH,
    mailer::{
        Mailer,
        templates::{Accent, Brand, MAIL_LOGO_PATH, PUSH_ICON_PATH, Plate},
    },
    push::Vapid,
    rate_limit::RateLimiter,
    setup_token, updates,
    web::{
        branding::{self, APP_ICON_PATH, MANIFEST_PATH, MASKABLE_ICON_PATH, TOUCH_ICON_PATH},
        maintenance::{self, Maintenance},
        security_headers::{self, Csp},
        static_files::{self, WebAssets},
    },
};

/// Grace period for running requests after SIGTERM; Docker kills after 10 s.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(8);
/// Then this long for tasks after the response ([`Background`]).
const BACKGROUND_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub web: Arc<WebAssets>,
    pub hasher: Arc<Hasher>,
    pub limiter: Arc<RateLimiter>,
    /// Intermediate steps of a multi-factor sign-in.
    pub challenges: Arc<Challenges>,
    pub trust_proxy: TrustProxy,
    /// `ROEDY_PUBLIC_URL`; otherwise the address an older initial setup stored
    /// applies ([`Self::public_url`]).
    pub configured_url: Option<Url>,
    /// Key for secrets in the database.
    pub secrets: Arc<SecretKey>,
    /// Client for requests to mail servers of the registry.
    pub http: reqwest::Client,
    /// Client for addresses given by users (own servers): public addresses
    /// only ([`broker::outbound`]).
    pub user_http: reqwest::Client,
    /// Delivery of system mails.
    pub mailer: Arc<Mailer>,
    /// `connect-src` of the CSP from the registry.
    pub csp: Arc<Csp>,
    /// Location of the client IP (`ROEDY_GEOIP_DB`); `None` without a database.
    pub geoip: Option<Arc<GeoIp>>,
    /// Tasks after the response (security mails, audit log, rehashing).
    pub background: Background,
    /// Email address changes per user, one after another.
    pub email_locks: Arc<KeyedLocks>,
    /// Token refresh per mail account, one after another.
    pub token_locks: Arc<KeyedLocks>,
    /// Maintenance mode (`app_settings.maintenance`).
    pub maintenance: Arc<Maintenance>,
    /// Organization and banner (`app_settings`); source for
    /// `public/config` and [`Self::brand`].
    pub instance: Arc<Instance>,
    /// An administrator exists (`public/config`); once set, it
    /// stays set.
    pub setup_done: Arc<AtomicBool>,
    /// VAPID key for Web Push, loaded or created when first needed
    /// ([`Self::vapid`]); [`Self::reload`] forgets it.
    pub vapid_key: Arc<RwLock<Option<Arc<Vapid>>>>,
    /// Address of the GitHub API for the update check.
    pub github_api: Arc<Url>,
    /// Backup directory.
    pub backups: Arc<Backups>,
}

/// Tasks that keep running after the response. On shutdown `serve` waits
/// briefly for them ([`Self::finish`]) before the database closes – otherwise
/// a "password changed" mail shortly before SIGTERM would never go out.
#[derive(Clone, Default)]
pub struct Background(Arc<std::sync::Mutex<JoinSet<()>>>);

impl Background {
    pub fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) {
        let mut tasks = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Clean up finished ones so the list does not grow.
        while tasks.try_join_next().is_some() {}
        tasks.spawn(task);
    }

    /// Waits at most `within` for running tasks and aborts the rest.
    pub async fn finish(&self, within: Duration) {
        let mut tasks = std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()));
        let drained =
            tokio::time::timeout(within, async { while tasks.join_next().await.is_some() {} })
                .await;
        if drained.is_err() {
            tracing::warn!(open = tasks.len(), "background tasks aborted");
        }
    }
}

impl AppState {
    /// The CSP initially contains only `'self'`; [`Self::load_csp`] reads the
    /// registry. Mailer and diagnostics share one HTTP client.
    pub fn new(
        db: Db,
        web: Arc<WebAssets>,
        config: &Config,
        secrets: SecretKey,
    ) -> anyhow::Result<Self> {
        let http = broker::http_client()?;
        Ok(Self {
            db,
            web,
            hasher: Arc::new(Hasher::default()),
            limiter: Arc::new(RateLimiter::default()),
            challenges: Arc::new(Challenges::default()),
            trust_proxy: config.trust_proxy,
            configured_url: config.public_url.clone(),
            secrets: Arc::new(secrets),
            mailer: Arc::new(Mailer::new(http.clone())),
            http,
            user_http: broker::outbound::public_client()?,
            csp: Arc::new(Csp::default()),
            geoip: None,
            background: Background::default(),
            email_locks: Arc::default(),
            token_locks: Arc::default(),
            maintenance: Arc::default(),
            instance: Arc::default(),
            setup_done: Arc::default(),
            vapid_key: Arc::default(),
            github_api: Arc::new(Url::parse(updates::github::API)?),
            backups: Arc::new(Backups::new(&config.data_dir)),
        })
    }

    /// Location of the client IP if a GeoIP database is loaded.
    pub fn place(&self, ip: IpAddr) -> Option<String> {
        self.geoip.as_ref().and_then(|geoip| geoip.place(ip))
    }

    /// Reads everything from the database that the server keeps in memory: at
    /// startup and on the database thread after restoring a backup
    /// ([`Self::reload`]).
    pub async fn load(&self) -> anyhow::Result<()> {
        let state = self.clone();
        db::call(&self.db, move |conn| state.reload(conn)).await
    }

    /// Client for a connected mail server: registry servers via
    /// [`Self::http`], own servers only with the SSRF guard via
    /// [`Self::user_http`].
    pub fn mail_http(&self, registered: bool) -> &reqwest::Client {
        if registered {
            &self.http
        } else {
            &self.user_http
        }
    }

    /// Branding and organization for the mails and the mail logo – one source,
    /// so that a mail's `<img>` and `/branding/mail-logo.png` match and
    /// `public/config` states the same details. Both come from
    /// [`Self::instance`].
    pub fn brand(&self) -> Brand {
        let org = self.instance.org();
        let branding = self.instance.branding();
        Brand {
            app: branding.branding.app_name().to_owned(),
            accent: Accent::named(&branding.branding.color),
            plate: Plate::named(&branding.branding.plate),
            logos: branding.logos.clone(),
            org: org.name,
            support: org.email,
            imprint: org.imprint,
            privacy: org.privacy,
        }
    }

    /// Public address of the app: `ROEDY_PUBLIC_URL` or the one an older
    /// initial setup stored; the redirect URI and the CORS check depend on it.
    pub async fn public_url(&self) -> anyhow::Result<Option<Url>> {
        if let Some(url) = &self.configured_url {
            return Ok(Some(url.clone()));
        }
        db::call(&self.db, |conn| {
            app_settings::get::<Url>(conn, app_settings::PUBLIC_URL)
        })
        .await
    }

    /// VAPID key of the instance; the first call reads it from the database or
    /// creates it. An error (such as a different instance key) is not cached;
    /// the next call tries again. It is remembered on the database thread so
    /// that it does not overtake [`Self::reload`].
    pub async fn vapid(&self) -> anyhow::Result<Arc<Vapid>> {
        let known = self
            .vapid_key
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(vapid) = known {
            return Ok(vapid);
        }
        let secrets = self.secrets.clone();
        let slot = self.vapid_key.clone();
        db::call(&self.db, move |conn| {
            let vapid = Arc::new(Vapid::load_or_create(conn, &secrets)?);
            *slot.write().unwrap_or_else(PoisonError::into_inner) = Some(vapid.clone());
            Ok(vapid)
        })
        .await
    }

    /// See [`Self::load`]: CSP from the registry, maintenance mode, organization,
    /// banner, branding and whatever else comes from `app_settings`; the VAPID
    /// key is read by [`Self::vapid`] when next needed.
    /// `setup_done` stays: every backup comes from an instance that was set up.
    pub fn reload(&self, conn: &Connection) -> anyhow::Result<()> {
        self.csp.reload(conn)?;
        self.maintenance.set(maintenance::Mode::load(conn)?);
        self.instance.load(conn)?;
        *self
            .vapid_key
            .write()
            .unwrap_or_else(PoisonError::into_inner) = None;
        Ok(())
    }
}

pub fn router(state: AppState) -> Router {
    let api = api::router(state.clone());
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .nest(api::PREFIX, api.clone())
        // `nest` does not cover `/api/v1/` (axum 0.8); the API answers there too.
        .route_service(&format!("{}/", api::PREFIX), api.with_state(state.clone()))
        // Mail clients load the logo without signing in (mail templates).
        .route(MAIL_LOGO_PATH, get(branding::mail_logo))
        // Icon of push notifications; the service worker loads it without a cookie.
        .route(PUSH_ICON_PATH, get(branding::push_icon))
        // Uploaded logo (`public/config` › `branding.image`).
        .route(&format!("{IMAGE_PATH}/{{file}}"), get(branding::image))
        // Installed app: browser and system load both without a cookie.
        .route(MANIFEST_PATH, get(branding::manifest))
        .route(APP_ICON_PATH, get(branding::app_icon))
        .route(MASKABLE_ICON_PATH, get(branding::maskable_icon))
        .route(TOUCH_ICON_PATH, get(branding::touch_icon))
        // Everything else is the web app (SPA fallback).
        .fallback(static_files::serve)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers::apply,
        ))
        .layer(
            TraceLayer::new(SharedClassifier::new(logging::RequestClassifier))
                .make_span_with(logging::request_span),
        )
        .with_state(state)
}

/// Opens the database, logs the setup token while the initial setup is
/// pending and serves HTTP until SIGTERM or SIGINT.
pub async fn serve(config: Config) -> anyhow::Result<()> {
    // First: as PID 1 in a container the process ignores signals without a handler.
    let shutdown = shutdown_signal()?;
    let web = Arc::new(WebAssets::new(config.web_dir.as_deref())?);

    let blocking_config = config.clone();
    let (conn, token, (secrets, key_source)) = db::blocking(move || {
        let conn = db::open(&blocking_config.data_dir)?;
        // Before the setup token: without an address the setup would create
        // an instance that cannot send links.
        require_public_url(&conn, &blocking_config)?;
        let token = setup_token::ensure(&conn)?;
        // After `open`: the data directory exists by then.
        let key = SecretKey::load(&blocking_config)?;
        Ok((conn, token, key))
    })
    .await?;
    if let Some(token) = token {
        tracing::info!(
            target: SETUP_TARGET,
            "Setup-Token: {token} (valid until the initial setup is complete; \
             show again with `roedy-mail setup-token`)"
        );
    }
    tracing::info!(source = %key_source, "secret key loaded");
    let db = Db::from(conn);

    let result = async {
        let mut state = AppState::new(db.clone(), web, &config, secrets)?;
        state.load().await?;
        if let Some(path) = config.geoip_db.clone() {
            let geoip = db::blocking(move || GeoIp::open(&path)).await?;
            tracing::info!(path = %geoip.path().display(), "GeoIP database loaded");
            state.geoip = Some(Arc::new(geoip));
        }
        // Placeholder hash up front, so that even the first sign-in of an
        // unknown user takes no longer than that of a known one.
        let hasher = state.hasher.clone();
        tokio::spawn(async move {
            if let Err(error) = hasher.prepare().await {
                tracing::warn!("placeholder hash not created: {error:#}");
            }
        });
        if let Err(error) = updates::on_start(&state).await {
            tracing::warn!("version change not recorded: {error:#}");
        }
        let backups = state.backups.clone();
        db::blocking(move || {
            backups.sweep();
            Ok(())
        })
        .await?;
        let scheduler = jobs::start(&state);
        let background = state.background.clone();
        let served = run_http(&config, state, shutdown).await;
        // Before closing the database: mails after the last responses, then the
        // jobs.
        background.finish(BACKGROUND_GRACE).await;
        scheduler.shutdown().await;
        served
    }
    .await;
    // Close even after errors so that SQLite checkpoints the WAL file.
    let closed = db.close().await.context("Database not closed cleanly");
    result?;
    closed?;
    tracing::info!("Roedy Mail stopped");
    Ok(())
}

/// `ROEDY_PUBLIC_URL` is required; instances whose address an older setup
/// stored (`app_settings.public_url`) keep starting with that one.
fn require_public_url(conn: &Connection, config: &Config) -> anyhow::Result<()> {
    if config.public_url.is_some()
        || app_settings::get::<Url>(conn, app_settings::PUBLIC_URL)?.is_some()
    {
        return Ok(());
    }
    anyhow::bail!(
        "ROEDY_PUBLIC_URL is not set – set it to the public address of the app, \
         e.g. https://mail.example.com (docs/ops.md › Configuration)"
    )
}

async fn run_http(
    config: &Config,
    state: AppState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(config.listen)
        .await
        .with_context(|| format!("Address {} not available (ROEDY_LISTEN)", config.listen))?;
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        listen = %listener.local_addr()?,
        data_dir = %config.data_dir.display(),
        public_url = config.public_url.as_ref().map(|u| u.as_str()),
        web = state.web.describe(),
        trust_proxy = config.trust_proxy.0,
        "Roedy Mail started"
    );

    let (stopping, stopped) = oneshot::channel();
    // `client_ip::ClientIp` needs the address of the connection.
    let app = router(state).into_make_service_with_connect_info::<SocketAddr>();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown.await;
            let _ = stopping.send(());
        })
        .into_future();
    let deadline = async move {
        match stopped.await {
            Ok(()) => tokio::time::sleep(SHUTDOWN_GRACE).await,
            Err(_) => std::future::pending().await,
        }
    };
    tokio::select! {
        result = server => result.context("HTTP server aborted"),
        () = deadline => {
            tracing::warn!(grace = ?SHUTDOWN_GRACE, "open requests aborted after the grace period");
            Ok(())
        }
    }
}

/// Installs the handlers right away; the future ends at the first signal.
#[cfg(unix)]
fn shutdown_signal() -> anyhow::Result<impl Future<Output = ()> + Send + 'static> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).context("SIGTERM cannot be handled")?;
    let mut interrupt = signal(SignalKind::interrupt()).context("SIGINT cannot be handled")?;
    Ok(async move {
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
        tracing::info!("shutting down, finishing open requests");
    })
}

#[cfg(not(unix))]
fn shutdown_signal() -> anyhow::Result<impl Future<Output = ()> + Send + 'static> {
    Ok(async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
        tracing::info!("shutting down, finishing open requests");
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn background_waits_briefly_then_aborts() {
        let done = Arc::new(AtomicUsize::new(0));
        let background = Background::default();
        for secs in [1, 60] {
            let done = done.clone();
            background.spawn(async move {
                tokio::time::sleep(Duration::from_secs(secs)).await;
                done.fetch_add(1, Ordering::SeqCst);
            });
        }
        background.finish(Duration::from_secs(5)).await;
        assert_eq!(
            done.load(Ordering::SeqCst),
            1,
            "the short one, not the long one"
        );
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert_eq!(done.load(Ordering::SeqCst), 1, "the long one is aborted");
    }
}
