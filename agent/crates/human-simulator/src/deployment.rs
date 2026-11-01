//! Provider lifecycle operations for the same durable, headless worker.
mod fly;
mod k3s;

use crate::deployment_config::{Backend, DeploymentConfig};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::path::Path;

#[derive(Clone, Copy)]
pub enum Operation {
    Deploy,
    Status,
    Stop,
}

pub fn load(path: &Path) -> Result<DeploymentConfig> {
    let bytes = std::fs::read(path).context("Cannot read deployment configuration")?;
    anyhow::ensure!(
        bytes.len() <= 32 * 1024,
        "Deployment configuration exceeds limit"
    );
    let config: DeploymentConfig = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Invalid deployment configuration JSON"))?;
    config.validate()?;
    Ok(config)
}

pub async fn execute(path: &Path, operation: Operation, dry_run: bool) -> Result<()> {
    let config = load(path)?;
    if dry_run {
        println!("{}", serde_json::to_string_pretty(&config.manifest())?);
        return Ok(());
    }
    let status = match &config.backend {
        Backend::K3s { .. } => k3s::execute(&config, operation).await?,
        Backend::Fly { .. } => fly::execute(&config, operation).await?,
    };
    println!("{}", serde_json::to_string(&status)?);
    Ok(())
}

pub(super) fn summary(backend: &str, state: &str) -> Value {
    json!({"backend":backend,"worker_state":state})
}

/// Provider defaults may add fields; every requested field must be preserved.
pub(super) fn contains(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => e
            .iter()
            .all(|(k, v)| a.get(k).is_some_and(|a| contains(a, v))),
        (Value::Array(a), Value::Array(e)) => {
            a.len() == e.len() && a.iter().zip(e).all(|(a, e)| contains(a, e))
        }
        _ => actual == expected,
    }
}
