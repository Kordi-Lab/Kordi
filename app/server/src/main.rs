use anyhow::Result;
use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "kordi-app-server",
    about = "Kordi app-facing local server",
    version
)]
struct Cli {
    /// Working directory used for workspace-scoped session queries.
    #[arg(short = 'C', long)]
    cwd: Option<PathBuf>,

    /// Listen address for the local app server.
    #[arg(long, default_value = "127.0.0.1:7080")]
    listen: SocketAddr,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let cwd = match cli.cwd {
        Some(cwd) => std::fs::canonicalize(cwd)?,
        None => std::env::current_dir()?,
    };

    let server = kordi_app_server::AppServer::from_cwd(cwd)?;
    server.serve(cli.listen).await
}
