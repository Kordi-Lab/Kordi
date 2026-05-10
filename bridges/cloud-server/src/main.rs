//! Entry point for the Kordi cloud-native collaboration server.
//!
//! Run as: `kordi-cloud-server serve --port 17081 --db ./kordi-cloud.db`

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
        /// TCP port to bind. Defaults to 17081 to stay clear of bridges/cli's 17080.
        #[arg(long, default_value_t = 17081)]
        port: u16,
        /// SQLite database path.
        #[arg(long, default_value = "./kordi-cloud.db")]
        db: String,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Serve { port, db } => {
            kordi_cloud_server::run(port, &db).await?;
        }
    }
    Ok(())
}
