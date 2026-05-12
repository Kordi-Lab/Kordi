//! Entry point for the Kordi cloud-native collaboration server.
//!
//! Run as:
//!   DATABASE_URL=postgresql://kordi:<pw>@host:5432/kordi_cloud \
//!     kordi-cloud-server serve --port 17081

use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "kordi-cloud-server",
    about = "Kordi cloud-native collaboration server"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(clap::Subcommand, Debug)]
enum Commands {
    /// Run the HTTP API.
    Serve {
        /// TCP port to bind. Defaults to 17081.
        #[arg(long, default_value_t = 17081)]
        port: u16,
        /// Postgres connection string. Falls back to the DATABASE_URL env var.
        #[arg(long)]
        database_url: Option<String>,
        /// NATS connection string for event publishing. Falls back to
        /// the NATS_URL env var. When unset, events are no-ops.
        #[arg(long)]
        nats_url: Option<String>,
        /// Redis connection string for the cross-replica rate limiter.
        /// Falls back to the REDIS_URL env var. When unset, the limiter
        /// runs in-memory.
        #[arg(long)]
        redis_url: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Serve {
            port,
            database_url,
            nats_url,
            redis_url,
        } => {
            let database_url = database_url
                .or_else(|| std::env::var("DATABASE_URL").ok())
                .ok_or("DATABASE_URL is required (env var or --database-url flag)")?;
            let nats_url = nats_url.or_else(|| std::env::var("NATS_URL").ok());
            let redis_url = redis_url.or_else(|| std::env::var("REDIS_URL").ok());
            kordi_cloud_server::run(
                port,
                &database_url,
                nats_url.as_deref(),
                redis_url.as_deref(),
            )
            .await?;
        }
    }
    Ok(())
}
