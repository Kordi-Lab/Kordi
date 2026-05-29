use std::process::Stdio;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::sandbox_client::SandboxClientError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct K8sCommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[async_trait]
pub trait K8sCommandRunner: Send + Sync {
    async fn ensure_pvc(
        &self,
        namespace: &str,
        pvc_name: &str,
        pvc_spec: Value,
    ) -> Result<(), SandboxClientError>;

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
    async fn ensure_pvc(
        &self,
        namespace: &str,
        _pvc_name: &str,
        pvc_spec: Value,
    ) -> Result<(), SandboxClientError> {
        kubectl_apply_manifest(namespace, &pvc_spec).await
    }

    async fn run_json_job(
        &self,
        namespace: &str,
        job_name: &str,
        job_spec: Value,
    ) -> Result<K8sCommandOutput, SandboxClientError> {
        kubectl_apply_manifest(namespace, &job_spec).await?;
        kubectl_wait_for_job(namespace, job_name).await?;
        let logs = kubectl_logs(namespace, job_name).await;
        let _ = kubectl_delete_job(namespace, job_name).await;
        logs
    }
}

async fn kubectl_apply_manifest(
    namespace: &str,
    manifest: &Value,
) -> Result<(), SandboxClientError> {
    let spec_bytes =
        serde_json::to_vec(manifest).map_err(|err| SandboxClientError::Process(err.to_string()))?;
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
    let output = apply
        .wait_with_output()
        .await
        .map_err(SandboxClientError::Io)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(SandboxClientError::Process(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ))
    }
}

async fn kubectl_wait_for_job(namespace: &str, job_name: &str) -> Result<(), SandboxClientError> {
    let output = Command::new("kubectl")
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
    if output.status.success() {
        Ok(())
    } else {
        Err(SandboxClientError::Process(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ))
    }
}

async fn kubectl_logs(
    namespace: &str,
    job_name: &str,
) -> Result<K8sCommandOutput, SandboxClientError> {
    let output = Command::new("kubectl")
        .args(["-n", namespace, "logs", &format!("job/{job_name}")])
        .output()
        .await
        .map_err(SandboxClientError::Io)?;
    Ok(K8sCommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

async fn kubectl_delete_job(namespace: &str, job_name: &str) -> Result<(), SandboxClientError> {
    Command::new("kubectl")
        .args([
            "-n",
            namespace,
            "delete",
            "job",
            job_name,
            "--ignore-not-found=true",
        ])
        .output()
        .await
        .map_err(SandboxClientError::Io)?;
    Ok(())
}
