//! Fly Machines are disposable compute; one encrypted volume retains each
//! sandbox's workspace. Use a dedicated, secret-free Fly app and one provisioner.
mod api;

use crate::sandbox_client::{BashOutput, SandboxBackend, SandboxClientError};
use crate::tool_policy::{is_owner_local_path, RunnerToolBlockReason};
use api::{error, Api};
use async_trait::async_trait;
use base64::Engine;
use reqwest::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::Mutex;

const OPERATION_SCRIPT: &str = include_str!("operation.py");
const INIT: &str = "mkdir -p /workspace && chown 1000:1000 /workspace && exec sleep 840";
const MAX_BYTES: usize = 1024 * 1024;
static PROVISION: OnceLock<Mutex<()>> = OnceLock::new();

pub struct FlySandboxConfig {
    pub app: String,
    pub region: String,
    pub image: String,
    pub token: String,
    pub max_workspaces: usize,
}

impl FlySandboxConfig {
    pub fn from_env() -> Result<Self, SandboxClientError> {
        let required = |name| {
            std::env::var(name)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| error("Fly sandbox configuration is incomplete"))
        };
        let config = Self {
            app: required("KORDI_FLY_SANDBOX_APP")?,
            region: required("KORDI_FLY_SANDBOX_REGION")?,
            image: required("KORDI_FLY_SANDBOX_IMAGE")?,
            token: required("KORDI_FLY_SANDBOX_TOKEN")?,
            max_workspaces: std::env::var("KORDI_FLY_MAX_WORKSPACES")
                .unwrap_or_else(|_| "4".into())
                .parse()
                .map_err(|_| error("Invalid Fly workspace limit"))?,
        };
        config.validate()?;
        Ok(config)
    }
    fn validate(&self) -> Result<(), SandboxClientError> {
        if !identifier(&self.app)
            || !identifier(&self.region)
            || !(1..=16).contains(&self.max_workspaces)
            || self.token.is_empty()
            || !self
                .image
                .split_once("@sha256:")
                .is_some_and(|(name, hash)| {
                    !name.is_empty()
                        && hash.len() == 64
                        && hash.bytes().all(|b| b.is_ascii_hexdigit())
                })
        {
            return Err(error(
                "Invalid Fly sandbox config; pin the Python image by digest",
            ));
        }
        Ok(())
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn field(value: &Value, name: &str) -> Result<String, SandboxClientError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| error("Fly response is missing a required field"))
}
fn rows(value: &Value) -> Result<&Vec<Value>, SandboxClientError> {
    value
        .as_array()
        .ok_or_else(|| error("Fly resource listing is invalid"))
}
fn workspace_key(id: &str) -> Result<String, SandboxClientError> {
    if id.is_empty() || id.len() > 256 {
        return Err(error("Invalid sandbox id"));
    }
    Ok(format!("{:x}", Sha256::digest(id.as_bytes())))
}
fn path_in_workspace(path: &str) -> Result<PathBuf, SandboxClientError> {
    if is_owner_local_path(path) {
        return Err(SandboxClientError::BlockedPath(
            RunnerToolBlockReason::OwnerLocalResource,
        ));
    }
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(SandboxClientError::BlockedPath(
            RunnerToolBlockReason::PathEscapesSandbox,
        ));
    }
    Ok(Path::new("/workspace").join(relative))
}

#[derive(Clone)]
struct Lease {
    id: String,
    lock_id: String,
    nonce: String,
}

pub struct FlySandboxBackend {
    config: FlySandboxConfig,
    api: Api,
    key: String,
    lease: Mutex<Option<Lease>>,
    operation: Mutex<()>,
}

