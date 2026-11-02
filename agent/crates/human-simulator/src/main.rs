use clap::Parser;

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: kordi_human_simulator::cli::SimCommand,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    kordi_human_simulator::cli::execute(Args::parse().command).await
}
