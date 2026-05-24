use base64::Engine;
use serde_json::{json, Value};

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
            "labels": sandbox_labels(sandbox_id),
        },
        "spec": {
            "ttlSecondsAfterFinished": config.ttl_seconds_after_finished,
            "backoffLimit": 0,
            "template": {
                "metadata": { "labels": sandbox_labels(sandbox_id) },
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
                        "volumeMounts": [{ "name": "workspace", "mountPath": "/workspace" }]
                    }],
                    "volumes": [{
                        "name": "workspace",
                        "persistentVolumeClaim": { "claimName": pvc_name }
                    }]
                }
            }
        }
    })
}

pub fn safe_k8s_name(value: &str) -> String {
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

fn sandbox_labels(sandbox_id: &str) -> Value {
    json!({
        "app.kubernetes.io/name": "kordi-cloud-sandbox-executor",
        "kordi.ai/sandbox-id": sandbox_id,
    })
}

fn operation_command(operation: K8sSandboxOperation) -> String {
    match operation {
        K8sSandboxOperation::ReadText { path } => format!("cat -- {}", shell_quote(&path)),
        K8sSandboxOperation::ReadBytes { path } => format!("base64 < {}", shell_quote(&path)),
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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