impl FlySandboxBackend {
    pub fn new(config: FlySandboxConfig, sandbox_id: &str) -> Result<Self, SandboxClientError> {
        config.validate()?;
        Ok(Self {
            api: Api::new(&config.app, config.token.clone())?,
            config,
            key: workspace_key(sandbox_id)?,
            lease: Mutex::new(None),
            operation: Mutex::new(()),
        })
    }
    pub fn from_env(sandbox_id: &str) -> Result<Self, SandboxClientError> {
        Self::new(FlySandboxConfig::from_env()?, sandbox_id)
    }
    fn machine_config(&self, volume: &str) -> Value {
        json!({"image":self.config.image,"env":{},"services":[],
            "init":{"exec":["/bin/sh","-c",INIT]},
            "guest":{"cpu_kind":"shared","cpus":1,"memory_mb":512},
            "restart":{"policy":"no"},"auto_destroy":false,
            "metadata":{"kordi_workspace":self.key,"kordi_executor":"fly-v1"},
            "mounts":[{"volume":volume,"path":"/workspace"}]})
    }
    async fn ensure(&self) -> Result<Lease, SandboxClientError> {
        if let Some(lease) = self.lease.lock().await.as_ref() {
            return Ok(lease.clone());
        }
        // This validation deployment has exactly one runner process. Serializing
        // provisioning also makes its workspace count an admission limit.
        let _provision = PROVISION.get_or_init(|| Mutex::new(())).lock().await;
        let name = format!("ks-{}", &self.key[..40]);
        let machines = self.api.call(Method::GET, "/machines", None, None).await?;
        let matching: Vec<_> = rows(&machines)?
            .iter()
            .filter(|m| m["name"] == name)
            .collect();
        if matching.len() > 1 {
            return Err(error(
                "Duplicate Fly workspace machines; operator reconciliation required",
            ));
        }
        let machine = if let Some(machine) = matching.first() {
            (*machine).clone()
        } else {
            let volumes = self.api.call(Method::GET, "/volumes", None, None).await?;
            let volume_name = format!("ks_{}", &self.key[..24]);
            let matches: Vec<_> = rows(&volumes)?
                .iter()
                .filter(|v| v["name"] == volume_name)
                .collect();
            if matches.len() > 1 {
                return Err(error(
                    "Duplicate Fly workspace volumes; preserve and reconcile them",
                ));
            }
            if rows(&machines)?
                .iter()
                .filter(|m| m["config"]["metadata"]["kordi_executor"] == "fly-v1")
                .count()
                >= self.config.max_workspaces
            {
                return Err(error(
                    "Fly workspace limit reached; increase capacity explicitly",
                ));
            }
            let volume = if let Some(volume) = matches.first() {
                (*volume).clone()
            } else {
                if rows(&volumes)?.len() >= self.config.max_workspaces {
                    return Err(error("Fly volume limit reached"));
                }
                self.api.call(Method::POST,"/volumes",Some(json!({"name":volume_name,"region":self.config.region,
                    "size_gb":1,"encrypted":true,"snapshot_retention":1,"auto_backup_enabled":true})),None).await?
            };
            if volume["region"] != self.config.region
                || volume["encrypted"] != true
                || !volume["attached_machine_id"].is_null()
            {
                return Err(error("Fly volume is not available for this workspace"));
            }
            self.api
                .call(
                    Method::POST,
                    "/machines",
                    Some(json!({"name":name,"region":self.config.region,
                "skip_launch":true,"config":self.machine_config(&field(&volume,"id")?)})),
                    None,
                )
                .await?
        };
        self.validate_machine(&machine)?;
        let volume_id = field(&machine["config"]["mounts"][0], "volume")?;
        if !volume_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(error("Invalid Fly volume id"));
        }
        let volume = self
            .api
            .call(Method::GET, &format!("/volumes/{volume_id}"), None, None)
            .await?;
        if volume["name"] != format!("ks_{}", &self.key[..24])
            || volume["region"] != self.config.region
            || volume["encrypted"] != true
        {
            return Err(error("Fly volume does not belong to this workspace"));
        }
        let id = field(&machine, "id")?;
        if !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(error("Invalid Fly machine id"));
        }
        // Fly Exec rejects calls while the execution VM itself is leased,
        // even when a lease nonce is supplied. Hold a stopped coordinator VM's
        // lease instead. All provisioners must use this protocol and one app.
        let lock_name = format!("kl-{}", &self.key[..40]);
        let locks: Vec<_> = rows(&machines)?
            .iter()
            .filter(|m| m["name"] == lock_name)
            .collect();
        if locks.len() > 1 {
            return Err(error("Duplicate Fly workspace coordinators"));
        }
        let lock = if let Some(lock) = locks.first() {
            (*lock).clone()
        } else {
            let mut config = self.machine_config("");
            config["mounts"] = json!([]);
            config["metadata"]["kordi_executor"] = json!("fly-lock-v1");
            config["guest"]["memory_mb"] = json!(256);
            self.api
                .call(
                    Method::POST,
                    "/machines",
                    Some(json!({"name":lock_name,
                "region":self.config.region,"skip_launch":true,"config":config})),
                    None,
                )
                .await?
        };
        if lock["config"]["metadata"]["kordi_workspace"] != self.key
            || lock["config"]["metadata"]["kordi_executor"] != "fly-lock-v1"
            || !matches!(lock["state"].as_str(), Some("stopped" | "created"))
        {
            return Err(error("Invalid Fly workspace coordinator"));
        }
        let lock_id = field(&lock, "id")?;
        drop(_provision);
        let mut claimed = None;
        // A crashed runner stops renewing its short coordinator lease. Wait
        // for that lease to expire instead of failing a recovered server run.
        for attempt in 0..36 {
            let result = self
                .api
                .call(
                    Method::POST,
                    &format!("/machines/{lock_id}/lease"),
                    Some(json!({"ttl":60,"description":"Kordi isolated workspace execution"})),
                    None,
                )
                .await;
            match result {
                Ok(value) => {
                    claimed = Some(value);
                    break;
                }
                Err(err) if attempt < 35 && err.to_string().contains("HTTP 409 for lease") => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                Err(err) => return Err(err),
            }
        }
        let claimed = claimed.ok_or_else(|| error("Fly workspace remains busy"))?;
        let lease = Lease {
            id,
            lock_id,
            nonce: field(&claimed["data"], "nonce")?,
        };
        *self.lease.lock().await = Some(lease.clone());
        // An expired prior lease may leave a bounded command running. Stop it
        // before taking over the workspace; never reuse the previous process.
        if machine["state"] != "stopped" && machine["state"] != "created" {
            stop(&self.api, &lease).await?;
        }
        // Fly's stopped state can precede the host releasing the VM. Retry
        // only a refused start, never a create or an ambiguous execution.
        for attempt in 0..15 {
            let started = self
                .api
                .call(
                    Method::POST,
                    &format!("/machines/{}/start", lease.id),
                    Some(json!({})),
                    None,
                )
                .await;
            match started {
                Ok(_) => break,
                Err(err) if attempt < 14 && err.to_string().contains("HTTP 412 for start") => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                Err(err) => return Err(err),
            }
        }
        self.api
            .call(
                Method::GET,
                &format!("/machines/{}/wait?state=started&timeout=30", lease.id),
                None,
                None,
            )
            .await?;
        Ok(lease)
    }
    fn validate_machine(&self, machine: &Value) -> Result<(), SandboxClientError> {
        let c = &machine["config"];
        if machine["region"] != self.config.region
            || c["metadata"]["kordi_workspace"] != self.key
            || c["metadata"]["kordi_executor"] != "fly-v1"
            || c["image"] != self.config.image
            || c["init"]["exec"] != json!(["/bin/sh", "-c", INIT])
            || c["mounts"].as_array().map(Vec::len) != Some(1)
            || c["mounts"][0]["path"] != "/workspace"
            || c["services"].as_array().is_some_and(|v| !v.is_empty())
            || c["env"].as_object().is_some_and(|v| !v.is_empty())
        {
            return Err(error(
                "Fly workspace machine does not match the approved isolation configuration",
            ));
        }
        Ok(())
    }
    async fn run(&self, operation: Value) -> Result<BashOutput, SandboxClientError> {
        let _operation = self.operation.lock().await;
        let encoded = serde_json::to_vec(&operation).map_err(|_| error("Invalid Fly operation"))?;
        if encoded.len() > 2 * MAX_BYTES {
            return Err(error("Fly operation exceeds input limit"));
        }
        let lease = self.ensure().await?;
        let script = base64::engine::general_purpose::STANDARD.encode(OPERATION_SCRIPT);
        let data = base64::engine::general_purpose::STANDARD.encode(encoded);
        // Only base64 data enters the command. Neither shell fragments nor any
        // runner credentials are interpolated into the guest's command line.
        let cmd =
            format!("python3 -c 'import base64;exec(base64.b64decode(\"{script}\"))' '{data}'");
        let result = self
            .api
            .call(
                Method::POST,
                &format!("/machines/{}/exec", lease.id),
                Some(json!({"cmd":cmd,"timeout":45})),
                None,
            )
            .await?;
        if result["exit_code"].as_i64().unwrap_or(0) != 0 {
            return Err(error("Fly guest executor failed"));
        }
        let result: Value = serde_json::from_str(result["stdout"].as_str().unwrap_or(""))
            .map_err(|_| error("Fly guest returned invalid operation output"))?;
        Ok(BashOutput {
            exit_code: result["exit_code"]
                .as_i64()
                .ok_or_else(|| error("Missing operation status"))? as i32,
            stdout: field_allow_empty(&result, "stdout")?,
            stderr: field_allow_empty(&result, "stderr")?,
        })
    }
    async fn success(&self, operation: Value) -> Result<String, SandboxClientError> {
        let result = self.run(operation).await?;
        if result.exit_code != 0 {
            return Err(error(
                "Fly workspace operation failed or exceeded its limit",
            ));
        }
        Ok(result.stdout)
    }
}
fn field_allow_empty(v: &Value, key: &str) -> Result<String, SandboxClientError> {
    v[key]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| error("Invalid Fly operation output"))
}
async fn stop(api: &Api, lease: &Lease) -> Result<(), SandboxClientError> {
    api.call(
        Method::POST,
        &format!("/machines/{}/stop", lease.id),
        Some(json!({"signal":"SIGKILL","timeout":"1s"})),
        None,
    )
    .await?;
    api.call(
        Method::GET,
        &format!("/machines/{}/wait?state=stopped&timeout=30", lease.id),
        None,
        None,
    )
    .await?;
    Ok(())
}
async fn finish(api: &Api, lease: &Lease) -> Result<(), SandboxClientError> {
    // Extend the owned fence beyond the two bounded stop/wait requests so a
    // delayed stop cannot land after a new runner has acquired this workspace.
    let current = api
        .call(
            Method::POST,
            &format!("/machines/{}/lease", lease.lock_id),
            Some(json!({"ttl":180})),
            Some(&lease.nonce),
        )
        .await?;
    if current["data"]["nonce"].as_str() != Some(&lease.nonce) {
        return Err(error(
            "Fly workspace lease expired; refusing to stop a subsequent execution",
        ));
    }
    stop(api, lease).await?;
    api.call(
        Method::DELETE,
        &format!("/machines/{}/lease", lease.lock_id),
        None,
        Some(&lease.nonce),
    )
    .await?;
    Ok(())
}

