//! Subcommands of the `roedy-mail` binary. For every command, the
//! configuration comes from the `ROEDY_*` environment variables.

use anyhow::bail;
use clap::{Parser, Subcommand};

use crate::{
    app, auth::password::Hasher, config::Config, db, healthcheck, logging, reset_admin, setup_token,
};

#[derive(Debug, Parser)]
#[command(
    name = "roedy-mail",
    version,
    about = "Roedy Mail – lightweight JMAP webmailer for Stalwart",
    long_about = "Roedy Mail – lightweight JMAP webmailer for Stalwart.\n\n\
                  Configuration via environment variables: ROEDY_LISTEN, ROEDY_DATA_DIR, \
                  ROEDY_PUBLIC_URL, ROEDY_LOG, ROEDY_LOG_FORMAT, ROEDY_WEB_DIR, \
                  ROEDY_TRUST_PROXY, ROEDY_SECRET_KEY, ROEDY_SECRET_KEY_FILE, \
                  ROEDY_GEOIP_DB."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Start the HTTP server
    Serve,
    /// Check whether the running server responds (exit code 0 = healthy)
    Healthcheck,
    /// Apply pending database migrations
    Migrate,
    /// Reset an administrator's access: new password, no multi-factor, all
    /// sessions ended
    ResetAdmin {
        /// Email address or username; required when there are several
        /// administrators
        #[arg(long, value_name = "EMAIL|USERNAME")]
        user: Option<String>,
    },
    /// Show the setup token for the initial setup
    SetupToken,
}

pub async fn run(cli: Cli) -> anyhow::Result<()> {
    let config = Config::load()?;
    logging::init(&config)?;
    match cli.command {
        Command::Serve => app::serve(config).await,
        Command::Healthcheck => {
            healthcheck::check(config.listen, healthcheck::DEFAULT_TIMEOUT).await?;
            println!("ok");
            Ok(())
        }
        Command::Migrate => {
            let version = db::blocking(move || {
                let conn = db::open(&config.data_dir)?;
                Ok(db::migrations::current_version(&conn)?)
            })
            .await?;
            println!("Database schema: version {version}");
            Ok(())
        }
        Command::ResetAdmin { user } => {
            let data_dir = config.data_dir.clone();
            let admin = db::blocking(move || {
                reset_admin::select(&db::open_existing(&data_dir)?, user.as_deref())
            })
            .await?;
            let password = reset_admin::generate_password()?;
            let hash = Hasher::default().hash(&password).await?;
            let reset = db::blocking(move || {
                let mut conn = db::open_existing(&config.data_dir)?;
                reset_admin::reset(&mut conn, &admin, password, &hash)
            })
            .await?;
            println!("Access of {} ({}) reset.", reset.display_name, reset.email);
            println!("New password: {}", reset.password);
            println!(
                "Authenticator apps removed: {}, sessions ended: {}{}.",
                reset.devices,
                reset.sessions,
                if reset.unlocked {
                    ", account unlocked"
                } else {
                    ""
                }
            );
            println!("Change the password after signing in under Account › Security.");
            Ok(())
        }
        Command::SetupToken => {
            let token =
                db::blocking(move || setup_token::ensure(&db::open_existing(&config.data_dir)?))
                    .await?;
            match token {
                Some(token) => {
                    println!("Setup-Token: {token}");
                    Ok(())
                }
                None => {
                    bail!("Setup is complete; there is no setup token anymore.")
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory as _;

    #[test]
    fn cli_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn parses_all_subcommands() {
        for name in [
            "serve",
            "healthcheck",
            "migrate",
            "reset-admin",
            "setup-token",
        ] {
            Cli::try_parse_from(["roedy-mail", name]).unwrap();
        }
        let cli = Cli::try_parse_from(["roedy-mail", "reset-admin", "--user", "max"]).unwrap();
        assert!(matches!(cli.command, Command::ResetAdmin { user: Some(u) } if u == "max"));
        assert!(Cli::try_parse_from(["roedy-mail"]).is_err());
    }
}
