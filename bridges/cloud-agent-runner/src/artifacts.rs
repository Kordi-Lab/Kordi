use base64::Engine;
use sha2::{Digest, Sha256};

use crate::client::{
    ArtifactExportInput, ArtifactExportResponse, CloudAgentRunClient, RunnerClientError,
};
use crate::sandbox_client::{SandboxBackendHandle, SandboxClientError};

#[derive(Debug, thiserror::Error)]
pub enum ArtifactExportError {
    #[error(transparent)]
    Sandbox(#[from] SandboxClientError),
    #[error(transparent)]
    Client(#[from] RunnerClientError),
}

pub async fn export_sandbox_file<C: CloudAgentRunClient + Sync>(
    client: &C,
    sandbox: &SandboxBackendHandle,
    run_id: &str,
    sandbox_path: &str,
    name: &str,
    content_type: &str,
) -> Result<ArtifactExportResponse, ArtifactExportError> {
    let bytes = sandbox.read_bytes(sandbox_path).await?;
    let sha256_hex = format!("{:x}", Sha256::digest(&bytes));
    let bytes_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let input = ArtifactExportInput {
        runner_id: String::new(),
        name: name.to_string(),
        sandbox_path: sandbox_path.to_string(),
        content_type: content_type.to_string(),
        sha256_hex,
        bytes_base64,
    };
    Ok(client.export_artifact(run_id, input).await?)
}