#[async_trait]
impl SandboxBackend for FlySandboxBackend {
    fn resolve_path(&self, path: &str) -> Result<PathBuf, SandboxClientError> {
        path_in_workspace(path)
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
        let text = self
            .success(json!({"kind":"read_bytes","path":path,"max_bytes":max_bytes.min(MAX_BYTES)}))
            .await?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(|_| error("Fly returned invalid file bytes"))?;
        if bytes.len() > max_bytes.min(MAX_BYTES) {
            return Err(error("Fly file exceeds read limit"));
        }
        Ok(bytes)
    }
    async fn write_text(&self, path: &str, content: &str) -> Result<(), SandboxClientError> {
        self.resolve_path(path)?;
        if content.len() > MAX_BYTES {
            return Err(error("Fly file exceeds write limit"));
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
    async fn renew_lease(&self) -> Result<(), SandboxClientError> {
        let current = self.lease.lock().await.clone();
        if let Some(lease) = current {
            let result = self
                .api
                .call(
                    Method::POST,
                    &format!("/machines/{}/lease", lease.lock_id),
                    Some(json!({"ttl":60})),
                    Some(&lease.nonce),
                )
                .await?;
            if result["data"]["nonce"].as_str() != Some(&lease.nonce) {
                return Err(error("Fly workspace lease changed during execution"));
            }
        }
        Ok(())
    }
    async fn shutdown(&self) -> Result<(), SandboxClientError> {
        let _operation = self.operation.lock().await;
        let mut current = self.lease.lock().await;
        if let Some(lease) = current.as_ref() {
            finish(&self.api, lease).await?;
        }
        *current = None;
        Ok(())
    }
}
impl Drop for FlySandboxBackend {
    fn drop(&mut self) {
        // Async cancellation drops the in-flight HTTP operation. Stop the VM
        // with its lease nonce as a backstop; normal completion awaits shutdown.
        if let Some(lease) = self.lease.get_mut().take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let api = self.api.clone();
                runtime.spawn(async move {
                    let _ = finish(&api, &lease).await;
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> FlySandboxConfig {
        FlySandboxConfig {
            app: "sandbox-test".into(),
            region: "sjc".into(),
            image: format!("python@sha256:{}", "a".repeat(64)),
            token: "test-only".into(),
            max_workspaces: 2,
        }
    }
    #[test]
    fn rejects_paths_and_preserves_case_in_workspace_identity() {
        for path in ["../other", "/etc/passwd", "a/../../other"] {
            assert!(path_in_workspace(path).is_err());
        }
        assert_ne!(
            workspace_key("Account-A").unwrap(),
            workspace_key("account-a").unwrap()
        );
        assert_ne!(
            workspace_key(&format!("{}a", "x".repeat(120))).unwrap(),
            workspace_key(&format!("{}b", "x".repeat(120))).unwrap()
        );
    }
    #[test]
    fn requires_pinned_image_and_no_public_services_or_credentials() {
        let mut c = config();
        c.image = "python:latest".into();
        assert!(c.validate().is_err());
        let backend = FlySandboxBackend::new(config(), "fixture-workspace").unwrap();
        let spec = backend.machine_config("fixture-volume");
        assert_eq!(spec["services"], json!([]));
        assert_eq!(spec["env"], json!({}));
        assert!(!spec.to_string().contains("test-only"));
        assert_eq!(spec["restart"]["policy"], "no");
        let mut machine = json!({"region":"sjc","config":spec});
        assert!(backend.validate_machine(&machine).is_ok());
        machine["config"]["metadata"]["kordi_workspace"] = json!("other");
        assert!(backend.validate_machine(&machine).is_err());
    }
}
