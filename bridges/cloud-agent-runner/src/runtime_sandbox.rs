use crate::client::CloudAgentRun;
use crate::k8s_sandbox::K8sSandboxBackend;
use crate::sandbox_client::{LocalSandboxBackend, SandboxBackendHandle};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxBackendMode {
    Local,
    K8s,
    Fly,
    Invalid,
}

pub fn sandbox_backend_mode_from_env() -> SandboxBackendMode {
    match std::env::var("KORDI_CLOUD_SANDBOX_BACKEND") {
        Ok(value) if value.trim().eq_ignore_ascii_case("k8s") => SandboxBackendMode::K8s,
        Ok(value) if value.trim().eq_ignore_ascii_case("fly") => SandboxBackendMode::Fly,
        Ok(value) if !value.trim().is_empty() && !value.trim().eq_ignore_ascii_case("local") => {
            SandboxBackendMode::Invalid
        }
        _ => SandboxBackendMode::Local,
    }
}

pub fn sandbox_backend_for_run(
    run: &CloudAgentRun,
    local_root: PathBuf,
) -> Result<SandboxBackendHandle, &'static str> {
    match sandbox_backend_mode_from_env() {
        SandboxBackendMode::Invalid => Err("invalid_sandbox_backend"),
        SandboxBackendMode::Fly => {
            let sandbox_id = run.sandbox_id.as_deref().ok_or("missing_sandbox")?;
            crate::fly_sandbox::FlySandboxBackend::from_env(sandbox_id)
                .map(|backend| std::sync::Arc::new(backend) as SandboxBackendHandle)
                .map_err(|_| "invalid_fly_sandbox_configuration")
        }
        SandboxBackendMode::Local => {
            let id = run.sandbox_id.as_deref().unwrap_or(&run.run_id);
            if id.is_empty()
                || !id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
            {
                return Err("invalid_sandbox_id");
            }
            Ok(std::sync::Arc::new(LocalSandboxBackend::new(
                local_root.join(id),
            )))
        }
        SandboxBackendMode::K8s => {
            let sandbox_id = run.sandbox_id.as_deref().ok_or("missing_sandbox")?;
            Ok(std::sync::Arc::new(K8sSandboxBackend::from_env(
                sandbox_id.to_string(),
            )))
        }
    }
}
