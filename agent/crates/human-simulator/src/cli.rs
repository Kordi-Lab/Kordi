use crate::{
    client::{ApiClient, required_env},
    config::ActorConfig,
};
use anyhow::{Context, Result};
use clap::Subcommand;
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Clone, Debug, Subcommand)]
pub enum SimCommand {
    /// Validate a versioned actor configuration without network calls.
    Validate {
        #[arg(long)]
        config: PathBuf,
    },
    /// Register an actor; write its one-time worker credential to a private file.
    Create {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        credential_file: PathBuf,
    },
    /// Run one headless actor using a scoped worker credential.
    Run {
        #[arg(long)]
        actor: String,
    },
    /// Read sanitized progress (no messages, memory, or credentials).
    Status {
        #[arg(long)]
        actor: String,
    },
    /// Stop an actor and invalidate its worker lease.
    Stop {
        #[arg(long)]
        actor: String,
    },
}

fn load(path: &std::path::Path) -> Result<ActorConfig> {
    let bytes = std::fs::read(path).context("Cannot read actor configuration")?;
    anyhow::ensure!(
        bytes.len() <= 128 * 1024,
        "Actor configuration exceeds limit"
    );
    let config: ActorConfig =
        serde_json::from_slice(&bytes).context("Invalid actor configuration JSON")?;
    config.validate()?;
    Ok(config)
}

pub async fn execute(command: SimCommand) -> Result<()> {
    if let SimCommand::Validate { config } = &command {
        load(config)?;
        println!("Actor configuration is valid.");
        return Ok(());
    }
    if let SimCommand::Run { actor } = &command {
        return crate::worker::run(actor).await;
    }
    let api = ApiClient::new(
        &required_env("KORDI_SIMULATOR_API_BASE")?,
        required_env("KORDI_SIM_OPERATOR_TOKEN")?,
    )?;
    match command {
        SimCommand::Create {
            config,
            credential_file,
        } => {
            let config = load(&config)?;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&credential_file).context(
                "Create a new private credential file; existing files are never overwritten",
            )?;
            let result: Result<Value> = api.post("/v1/sim/actors", &config).await;
            match result {
                Ok(result) => {
                    use std::io::Write;
                    file.write_all(&serde_json::to_vec_pretty(&result)?)
                        .context("Could not save worker credential")?;
                    file.sync_all()?;
                    println!(
                        "Actor registered; worker credential saved to the requested private file."
                    );
                }
                Err(error) => {
                    drop(file);
                    let _ = std::fs::remove_file(credential_file);
                    return Err(error);
                }
            }
        }
        SimCommand::Status { actor } => {
            validate_actor_id(&actor)?;
            let value: Value = api.get(&format!("/v1/sim/actors/{actor}/status")).await?;
            println!("{}", serde_json::to_string_pretty(&value)?);
        }
        SimCommand::Stop { actor } => {
            validate_actor_id(&actor)?;
            let _: Value = api
                .post(&format!("/v1/sim/actors/{actor}/stop"), &json!({}))
                .await?;
            println!("Actor stopped; new automatic actions are disabled.");
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn validate_actor_id(actor: &str) -> Result<()> {
    anyhow::ensure!(
        !actor.is_empty()
            && actor.len() <= 64
            && actor
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid actor ID"
    );
    Ok(())
}
