use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kordi_cloud_agent_runner::client::{
    ArtifactExportInput, ArtifactExportResponse, CloudAgentRun, CloudAgentRunClient,
    ProviderAuthMaterial, RunnerClientError,
};
use kordi_cloud_agent_runner::model_loop::{
    run_model_loop, CloudModelProvider, ModelProviderResponse, ModelToolCall, OpenAiProviderConfig,
};
use kordi_cloud_agent_runner::sandbox_client::{LocalSandboxBackend, SandboxBackendHandle};
use serde_json::{json, Value};

#[derive(Default)]
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
        Ok(provider_auth())
    }

    async fn export_artifact(
        &self,
        run_id: &str,
        input: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        self.exports.lock().unwrap().push(input.clone());
        Ok(ArtifactExportResponse {
            artifact_id: "artifact_1".to_string(),
            attachment_id: "attach_1".to_string(),
            run_id: run_id.to_string(),
            message_id: "cloudrunmsg_1".to_string(),
            name: input.name,
            sandbox_path: input.sandbox_path,
            content_type: input.content_type,
            size_bytes: 11,
            sha256_hex: Some(input.sha256_hex),
            created_at: "2026-05-24T00:00:00Z".to_string(),
        })
    }
}

struct FakeProvider {
    responses: Mutex<Vec<ModelProviderResponse>>,
    seen_messages: Mutex<Vec<Vec<Value>>>,
}

impl FakeProvider {
    fn new(responses: Vec<ModelProviderResponse>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().rev().collect()),
            seen_messages: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl CloudModelProvider for FakeProvider {
    async fn next_response(
        &self,
        _auth: &OpenAiProviderConfig,
        messages: &[Value],
        _tools: &[Value],
    ) -> Result<ModelProviderResponse, kordi_cloud_agent_runner::model_loop::ModelLoopError> {
        self.seen_messages.lock().unwrap().push(messages.to_vec());
        self.responses.lock().unwrap().pop().ok_or_else(|| {
            kordi_cloud_agent_runner::model_loop::ModelLoopError::Provider(
                "empty fake response queue".to_string(),
            )
        })
    }
}

fn provider_auth() -> ProviderAuthMaterial {
    ProviderAuthMaterial {
        snapshot_id: "snap_test".to_string(),
        provider: "openai".to_string(),
        auth_choice: "default".to_string(),
        payload: json!({
            "apiKey": "test-key",
            "baseUrl": "https://api.openai.com/v1",
            "model": "gpt-4.1-mini"
        }),
    }
}

fn run() -> CloudAgentRun {
    CloudAgentRun {
        run_id: "run_test".to_string(),
        status: "running".to_string(),
        prompt: "Write a tiny status file".to_string(),
        owner_account_id: "acct_owner".to_string(),
        requester_account_id: "acct_requester".to_string(),
        session_id: "session:direct-person:requester:owner".to_string(),
        sandbox_id: Some("sandbox_test".to_string()),
        provider_auth_available: true,
    }
}

fn sandbox() -> Arc<LocalSandboxBackend> {
    let root = std::env::temp_dir().join(format!(
        "kordi-model-loop-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).unwrap();
    Arc::new(LocalSandboxBackend::new(root))
}

fn sandbox_handle() -> SandboxBackendHandle {
    sandbox()
}

#[tokio::test]
async fn model_loop_completes_text_response() {
    let client = RecordingClient::default();
    let provider = FakeProvider::new(vec![ModelProviderResponse::FinalText(
        "Cloud fallback answer".to_string(),
    )]);

    let text = run_model_loop(
        &client,
        &provider,
        &run(),
        &sandbox_handle(),
        provider_auth(),
    )
    .await
    .unwrap();

    assert_eq!(text, "Cloud fallback answer");
    let first_messages = provider.seen_messages.lock().unwrap().remove(0);
    assert!(first_messages[0]["content"]
        .as_str()
        .unwrap()
        .contains("owner device is offline"));
    assert!(first_messages[0]["content"]
        .as_str()
        .unwrap()
        .contains("owner laptop files"));
}

#[tokio::test]
async fn model_loop_executes_sandbox_tool_call_then_finishes() {
    let client = RecordingClient::default();
    let sandbox = sandbox();
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_write".to_string(),
            name: "write".to_string(),
            arguments: json!({"path":"status.txt","content":"done"}),
        }]),
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_read".to_string(),
            name: "read".to_string(),
            arguments: json!({"path":"status.txt"}),
        }]),
        ModelProviderResponse::FinalText("Wrote and read status.txt".to_string()),
    ]);

    let backend: SandboxBackendHandle = sandbox.clone();
    let text = run_model_loop(&client, &provider, &run(), &backend, provider_auth())
        .await
        .unwrap();

    assert_eq!(text, "Wrote and read status.txt");
    assert_eq!(
        tokio::fs::read_to_string(sandbox.root().join("status.txt"))
            .await
            .unwrap(),
        "done"
    );
    let calls = provider.seen_messages.lock().unwrap();
    let final_context = calls.last().unwrap();
    assert!(final_context
        .iter()
        .any(|message| message["role"] == "tool" && message["content"] == "done"));
}

