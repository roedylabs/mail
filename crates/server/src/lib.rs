//! Roedy Mail – backend. The `roedy-mail` binary (`main.rs`) only
//! calls [`cli::run`]; the modules live here so that tests can use them.

pub mod api;
pub mod app;
pub mod auth;
pub mod backups;
pub mod broker;
pub mod cli;
pub mod client_ip;
pub mod config;
pub mod db;
pub mod events;
pub mod geoip;
pub mod healthcheck;
pub mod i18n;
pub mod instance;
pub mod jobs;
pub mod locks;
pub mod logging;
pub mod logo;
pub mod mailer;
pub mod push;
pub mod random;
pub mod rate_limit;
pub mod reset_admin;
pub mod settings;
pub mod setup_token;
pub mod setup_totp;
pub mod updates;
pub mod web;
