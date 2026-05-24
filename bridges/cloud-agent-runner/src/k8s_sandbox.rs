use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::sandbox_client::{BashOutput, SandboxBackend, SandboxClientError};
use crate::tool_policy::{is_owner_local_path, RunnerToolBlockReason};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct K8sSandboxConfig {
    pub namespace: String,
    pub image: String,
    pub ttl_seconds_after_finished: i64,
}

impl Default for K8sSandboxConfig {
    fn default() -> Self {
        Self {
            namespace: std::env::var("KORDI_CLOUD_SANDBOX_NAMESPACE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "kordi-cloud".to_string()),
            image: std::env::var("KORDI_CLOUD_SANDBOX_IMAGE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "alpine:3.20".to_string()),
            ttl_seconds_after_finished: std::env::var("KORDI_CLOUD_SANDBOX_JOB_TTL_SECONDS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(300),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum K8sSandboxOperation {
    ReadText { path: String },
    ReadBytes { path: String },
    WriteText { path: String, content: String },
    List { path: String },
    Bash { command: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct K8sCommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[async_trait]
pub trait K8sCommandRunner: Send + Sync {
    async fn run_json_job(
        &self,
        namespace: &str,
        job_name: &str,
        job_spec: Value,
    ) -> Result<K8sCommandOutput, SandboxClientError>;
}

pub struct KubectlCommandRunner;

#[async_trait]
impl K8sCommandRunner for KubectlCommandRunner {
    async fn run_json_job(
        &self,
        namespace: &str,
        job_name: &str,
        job_spec: Value,
    ) -> Result<K8sCommandOutput, SandboxClientError> {
        let spec_bytes = serde_json::to_vec(&job_spec)
            .map_err(|err| SandboxClientError::Process(err.to_string()))?;
        let mut apply = Command::new("kubectl")
            .args(["-n", namespace, "apply", "-f", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(SandboxClientError::Io)?;
        let mut stdin = apply.stdin.take().ok_or_else(|| {
            SandboxClientError::Process("kubectl apply stdin unavailable".to_string())
        })?;
        stdin
            .write_all(&spec_bytes)
            .await
            .map_err(SandboxClientError::Io)?;
        drop(stdin);
        let apply_output = apply
            .wait_with_output()
            .await
            .map_err(SandboxClientError::Io)?;
        if !apply_output.status.success() {
            return Err(SandboxClientError::Process(
                String::from_utf8_lossy(&apply_output.stderr).to_string(),
            ));
        }

        let wait_output = Command::new("kubectl")
            .args([
                "-n",
                namespace,
                "wait",
                "--for=condition=complete",
                &format!("job/{job_name}"),
                "--timeout=60s",
            ])
            .output()
            .await
            .map_err(SandboxClientError::Io)?;
        if !wait_output.status.success() {
            return Err(SandboxClientError::Process(
                String::from_utf8_lossy(&wait_output.stderr).to_string(),
            ));
        }

        let logs_output = Command::new("kubectl")
            .args(["-n", namespace, "logs", &format!("job/{job_name}")])
            .output()
            .await
            .map_err(SandboxClientError::Io)?;
        let _ = Command::new("kubectl")
            .args([
                "-n",
                namespace,
                "delete",
                "job",
                job_name,
                "--ignore-not-found=true",
            ])
            .output()
            .await;
        Ok(K8sCommandOutput {
            stdout: String::from_utf8_lossy(&logs_output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&logs_output.stderr).to_string(),
            exit_code: logs_output.status.code().unwrap_or(-1),
        })
    }
}

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

pub fn build_sandbox_job_spec(
    config: &K8sSandboxConfig,
    sandbox_id: &str,
    operation: K8sSandboxOperation,
) -> Value {
    let safe_id = safe_k8s_name(sandbox_id);
    let job_name = format!("kordi-sandbox-{safe_id}");
    let pvc_name = format!("kordi-cloud-sandbox-{safe_id}");
    let command = operation_command(operation);
    json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": config.namespace,
            "labels": {
                "app.kubernetes.io/name": "kordi-cloud-sandbox-executor",
                "kordi.ai/sandbox-id": sandbox_id
            }
        },
        "spec": {
            "ttlSecondsAfterFinished": config.ttl_seconds_after_finished,
            "backoffLimit": 0,
            "template": {
                "metadata": {
                    "labels": {
                        "app.kubernetes.io/name": "kordi-cloud-sandbox-executor",
                        "kordi.ai/sandbox-id": sandbox_id
                    }
                },
                "spec": {
                    "automountServiceAccountToken": false,
                    "restartPolicy": "Never",
                    "securityContext": {
                        "runAsNonRoot": true,
                        "runAsUser": 1000,
                        "runAsGroup": 1000,
                        "fsGroup": 1000
                    },
                    "containers": [{
                        "name": "sandbox-op",
                        "image": config.image,
                        "workingDir": "/workspace",
                        "command": ["/bin/sh", "-lc", command],
                        "securityContext": {
                            "allowPrivilegeEscalation": false,
                            "privileged": false,
                            "runAsNonRoot": true,
                            "readOnlyRootFilesystem": false,
                            "capabilities": { "drop": ["ALL"] }
                        },
                        "volumeMounts": [{
                            "name": "workspace",
                            "mountPath": "/workspace"
                        }]
                    }],
                    "volumes": [{
                        "name": "workspace",
                        "persistentVolumeClaim": {
                            "claimName": pvc_name
                        }
                    }]
                }
            }
        }
    })
}

fn operation_command(operation: K8sSandboxOperation) -> String {
    match operation {
        K8sSandboxOperation::ReadText { path } => format!("cat -- {}", shell_quote(&path)),
        K8sSandboxOperation::ReadBytes { path } => {
            format!("base64 < {}", shell_quote(&path))
        }
        K8sSandboxOperation::WriteText { path, content } => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
            format!(
                "mkdir -p -- $(dirname -- {path}) && printf %s {encoded} | base64 -d > {path}",
                path = shell_quote(&path),
                encoded = shell_quote(&encoded),
            )
        }
        K8sSandboxOperation::List { path } => format!("ls -1 -- {}", shell_quote(&path)),
        K8sSandboxOperation::Bash { command } => command,
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

fn safe_k8s_name(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "sandbox".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
