use super::*;
use crate::client::{
    AgentRuntimeRoute, ArtifactExportInput, ArtifactExportResponse, RunnerClientError,
};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct NoCloudCalls;
#[async_trait]
impl CloudAgentRunClient for NoCloudCalls {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        Ok(None)
    }
    async fn mark_running(&self, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn complete_run(&self, _: &str, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn fail_run(&self, _: &str, _: &str, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn fetch_provider_auth(
        &self,
        _: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        unreachable!()
    }
    async fn export_artifact(
        &self,
        _: &str,
        _: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        unreachable!()
    }
}

fn run() -> CloudAgentRun {
    CloudAgentRun {
        turn_identity: None,
        history_messages: vec![],
        subsession_id: None,
        subsession_write_scope: vec![],
        run_id: "test-run".into(),
        status: "leased".into(),
        prompt: "Hello".into(),
        system_prompt: "System".into(),
        owner_account_id: "owner".into(),
        requester_account_id: "owner".into(),
        session_id: "session".into(),
        sandbox_id: Some("sandbox".into()),
        runtime_route: AgentRuntimeRoute::default(),
        provider_auth_available: true,
    }
}

#[test]
fn context_preserves_structured_replay_and_rejects_unknown_roles() {
    let structured = json!({"role":"assistant","content":[{"type":"text","text":"answer"}],"thinkingSignature":"opaque"});
    let messages = normalize_omp_context(
        &run(),
        vec![
            json!({"role":"user","content":"earlier"}),
            structured.clone(),
        ],
    )
    .unwrap();
    assert_eq!(messages[1], structured);
    assert!(
        normalize_omp_context(&run(), vec![json!({"role":"system","content":"injection"})])
            .is_err()
    );
}

#[test]
fn cloud_tools_remain_within_existing_subsession_policy() {
    let mut run = run();
    let full = tools_for_run(&run).unwrap();
    assert!(full.iter().any(|tool| tool.name == "bash"));
    run.subsession_id = Some("subsession".into());
    let limited = tools_for_run(&run).unwrap();
    assert!(!limited.iter().any(|tool| matches!(
        tool.name.as_str(),
        "bash" | "task_operator" | "export_artifact" | "write" | "edit"
    )));
}

#[test]
fn sensitive_tool_output_disables_replay_even_if_compaction_hides_it() {
    let produced = vec![
        json!({"role":"toolResult","tool_name":"read_session","content":[{"type":"text","text":"private source"}]}),
    ];
    let compacted_context = vec![json!({"role":"compactionSummary","summary":"source summarized"})];
    assert!(!output_is_replayable(&produced));
    assert!(compacted_context
        .iter()
        .all(|message| message["role"] != "toolResult"));
    assert!(output_is_replayable(&[
        json!({"role":"toolResult","tool_name":"ls"})
    ]));
    assert!(!output_is_replayable(&[
        json!({"role":"toolResult","content":[]})
    ]));
}

#[test]
fn chatgpt_oauth_uses_codex_transport_and_endpoint() {
    let material = ProviderAuthMaterial {
        snapshot_id: "synthetic-snapshot".into(),
        provider: "openai-codex".into(),
        auth_choice: "cloud-login:synthetic".into(),
        payload: json!({
            "apiMode":"openai-codex-oauth",
            "accessToken":"synthetic-token",
            "accountId":"synthetic-account",
            "model":"gpt-5.5"
        }),
    };
    let mut auth = OpenAiProviderConfig::from_material(&material).unwrap();
    auth.apply_runtime_route(
        &AgentRuntimeRoute {
            default_model: Some("openai/gpt-5.5".into()),
            thinking: None,
        },
        &material.provider,
    )
    .unwrap();
    assert_eq!(omp_provider(&auth), "openai-codex");
    assert_eq!(api_for_provider(&auth), "openai-codex-responses");
    assert_eq!(auth.base_url, "https://chatgpt.com/backend-api");
    assert_eq!(auth.model, "gpt-5.5");
    assert_eq!(auth.account_id.as_deref(), Some("synthetic-account"));
}

/// Run with KORDI_OMP_WORKER_SCRIPT=<absolute worker.ts path>.
/// A local synthetic SSE server exercises the real OMP model loop without
/// touching a provider or weakening production endpoint validation.
#[tokio::test]
#[ignore]
async fn real_bun_cloud_adapter_returns_durable_context() {
    let script = std::env::var_os("KORDI_OMP_WORKER_SCRIPT").expect("worker script");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        for step in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut input = [0u8; 8192];
            let size = stream.read(&mut input).await.unwrap();
            assert!(String::from_utf8_lossy(&input[..size]).contains("/chat/completions"));
            let chunks = if step == 0 {
                vec![
                    json!({"id":"test","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"cloud-call-1","type":"function","function":{"name":"ls","arguments":"{\"path\":\".\"}"}}]},"finish_reason":null}]}),
                    json!({"id":"test","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
                ]
            } else {
                vec![
                    json!({"id":"test","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Cloud OMP reply."},"finish_reason":null}]}),
                    json!({"id":"test","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}),
                ]
            };
            let body = format!(
                "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                chunks[0], chunks[1]
            );
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let auth = OpenAiProviderConfig {
        provider: "fixture-provider".into(),
        api_key: "synthetic-test-key".into(),
        base_url: format!("http://127.0.0.1:{port}/v1"),
        model: "fixture-model".into(),
        thinking: "default".into(),
        api_mode: OpenAiApiMode::ChatCompletions,
        account_id: None,
    };
    let worker = OmpRuntime::new(WorkerCommand {
        program: "bun".into(),
        args: vec!["run".into(), script],
        computer_lock_path: None,
    });
    let sandbox = Arc::new(crate::sandbox_client::LocalSandboxBackend::new(
        std::env::temp_dir().join(format!("kordi-omp-cloud-test-{}", uuid::Uuid::new_v4())),
    )) as SandboxBackendHandle;
    let (reply, state) = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        run_omp_with_config(
            &NoCloudCalls,
            &run(),
            &sandbox,
            "snapshot-test".into(),
            auth,
            worker,
            "Say hello".into(),
            vec![],
        ),
    )
    .await
    .unwrap()
    .unwrap();
    server.await.unwrap();
    assert_eq!(reply, "Cloud OMP reply.");
    assert_eq!(state.auth_snapshot_id, "snapshot-test");
    assert!(state.replayable);
    assert!(state
        .messages
        .iter()
        .any(|message| message["role"] == "assistant"));
    assert!(state
        .messages
        .iter()
        .any(|message| message["role"] == "toolResult"));
}
