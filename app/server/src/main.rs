use anyhow::{Result, bail};
use clap::Parser;
use kordi_app_server::{AppServer, AppServerEnvironmentConfig, SshEnvironmentConfig};
use kordi_protocol::EnvironmentConnectionState;
use std::net::{IpAddr, SocketAddr};
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

    /// SSH host for the active remote environment.
    #[arg(long)]
    ssh_host: Option<String>,

    /// SSH remote workspace root for the active environment.
    #[arg(long)]
    ssh_root: Option<String>,

    /// Optional saved SSH alias / host label.
    #[arg(long)]
    ssh_alias: Option<String>,

    /// Optional SSH username.
    #[arg(long)]
    ssh_user: Option<String>,

    /// Optional SSH port.
    #[arg(long)]
    ssh_port: Option<u16>,

    /// Optional explicit SSH environment id.
    #[arg(long)]
    ssh_environment_id: Option<String>,

    /// Listen address for the local app server.
    #[arg(long, default_value = "127.0.0.1:7080")]
    listen: SocketAddr,
}

impl Cli {
    fn environment_config(&self) -> Result<AppServerEnvironmentConfig> {
        let using_ssh = self.ssh_host.is_some()
            || self.ssh_root.is_some()
            || self.ssh_alias.is_some()
            || self.ssh_user.is_some()
            || self.ssh_port.is_some()
            || self.ssh_environment_id.is_some();

        if using_ssh {
            if self.cwd.is_some() {
                bail!("--cwd cannot be combined with SSH environment flags");
            }

            let Some(host) = self.ssh_host.clone() else {
                bail!("--ssh-host is required when using SSH environment flags");
            };
            let Some(remote_root) = self.ssh_root.clone() else {
                bail!("--ssh-root is required when using SSH environment flags");
            };

            return Ok(AppServerEnvironmentConfig::Ssh(SshEnvironmentConfig {
                environment_id: self.ssh_environment_id.clone(),
                display_name: self.ssh_alias.clone().map(|alias| format!("SSH {alias}")),
                connection_state: EnvironmentConnectionState::Disconnected,
                alias: self.ssh_alias.clone(),
                host,
                port: self.ssh_port,
                user: self.ssh_user.clone(),
                remote_root,
            }));
        }

        let cwd = match &self.cwd {
            Some(cwd) => std::fs::canonicalize(cwd)?,
            None => std::env::current_dir()?,
        };

        Ok(AppServerEnvironmentConfig::Local { cwd })
    }
}

fn workspace_api_base_url(listen: SocketAddr) -> String {
    let host = match listen.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => "127.0.0.1".to_string(),
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) if ip.is_unspecified() => "[::1]".to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    format!("http://{host}:{}", listen.port())
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
    let environment = cli.environment_config()?;
    let server = AppServer::from_environment_config_with_workspace_api_base_url(
        environment,
        Some(workspace_api_base_url(cli.listen)),
    )?;
    server.serve(cli.listen).await
}
