use base64::Engine;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct K8sSandboxConfig {
    pub namespace: String,
    pub image: String,
    pub ttl_seconds_after_finished: i64,
    pub storage_request: String,
    pub cpu_millis: u32,
    pub memory_mib: u32,
}

impl Default for K8sSandboxConfig {
    fn default() -> Self {
        Self {
            cpu_millis: bounded_resource("KORDI_CLOUD_SANDBOX_CPU_MILLIS", 1000, 100, 16000),
            memory_mib: bounded_resource("KORDI_CLOUD_SANDBOX_MEMORY_MIB", 1024, 128, 32768),
            namespace: std::env::var("KORDI_CLOUD_SANDBOX_NAMESPACE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    if cfg!(debug_assertions) {
                        "kordi-cloud".to_string()
                    } else {
                        panic!("An explicit sandbox namespace is required")
                    }
                }),
            image: std::env::var("KORDI_CLOUD_SANDBOX_IMAGE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    if cfg!(debug_assertions) {
                        "alpine:3.20".to_string()
                    } else {
                        panic!("An explicit sandbox image is required")
                    }
                }),
            ttl_seconds_after_finished: std::env::var("KORDI_CLOUD_SANDBOX_JOB_TTL_SECONDS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(300),
            storage_request: std::env::var("KORDI_CLOUD_SANDBOX_STORAGE_REQUEST")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "512Mi".to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum K8sSandboxOperation {
    ReadText { path: String },
    ReadBytes { path: String },
    ReadBytesBounded { path: String, max_bytes: usize },
    WriteText { path: String, content: String },
    List { path: String },
    Bash { command: String },
}

pub fn build_sandbox_pvc_spec(config: &K8sSandboxConfig, sandbox_id: &str) -> Value {
    let safe_id = safe_k8s_name(sandbox_id);
    let pvc_name = format!("kordi-cloud-sandbox-{safe_id}");
    json!({
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {
            "name": pvc_name,
            "namespace": config.namespace,
            "labels": workspace_labels(sandbox_id),
        },
        "spec": {
            "accessModes": ["ReadWriteOnce"],
            "resources": {
                "requests": {
                    "storage": config.storage_request,
                }
            }
        }
    })
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
                        "resources": {
                            "limits": { "cpu": format!("{}m", config.cpu_millis), "memory": format!("{}Mi", config.memory_mib) },
                            "requests": { "cpu": "50m", "memory": "64Mi" }
                        },
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

pub fn sandbox_pvc_name(sandbox_id: &str) -> String {
    format!("kordi-cloud-sandbox-{}", safe_k8s_name(sandbox_id))
}

fn sandbox_labels(sandbox_id: &str) -> Value {
    json!({
        "app.kubernetes.io/name": "kordi-cloud-sandbox-executor",
        "kordi.ai/sandbox-id": sandbox_id,
    })
}

fn workspace_labels(sandbox_id: &str) -> Value {
    json!({
        "app.kubernetes.io/name": "kordi-cloud-sandbox-workspace",
        "kordi.ai/sandbox-id": sandbox_id,
    })
}

fn operation_command(operation: K8sSandboxOperation) -> String {
    match operation {
        K8sSandboxOperation::ReadText { path } => format!("cat -- {}", shell_quote(&path)),
        K8sSandboxOperation::ReadBytes { path } => format!("base64 < {}", shell_quote(&path)),
        K8sSandboxOperation::ReadBytesBounded { path, max_bytes } => format!(
            "resolved=$(realpath -- {path}) || exit 1; case \"$resolved\" in /workspace/*) ;; *) exit 1 ;; esac; test -f \"$resolved\" || exit 1; head -c {limit} -- \"$resolved\" | base64",
            path = shell_quote(&path), limit = max_bytes.saturating_add(1),
        ),
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

fn bounded_resource(name: &str, default: u32, min: u32, max: u32) -> u32 {
    let value = match std::env::var(name) {
        Ok(value) => value
            .parse::<u32>()
            .expect("Sandbox resource limit must be an integer"),
        Err(std::env::VarError::NotPresent) => default,
        Err(_) => panic!("Invalid sandbox resource limit"),
    };
    assert!(
        (min..=max).contains(&value),
        "Sandbox resource limit is outside safe bounds"
    );
    value
}

#[cfg(test)]
mod distribution_resource_tests {
    use super::*;

    #[test]
    fn selected_resource_limits_preserve_sandbox_security() {
        let config = K8sSandboxConfig {
            cpu_millis: 750,
            memory_mib: 768,
            ..Default::default()
        };
        let job = build_sandbox_job_spec(
            &config,
            "synthetic-sandbox",
            K8sSandboxOperation::List {
                path: ".".to_string(),
            },
        );
        let pod = &job["spec"]["template"]["spec"];
        let container = &pod["containers"][0];
        assert_eq!(container["resources"]["limits"]["cpu"], "750m");
        assert_eq!(container["resources"]["limits"]["memory"], "768Mi");
        assert_eq!(container["securityContext"]["privileged"], false);
        assert_eq!(
            container["securityContext"]["allowPrivilegeEscalation"],
            false
        );
        assert_eq!(pod["automountServiceAccountToken"], false);
        assert_eq!(pod["securityContext"]["runAsNonRoot"], true);
    }
}
