use async_trait::async_trait;
use kordi_cloud_agent_runner::artifacts::export_sandbox_file;
use kordi_cloud_agent_runner::client::{
    ArtifactExportInput, ArtifactExportResponse, CloudAgentRun, CloudAgentRunClient,
    ProviderAuthMaterial, RunnerClientError,
};
use kordi_cloud_agent_runner::sandbox_client::LocalSandboxBackend;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
struct RecordingClient {
    exports: Arc<Mutex<Vec<ArtifactExportInput>>>,
}

#[async_trait]
impl CloudAgentRunClient for RecordingClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        Ok(None)
    }

    async fn mark_running(&self, _run_id: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }

    async fn complete_run(
        &self,
        _run_id: &str,
        _response_text: &str,
    ) -> Result<(), RunnerClientError> {
        Ok(())
    }

    async fn fail_run(
        &self,
        _run_id: &str,
        _error_code: &str,
        _message: &str,
    ) -> Result<(), RunnerClientError> {
        Ok(())
    }

    async fn fetch_provider_auth(
        &self,
        _run_id: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        Ok(ProviderAuthMaterial {
            snapshot_id: "snap_test".to_string(),
            provider: "openai".to_string(),
            auth_choice: "default".to_string(),
            payload: serde_json::json!({
                "apiKey": "test-key",
                "baseUrl": "https://api.openai.com/v1",
                "model": "gpt-4.1-mini"
            }),
        })
    }

    async fn export_artifact(
        &self,
        run_id: &str,
        input: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        self.exports.lock().unwrap().push(input.clone());
        Ok(ArtifactExportResponse {
            artifact_id: "carartifact_test".to_string(),
            attachment_id: "att_test".to_string(),
            run_id: run_id.to_string(),
            message_id: "cloudrunmsg_test".to_string(),
            name: input.name,
            sandbox_path: input.sandbox_path,
            content_type: input.content_type,
            size_bytes: 6,
            sha256_hex: Some(input.sha256_hex),
            created_at: "2026-05-24T00:00:00Z".to_string(),
        })
    }
}

#[tokio::test]
async fn export_sandbox_file_reads_bytes_and_posts_explicit_export() {
    let root = std::env::temp_dir().join(format!(
        "kordi-artifact-export-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let sandbox = Arc::new(LocalSandboxBackend::new(root.clone()));
    sandbox.write_text("report.md", "report").await.unwrap();
    let client = RecordingClient::default();

    let backend: kordi_cloud_agent_runner::sandbox_client::SandboxBackendHandle = sandbox.clone();
    let exported = export_sandbox_file(
        &client,
        &backend,
        "car_run",
        "report.md",
        "report.md",
        "text/markdown",
    )
    .await
    .unwrap();

    assert_eq!(exported.attachment_id, "att_test");
    let calls = client.exports.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].sandbox_path, "report.md");
    assert_eq!(calls[0].name, "report.md");
    assert_eq!(calls[0].content_type, "text/markdown");
    assert!(!calls[0].bytes_base64.is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn export_sandbox_file_blocks_paths_outside_sandbox_before_http() {
    let root = std::env::temp_dir().join(format!(
        "kordi-artifact-export-block-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let sandbox = Arc::new(LocalSandboxBackend::new(root.clone()));
    let client = RecordingClient::default();

    let backend: kordi_cloud_agent_runner::sandbox_client::SandboxBackendHandle = sandbox.clone();
    let result = export_sandbox_file(
        &client,
        &backend,
        "car_run",
        "../secret.md",
        "secret.md",
        "text/markdown",
    )
    .await;

    assert!(result.is_err());
    assert!(client.exports.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(root);
}
