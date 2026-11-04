//! Render Sandboxes execute untrusted code; a dedicated persistent runner disk
//! owns acknowledged workspace checkpoints. Each operation uses a fresh guest.
mod api;
mod store;
#[cfg(test)]
mod tests;

use crate::sandbox_client::{BashOutput, SandboxBackend, SandboxClientError};
use crate::tool_policy::{is_owner_local_path, RunnerToolBlockReason};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use tokio::sync::Mutex;

const MAX_BYTES: usize = 1024 * 1024;
const CHECKPOINT_LIMIT: usize = 24 * MAX_BYTES;
const GUEST_SCRIPT: &str = include_str!("guest.py");
const EXECUTOR: &str = include_str!("../fly_sandbox/operation.py");

fn error(message: &str) -> SandboxClientError {
    SandboxClientError::Process(message.into())
}
fn identifier(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() > prefix.len()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
pub struct RenderSandboxConfig {
    pub owner: String,
    pub group: String,
    pub token: String,
    pub root: PathBuf,
    pub max_workspaces: usize,
}
impl RenderSandboxConfig {
    pub fn from_env() -> Result<Self, SandboxClientError> {
        let required = |name| {
            std::env::var(name)
                .ok()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| error("Render sandbox configuration is incomplete"))
        };
        let config = Self {
            owner: required("KORDI_RENDER_SANDBOX_OWNER")?,
            group: required("KORDI_RENDER_SANDBOX_GROUP")?,
            token: required("KORDI_RENDER_SANDBOX_TOKEN")?,
            root: required("KORDI_RENDER_WORKSPACE_ROOT")?.into(),
            max_workspaces: std::env::var("KORDI_RENDER_MAX_WORKSPACES")
                .unwrap_or_else(|_| "256".into())
                .parse()
                .map_err(|_| error("Invalid Render workspace capacity"))?,
        };
        config.validate()?;
        Ok(config)
    }
    fn validate(&self) -> Result<(), SandboxClientError> {
        if !identifier(&self.owner, "tea-")
            || !identifier(&self.group, "sbg-")
            || self.token.trim().is_empty()
            || !(1..=1024).contains(&self.max_workspaces)
            || !self.root.is_absolute()
            || !self.root.is_dir()
            || std::fs::canonicalize(&self.root)? != self.root
        {
            return Err(error(
                "Invalid Render sandbox config; supply a dedicated persistent workspace directory",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&self.root)?.permissions().mode() & 0o077 != 0 {
                return Err(error(
                    "Render workspace directory must be private to the runner user",
                ));
            }
        }
        Ok(())
    }
}
pub struct RenderSandboxBackend {
    config: RenderSandboxConfig,
    api: api::Api,
    id: String,
    operation: Mutex<()>,
}
impl RenderSandboxBackend {
    pub fn from_env(id: &str) -> Result<Self, SandboxClientError> {
        Self::new(RenderSandboxConfig::from_env()?, id)
    }
    pub fn new(config: RenderSandboxConfig, id: &str) -> Result<Self, SandboxClientError> {
        config.validate()?;
        if id.is_empty() || id.len() > 256 {
            return Err(error("Invalid workspace identity"));
        }
        Ok(Self {
            api: api::Api::new(&config)?,
            config,
            id: id.into(),
            operation: Mutex::new(()),
        })
    }
    async fn run(&self, operation: Value) -> Result<BashOutput, SandboxClientError> {
        let _serial = self.operation.lock().await;
        self.api.drain_cleanup().await?;
        let workspace = store::Workspace::acquire(&self.config, &self.id)?;
        let checkpoint = workspace.load()?;
        let mut guest = self.api.create().await?;
        if let Some(bytes) = checkpoint {
            validate_checkpoint(&bytes)?;
            self.api.upload(&guest.id, bytes).await?;
        }
        self.api
            .exec(&guest.id, command(json!({"kind":"initialize"}))?)
            .await?;
        let result = self
            .api
            .exec(
                &guest.id,
                command(json!({
                    "kind":"execute", "executor":STANDARD.encode(EXECUTOR), "operation":operation
                }))?,
            )
            .await?;
        let output = BashOutput {
            exit_code: result["exit_code"]
                .as_i64()
                .and_then(|v| i32::try_from(v).ok())
                .ok_or_else(|| error("Invalid guest exit status"))?,
            stdout: output_field(&result, "stdout")?,
            stderr: output_field(&result, "stderr")?,
        };
        let bytes = self.api.download(&guest.id).await?;
        validate_checkpoint(&bytes)?;
        // No process survives an acknowledged operation. Cancellation or failure
        // discards unacknowledged changes and retains the previous checkpoint.
        guest.finish().await?;
        workspace.commit(&bytes)?;
        Ok(output)
    }
    async fn success(&self, operation: Value) -> Result<String, SandboxClientError> {
        let output = self.run(operation).await?;
        if output.exit_code != 0 {
            return Err(error(
                "Render workspace operation failed or exceeded its limit",
            ));
        }
        Ok(output.stdout)
    }
}
fn command(request: Value) -> Result<String, SandboxClientError> {
    let bytes = serde_json::to_vec(&request).map_err(|_| error("Invalid workspace request"))?;
    if bytes.len() > 2 * MAX_BYTES {
        return Err(error("Workspace request exceeds limit"));
    }
    Ok(format!(
        "python3 -I -c 'import base64;exec(base64.b64decode(\"{}\"))' '{}'",
        STANDARD.encode(GUEST_SCRIPT),
        STANDARD.encode(bytes)
    ))
}
fn output_field(value: &Value, key: &str) -> Result<String, SandboxClientError> {
    value[key]
        .as_str()
        .filter(|s| s.len() <= 2 * MAX_BYTES)
        .map(str::to_owned)
        .ok_or_else(|| error("Invalid or oversized guest output"))
}
fn workspace_path(path: &str) -> Result<PathBuf, SandboxClientError> {
    if is_owner_local_path(path) {
        return Err(SandboxClientError::BlockedPath(
            RunnerToolBlockReason::OwnerLocalResource,
        ));
    }
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|p| matches!(p, Component::ParentDir))
    {
        return Err(SandboxClientError::BlockedPath(
            RunnerToolBlockReason::PathEscapesSandbox,
        ));
    }
    Ok(Path::new("/workspace").join(relative))
}
fn validate_checkpoint(bytes: &[u8]) -> Result<(), SandboxClientError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| error("Invalid workspace checkpoint"))?;
    let entries = value
        .as_array()
        .filter(|v| v.len() <= 2048)
        .ok_or_else(|| error("Invalid checkpoint entries"))?;
    let mut seen = std::collections::HashMap::new();
    let mut size = 0;
    for entry in entries {
        let path = entry["path"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
            .ok_or_else(|| error("Invalid checkpoint path"))?;
        let relative = Path::new(path);
        if path.contains('\\')
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            || seen.contains_key(path)
            || relative.to_string_lossy() != path
        {
            return Err(error("Invalid checkpoint path"));
        }
        if let Some(parent) = relative.parent().filter(|p| !p.as_os_str().is_empty()) {
            if seen.get(parent.to_string_lossy().as_ref()) != Some(&"directory") {
                return Err(error("Invalid checkpoint parent"));
            }
        }
        let kind = entry["kind"]
            .as_str()
            .ok_or_else(|| error("Missing checkpoint entry kind"))?;
        match kind {
            "directory" => {}
            "file" => {
                if !entry["executable"].is_boolean() {
                    return Err(error("Invalid checkpoint permissions"));
                }
                let data = STANDARD
                    .decode(
                        entry["data"]
                            .as_str()
                            .ok_or_else(|| error("Missing checkpoint bytes"))?,
                    )
                    .map_err(|_| error("Invalid checkpoint bytes"))?;
                size += data.len();
                if size > 16 * MAX_BYTES {
                    return Err(error("Workspace exceeds capacity"));
                }
            }
            _ => return Err(error("Unsupported checkpoint entry")),
        }
        seen.insert(path, kind);
    }
    Ok(())
}
#[async_trait]
impl SandboxBackend for RenderSandboxBackend {
    async fn shutdown(&self) -> Result<(), SandboxClientError> {
        let _serial = self.operation.lock().await;
        self.api.drain_cleanup().await
    }
    fn resolve_path(&self, path: &str) -> Result<PathBuf, SandboxClientError> {
        workspace_path(path)
    }
    async fn read_text(&self, path: &str) -> Result<String, SandboxClientError> {
        self.resolve_path(path)?;
        self.success(json!({"kind":"read_text","path":path})).await
    }
    async fn read_bytes(&self, path: &str) -> Result<Vec<u8>, SandboxClientError> {
        self.read_bytes_bounded(path, MAX_BYTES).await
    }
    async fn read_bytes_bounded(
        &self,
        path: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, SandboxClientError> {
        self.resolve_path(path)?;
        let value = self
            .success(json!({"kind":"read_bytes","path":path,"max_bytes":max_bytes.min(MAX_BYTES)}))
            .await?;
        let bytes = STANDARD
            .decode(value)
            .map_err(|_| error("Invalid workspace bytes"))?;
        if bytes.len() > max_bytes.min(MAX_BYTES) {
            return Err(error("Workspace file exceeds read limit"));
        }
        Ok(bytes)
    }
    async fn write_text(&self, path: &str, content: &str) -> Result<(), SandboxClientError> {
        self.resolve_path(path)?;
        if content.len() > MAX_BYTES {
            return Err(error("Workspace file exceeds write limit"));
        }
        self.success(json!({"kind":"write_text","path":path,"content":content}))
            .await?;
        Ok(())
    }
    async fn list(&self, path: &str) -> Result<Vec<String>, SandboxClientError> {
        self.resolve_path(path)?;
        Ok(self
            .success(json!({"kind":"list","path":path}))
            .await?
            .lines()
            .map(str::to_owned)
            .collect())
    }
    async fn run_bash(&self, command: &str) -> Result<BashOutput, SandboxClientError> {
        self.run(json!({"kind":"bash","command":command})).await
    }
}
