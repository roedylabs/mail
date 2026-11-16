//! Binary `roedy-mail`.

use std::process::ExitCode;

use clap::Parser as _;
use roedy_mail_server::cli::{self, Cli, Command};

// mimalloc instead of the musl allocator: less memory and faster.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> ExitCode {
    let cli = Cli::parse();
    let serve = matches!(cli.command, Command::Serve);

    // Only the server needs worker threads (two suffice); the other
    // commands – such as the periodic `healthcheck` – run on the current thread.
    let runtime = if serve {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
    } else {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
    };
    let runtime = match runtime {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("error: cannot start the Tokio runtime: {err}");
            return ExitCode::FAILURE;
        }
    };

    match runtime.block_on(cli::run(cli)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            // The server reports errors in the configured log format so that
            // JSON analyses of the container logs capture them.
            if serve && tracing::dispatcher::has_been_set() {
                tracing::error!("error: {err:#}");
            } else {
                eprintln!("error: {err:#}");
            }
            ExitCode::FAILURE
        }
    }
}
