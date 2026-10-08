use super::*;
use crate::client::AgentRuntimeRoute;
use kordi_omp_runtime::{RuntimeEvent, ToolCall, ToolResult};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Probe(Mutex<Vec<String>>);
#[async_trait::async_trait]
impl HostTool for Probe {
    async fn execute(&self, call: ToolCall, _: CancellationToken) -> ToolResult {
        self.0.lock().unwrap().push(call.name.clone());
        tool_result(json!({"success":true,"callId":call.call_id}))
    }
}

fn run_fixture() -> CloudAgentRun {
    CloudAgentRun {
        turn_identity: None,
        history_messages: vec![],
        subsession_id: None,
        subsession_write_scope: vec![],
        run_id: "synthetic-job".into(),
        status: "leased".into(),
        prompt: "Synthetic snapshot".into(),
        system_prompt: "System".into(),
        owner_account_id: "owner".into(),
        requester_account_id: "owner".into(),
        session_id: "session".into(),
        sandbox_id: None,
        runtime_route: AgentRuntimeRoute::default(),
        provider_auth_available: true,
        connectors: Default::default(),
    }
}

#[test]
fn sandbox_free_jobs_keep_exact_tool_catalog_and_route() {
    let run = run_fixture();
    let auth = auth_fixture("https://example.com/v1".into());
    for tools in [crate::pip::tools(), crate::digest::tools()] {
        let expected = tools
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        let request = Job {
            run: &run,
            auth: &auth,
            prompt: "snapshot".into(),
            messages: vec![],
            resume: false,
            tools: tools.clone(),
            timeout_ms: 20_000,
            max_steps: 8,
            max_tool_calls: 12,
        }
        .request()
        .unwrap();
        assert_eq!(
            request
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(request.model.id, "fixture-model");
        assert!(request.hooks.is_empty());
        assert!(matches!(request.auth.kind, AuthKind::ApiKey));
        assert!(!request.capabilities.owner_local);
        assert!(!request.capabilities.computer);
        assert!(!request.capabilities.browser);
    }
}

fn auth_fixture(base_url: String) -> OpenAiProviderConfig {
    OpenAiProviderConfig {
        provider: "fixture-provider".into(),
        api_key: "synthetic-key".into(),
        base_url,
        model: "fixture-model".into(),
        thinking: "default".into(),
        api_mode: OpenAiApiMode::ChatCompletions,
        account_id: None,
    }
}

/// Uses the actual packaged worker, synthetic SSE, and no external account.
#[tokio::test]
#[ignore = "requires KORDI_OMP_WORKER_ENTRY pointing to the compiled worker"]
async fn packaged_worker_runs_scoped_pip_and_digest_tools() {
    let worker = worker_command().unwrap();
    for tools in [crate::pip::tools(), crate::digest::tools()] {
        let tool_name = tools[0]["function"]["name"].as_str().unwrap().to_string();
        let catalog = tools
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(vec![]));
        let recorded = requests.clone();
        let requested_tool = tool_name.clone();
        let server = tokio::spawn(async move {
            for step in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut input = vec![];
                loop {
                    let mut chunk = [0u8; 8192];
                    let length = stream.read(&mut chunk).await.unwrap();
                    assert!(length > 0);
                    input.extend_from_slice(&chunk[..length]);
                    if let Some(end) = input.windows(4).position(|window| window == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&input[..end]);
                        let size = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|size| size.trim().parse::<usize>().ok())
                            })
                            .unwrap();
                        if input.len() >= end + 4 + size {
                            recorded.lock().unwrap().push(
                                serde_json::from_slice::<Value>(&input[end + 4..end + 4 + size])
                                    .unwrap(),
                            );
                            break;
                        }
                    }
                }
                let delta = if step == 0 {
                    json!({"role":"assistant","tool_calls":[{"index":0,"id":"job-call","type":"function","function":{"name":requested_tool,"arguments":if requested_tool == "plan_card" {r#"{"action":"rsvp","eventId":"synthetic-plan"}"#} else {"{}"}}}]})
                } else {
                    json!({"role":"assistant","content":"Job complete"})
                };
                let body = format!(
                    "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                    json!({"id":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
                    json!({"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":if step == 0 {"tool_calls"} else {"stop"}}]})
                );
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let run = run_fixture();
        let auth = auth_fixture(format!("http://127.0.0.1:{port}/v1"));
        let host = Probe(Mutex::new(vec![]));
        let journal = Mutex::new(vec![]);
        let events = |event: RuntimeEvent| {
            if event.kind == "message_end" {
                journal.lock().unwrap().push(event.data["message"].clone());
            }
            async { Ok(()) }
        };
        let result = run_with_worker(
            Job {
                run: &run,
                auth: &auth,
                prompt: "snapshot".into(),
                messages: vec![],
                resume: false,
                tools,
                timeout_ms: 20_000,
                max_steps: 8,
                max_tool_calls: 12,
            },
            &host,
            &events,
            worker.clone(),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(result.text, "Job complete");
        assert_eq!(*host.0.lock().unwrap(), [tool_name]);
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests[0]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
                .collect::<Vec<_>>(),
            catalog
        );
        assert!(requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "tool" && message["tool_call_id"] == "job-call"));
        assert!(journal
            .lock()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "toolResult"));
    }
}