#[tokio::test]
async fn model_loop_returns_boundary_explanation_for_owner_local_tool() {
    let client = RecordingClient::default();
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_private".to_string(),
            name: "read".to_string(),
            arguments: json!({"path":"/Users/owner/private.txt"}),
        }]),
        ModelProviderResponse::FinalText(
            "I cannot read owner-local files from Cloud fallback.".to_string(),
        ),
    ]);

    let text = run_model_loop(
        &client,
        &provider,
        &run(),
        &sandbox_handle(),
        provider_auth(),
    )
    .await
    .unwrap();

    assert!(text.contains("cannot read owner-local files"));
    let calls = provider.seen_messages.lock().unwrap();
    let final_context = calls.last().unwrap();
    assert!(final_context.iter().any(|message| {
        message["role"] == "tool"
            && message["content"]
                .as_str()
                .unwrap()
                .contains("Cloud fallback")
            && !message["content"].as_str().unwrap().contains("approval")
    }));
}

#[tokio::test]
async fn model_loop_allows_short_research_tasks_to_make_several_tool_calls_then_finish() {
    let client = RecordingClient::default();
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_1".to_string(),
            name: "bash".to_string(),
            arguments: json!({"command":"printf one"}),
        }]),
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_2".to_string(),
            name: "bash".to_string(),
            arguments: json!({"command":"printf two"}),
        }]),
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_3".to_string(),
            name: "bash".to_string(),
            arguments: json!({"command":"printf three"}),
        }]),
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_4".to_string(),
            name: "bash".to_string(),
            arguments: json!({"command":"printf four"}),
        }]),
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_5".to_string(),
            name: "bash".to_string(),
            arguments: json!({"command":"printf five"}),
        }]),
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_6".to_string(),
            name: "bash".to_string(),
            arguments: json!({"command":"printf six"}),
        }]),
        ModelProviderResponse::FinalText("Research summary complete".to_string()),
    ]);

    let text = run_model_loop(
        &client,
        &provider,
        &run(),
        &sandbox_handle(),
        provider_auth(),
    )
    .await
    .unwrap();

    assert_eq!(text, "Research summary complete");
}

#[tokio::test]
async fn model_loop_exports_artifact_when_requested() {
    let client = RecordingClient::default();
    let sandbox = sandbox();
    tokio::fs::write(sandbox.root().join("report.md"), "# Report\nOK\n")
        .await
        .unwrap();
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_export".to_string(),
            name: "export_artifact".to_string(),
            arguments: json!({
                "path":"report.md",
                "name":"report.md",
                "contentType":"text/markdown"
            }),
        }]),
        ModelProviderResponse::FinalText("Exported report.md".to_string()),
    ]);

    let backend: SandboxBackendHandle = sandbox.clone();
    let text = run_model_loop(&client, &provider, &run(), &backend, provider_auth())
        .await
        .unwrap();

    assert_eq!(text, "Exported report.md");
    let exports = client.exports.lock().unwrap();
    assert_eq!(exports.len(), 1);
    assert_eq!(exports[0].name, "report.md");
    assert_eq!(exports[0].sandbox_path, "report.md");
}
