use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;

mod job_spec;
mod runner;

pub use job_spec::{build_sandbox_job_spec, K8sSandboxConfig, K8sSandboxOperation};
pub use runner::{K8sCommandOutput, K8sCommandRunner, KubectlCommandRunner};

use crate::sandbox_client::{BashOutput, SandboxBackend, SandboxClientError};
use crate::tool_policy::{is_owner_local_path, RunnerToolBlockReason};
use job_spec::safe_k8s_name;

pub struct K8sSandboxBackend {
    config: K8sSandboxConfig,
    sandbox_id: String,
    runner: Arc<dyn K8sCommandRunner>,
}

impl K8sSandboxBackend {
    pub fn new(
        config: K8sSandboxConfig,
        sandbox_id: String,
        runner: Arc<dyn K8sCommandRunner>,
    ) -> Self {
        Self {
            config,
            sandbox_id,
            runner,
        }
    }

    pub fn from_env(sandbox_id: String) -> Self {
        Self::new(
            K8sSandboxConfig::default(),
            sandbox_id,
            Arc::new(KubectlCommandRunner),
        )
    }

    async fn run_operation(
        &self,
        operation: K8sSandboxOperation,
    ) -> Result<K8sCommandOutput, SandboxClientError> {
        let job_name = format!("kordi-sandbox-{}", safe_k8s_name(&self.sandbox_id));
        let spec = build_sandbox_job_spec(&self.config, &self.sandbox_id, operation);
        self.runner
            .run_json_job(&self.config.namespace, &job_name, spec)
            .await
    }
}

#[async_trait]
impl SandboxBackend for K8sSandboxBackend {
    fn resolve_path(&self, relative_path: &str) -> Result<PathBuf, SandboxClientError> {
        validate_sandbox_relative_path(relative_path)
    }

    async fn read_text(&self, relative_path: &str) -> Result<String, SandboxClientError> {
        self.resolve_path(relative_path)?;
        Ok(self
            .run_operation(K8sSandboxOperation::ReadText {
                path: relative_path.to_string(),
            })
            .await?
            .stdout)
    }

    async fn read_bytes(&self, relative_path: &str) -> Result<Vec<u8>, SandboxClientError> {
        self.resolve_path(relative_path)?;
        let output = self
            .run_operation(K8sSandboxOperation::ReadBytes {
                path: relative_path.to_string(),
            })
            .await?;
        base64::engine::general_purpose::STANDARD
            .decode(output.stdout.trim())
            .map_err(|err| SandboxClientError::Process(err.to_string()))
    }

    async fn write_text(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<(), SandboxClientError> {
        self.resolve_path(relative_path)?;
        let output = self
            .run_operation(K8sSandboxOperation::WriteText {
                path: relative_path.to_string(),
                content: content.to_string(),
            })
            .await?;
        if output.exit_code == 0 {
            Ok(())
        } else {
            Err(SandboxClientError::Process(output.stderr))
        }
    }

    async fn list(&self, relative_path: &str) -> Result<Vec<String>, SandboxClientError> {
        self.resolve_path(relative_path)?;
        let output = self
            .run_operation(K8sSandboxOperation::List {
                path: relative_path.to_string(),
            })
            .await?;
        Ok(output
            .stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect())
    }

    async fn run_bash(&self, command: &str) -> Result<BashOutput, SandboxClientError> {
        validate_sandbox_command(command)?;
        let output = self
            .run_operation(K8sSandboxOperation::Bash {
                command: command.to_string(),
            })
            .await?;
        Ok(BashOutput {
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

fn validate_sandbox_relative_path(relative_path: &str) -> Result<PathBuf, SandboxClientError> {
    let trimmed = relative_path.trim();
    if is_owner_local_path(trimmed) {
        return Err(SandboxClientError::BlockedPath(
            RunnerToolBlockReason::OwnerLocalResource,
        ));
    }
    let relative = Path::new(trimmed);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(SandboxClientError::BlockedPath(
            RunnerToolBlockReason::PathEscapesSandbox,
        ));
    }
    Ok(PathBuf::from("/workspace").join(relative))
}

fn validate_sandbox_command(command: &str) -> Result<(), SandboxClientError> {
    if command.contains("/Users/") || command.contains("/home/") {
        return Err(SandboxClientError::BlockedPath(
            RunnerToolBlockReason::OwnerLocalResource,
        ));
    }
    if command.contains("../")
        || command.starts_with('/')
        || command.contains(" /")
        || command.contains("=/")
        || command.contains(" >/")
        || command.contains("> /")
    {
        return Err(SandboxClientError::BlockedPath(
            RunnerToolBlockReason::PathEscapesSandbox,
        ));
    }
    Ok(())
}
