use std::path::PathBuf;

use crate::client::CloudAgentRun;
use crate::config::SandboxBackendMode;
use crate::k8s_sandbox::K8sSandboxBackend;
use crate::sandbox_client::{LocalSandboxBackend, SandboxBackendHandle};

pub(crate) fn sandbox_backend_for_run(
    run: &CloudAgentRun,
    local_root: PathBuf,
    mode: SandboxBackendMode,
) -> Result<SandboxBackendHandle, &'static str> {
    match mode {
        SandboxBackendMode::Local => Ok(std::sync::Arc::new(LocalSandboxBackend::new(local_root))),
        SandboxBackendMode::K8s => {
            let sandbox_id = run.sandbox_id.as_deref().ok_or("missing_sandbox")?;
            Ok(std::sync::Arc::new(K8sSandboxBackend::from_env(
                sandbox_id.to_string(),
            )))
        }
    }
}
