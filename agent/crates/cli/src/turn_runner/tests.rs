use crate::extensions::ExtensionCommandRegistry;
use crate::tool_registry::ToolRegistry;
use crate::turn_runner::{TurnConfig, TurnEvent, run_turn, wrap_conn};
use async_trait::async_trait;
use chrono::Utc;
use kordi_core::error::KordiResult;
use kordi_core::types::{
    AgentMessage, AssistantContent, AssistantMessage, CacheMetricsSource, ContentBlock, EntryBase,
    SessionEntry, StopReason, Usage, UserMessage,
};
use kordi_monitor::RequestMetricsTracker;
use kordi_provider::{CompletionRequest, Provider, RequestOptions, StreamEvent, UsageInfo};
use kordi_session::store;
use kordi_tools::{Tool, ToolResult, ToolScheduling};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, mpsc};
use tokio::time::{Duration, timeout};
use tokio_util::sync::CancellationToken;

struct CaptureRequestProvider {
    captured: Arc<Mutex<Vec<CompletionRequest>>>,
}

#[async_trait]
impl Provider for CaptureRequestProvider {
    fn name(&self) -> &str {
        "capture-request"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(Vec::new())
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        _options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        self.captured
            .lock()
            .expect("captured requests lock")
            .push(request);
        let _ = tx.send(StreamEvent::TextDelta {
            text: "captured".to_string(),
        });
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

struct DummyProvider {
    call_count: AtomicUsize,
}

#[async_trait]
impl Provider for DummyProvider {
    fn name(&self) -> &str {
        "dummy"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(Vec::new())
    }

    async fn stream(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let call_index = self.call_count.fetch_add(1, Ordering::SeqCst);
        if call_index == 0 {
            let _ = tx.send(StreamEvent::ToolCallStart {
                id: "tool-1".to_string(),
                name: "panic-tool".to_string(),
            });
            let _ = tx.send(StreamEvent::ToolCallDelta {
                id: "tool-1".to_string(),
                arguments_delta: "{}".to_string(),
            });
        } else {
            let _ = tx.send(StreamEvent::TextDelta {
                text: "done".to_string(),
            });
        }
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

struct StreamErrorThenSuccessProvider {
    call_count: AtomicUsize,
}

#[async_trait]
impl Provider for StreamErrorThenSuccessProvider {
    fn name(&self) -> &str {
        "stream-error-then-success"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(Vec::new())
    }

    async fn stream(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let call_index = self.call_count.fetch_add(1, Ordering::SeqCst);
        if call_index == 0 {
            let _ = tx.send(StreamEvent::Error {
                message: "Provider error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 61a29dd6-0976-43b0-968b-4daa23917199 in your message.".to_string(),
            });
        } else {
            let _ = tx.send(StreamEvent::TextDelta {
                text: "recovered".to_string(),
            });
        }
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

struct CancelAfterToolCallProvider;

#[async_trait]
impl Provider for CancelAfterToolCallProvider {
    fn name(&self) -> &str {
        "cancel-after-tool-call"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(Vec::new())
    }

    async fn stream(
        &self,
        _request: CompletionRequest,
        options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let _ = tx.send(StreamEvent::ToolCallStart {
            id: "tool-cancel-1".to_string(),
            name: "panic-tool".to_string(),
        });
        let _ = tx.send(StreamEvent::ToolCallDelta {
            id: "tool-cancel-1".to_string(),
            arguments_delta: "{}".to_string(),
        });
        options.cancel.cancel();
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

struct AliasProvider {
    call_count: AtomicUsize,
}

#[async_trait]
impl Provider for AliasProvider {
    fn name(&self) -> &str {
        "alias-provider"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(Vec::new())
    }

    async fn stream(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let call_index = self.call_count.fetch_add(1, Ordering::SeqCst);
        if call_index == 0 {
            let _ = tx.send(StreamEvent::ToolCallStart {
                id: "tool-alias-1".to_string(),
                name: "functions.Bash".to_string(),
            });
            let _ = tx.send(StreamEvent::ToolCallDelta {
                id: "tool-alias-1".to_string(),
                arguments_delta: r#"{"command":"pwd"}"#.to_string(),
            });
        } else {
            let _ = tx.send(StreamEvent::TextDelta {
                text: "done".to_string(),
            });
        }
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

struct EchoTool {
    invocations: Arc<std::sync::atomic::AtomicUsize>,
}

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "bash"
    }

    fn description(&self) -> &str {
        "records normalized bash invocations"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string"}
            },
            "required": ["command"]
        })
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &kordi_tools::ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        self.invocations.fetch_add(1, Ordering::SeqCst);
        let command = params
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        Ok(ToolResult {
            content: vec![ContentBlock::Text {
                text: format!("echoed: {command}"),
            }],
            details: None,
            is_error: false,
            artifact_path: None,
        })
    }
}

struct OverflowProvider;

#[async_trait]
impl Provider for OverflowProvider {
    fn name(&self) -> &str {
        "overflow"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(vec![
            StreamEvent::TextDelta {
                text: "## Goal\nRecover overflow\n\n## Progress\n### Done\n- [x] summarized\n"
                    .to_string(),
            },
            StreamEvent::Done,
        ])
    }

    async fn stream(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let _ = tx.send(StreamEvent::Error {
            message: "HTTP 400: context_length_exceeded".to_string(),
        });
        Ok(())
    }
}

struct MetricsProvider;

struct PreemptiveCompactionProvider {
    complete_count: Arc<AtomicUsize>,
    stream_count: Arc<AtomicUsize>,
}

struct FailingCompactionProvider {
    complete_count: Arc<AtomicUsize>,
    stream_count: Arc<AtomicUsize>,
}

struct StalledLocalProvider {
    stream_count: Arc<AtomicUsize>,
}

struct ErrorAwareToolProvider {
    call_count: AtomicUsize,
}

#[async_trait]
impl Provider for MetricsProvider {
    fn name(&self) -> &str {
        "metrics-provider"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(Vec::new())
    }

    async fn stream(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let _ = tx.send(StreamEvent::Usage(UsageInfo {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 40,
            cache_write_tokens: 0,
            cache_metrics_source: CacheMetricsSource::Official,
        }));
        let _ = tx.send(StreamEvent::TextDelta {
            text: "done".to_string(),
        });
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

#[async_trait]
impl Provider for PreemptiveCompactionProvider {
    fn name(&self) -> &str {
        "preemptive-compaction-provider"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        self.complete_count.fetch_add(1, Ordering::SeqCst);
        Ok(vec![
            StreamEvent::TextDelta {
                text: "## Goal\nKeep going\n\n## Progress\n### Done\n- [x] compressed\n"
                    .to_string(),
            },
            StreamEvent::Done,
        ])
    }

    async fn stream(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        self.stream_count.fetch_add(1, Ordering::SeqCst);
        let _ = tx.send(StreamEvent::TextDelta {
            text: "answer after compression".to_string(),
        });
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

#[async_trait]
impl Provider for FailingCompactionProvider {
    fn name(&self) -> &str {
        "failing-compaction-provider"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        self.complete_count.fetch_add(1, Ordering::SeqCst);
        Err(kordi_core::error::KordiError::Provider(
            "summarizer unavailable".to_string(),
        ))
    }

    async fn stream(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        self.stream_count.fetch_add(1, Ordering::SeqCst);
        let _ = tx.send(StreamEvent::TextDelta {
            text: "should not send uncompressed".to_string(),
        });
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

#[async_trait]
impl Provider for StalledLocalProvider {
    fn name(&self) -> &str {
        "stalled-local-provider"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(Vec::new())
    }

    async fn stream(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
        _tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        self.stream_count.fetch_add(1, Ordering::SeqCst);
        std::future::pending::<()>().await;
        Ok(())
    }
}

#[async_trait]
impl Provider for ErrorAwareToolProvider {
    fn name(&self) -> &str {
        "error-aware-tool-provider"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(Vec::new())
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        _options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let call_index = self.call_count.fetch_add(1, Ordering::SeqCst);
        if call_index == 0 {
            let _ = tx.send(StreamEvent::ToolCallStart {
                id: "tool-timeout-1".to_string(),
                name: "failing-tool".to_string(),
            });
            let _ = tx.send(StreamEvent::ToolCallDelta {
                id: "tool-timeout-1".to_string(),
                arguments_delta: "{}".to_string(),
            });
            let _ = tx.send(StreamEvent::Done);
            return Ok(());
        }

        let saw_error_tool_result = request.messages.iter().any(|message| {
            message.get("role").and_then(|value| value.as_str()) == Some("tool")
                && message.get("tool_call_id").and_then(|value| value.as_str())
                    == Some("tool-timeout-1")
                && message.get("is_error").and_then(|value| value.as_bool()) == Some(true)
        });

        if saw_error_tool_result {
            let _ = tx.send(StreamEvent::TextDelta {
                text: "continued after timeout".to_string(),
            });
            let _ = tx.send(StreamEvent::Done);
            Ok(())
        } else {
            let _ = tx.send(StreamEvent::Error {
                message: "missing tool error flag".to_string(),
            });
            Ok(())
        }
    }
}

fn append_user_text(
    conn: &rusqlite::Connection,
    session_id: &str,
    id: &str,
    parent_id: Option<&str>,
    text: &str,
) {
    let entry = SessionEntry::Message {
        base: EntryBase {
            id: kordi_core::types::EntryId(id.to_string()),
            parent_id: parent_id.map(|value| kordi_core::types::EntryId(value.to_string())),
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: text.to_string(),
            }],
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(conn, session_id, &entry).expect("append user text");
}

#[tokio::test]
async fn run_turn_keeps_system_prompt_stable_and_inserts_bridge_context_before_current_user() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    append_user_text(
        &conn,
        &session_id,
        "old0001",
        None,
        "Alice: earlier shared message",
    );
    append_user_text(
        &conn,
        &session_id,
        "curr0002",
        Some("old0001"),
        "@Kordi ask @Bob's Kordi if the build is green",
    );

    let captured = Arc::new(Mutex::new(Vec::new()));
    let (event_tx, _event_rx) = mpsc::unbounded_channel();
    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "stable system prompt".to_string(),
        bridge_outreach_prompt_context: Some(
            "Bob's Kordi joined via @mention.\nSession identity file: /tmp/session-identity.md"
                .to_string(),
        ),
        model: test_model(128_000),
        provider: Arc::new(CaptureRequestProvider {
            captured: captured.clone(),
        }),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::from_tools(Vec::new()),
        tool_ctx: test_tool_context(),
        thinking: None,
        retry_enabled: false,
        retry_max_retries: 1,
        retry_base_delay_ms: 10,
        retry_max_delay_ms: 10,
        cancel: CancellationToken::new(),
        extensions: ExtensionCommandRegistry::default(),
        request_metrics_tracker: test_request_metrics_tracker(),
        request_metrics_log_path: None,
    };

    let (_returned_config, result) = run_turn(
        config,
        event_tx,
        "@Kordi ask @Bob's Kordi if the build is green".to_string(),
    )
    .await;
    result.expect("turn succeeds");

    let requests = captured.lock().expect("captured requests lock");
    let request = requests.first().expect("provider request captured");
    assert_eq!(request.system_prompt, "stable system prompt");
    assert!(!request.system_prompt.contains("Session identity file:"));
    assert!(!request.system_prompt.contains("Bob's Kordi joined"));

    let contents = request
        .messages
        .iter()
        .filter_map(|message| message.get("content").and_then(|value| value.as_str()))
        .collect::<Vec<_>>();
    let context_index = contents
        .iter()
        .position(|content| content.contains("Session identity file: /tmp/session-identity.md"))
        .expect("dynamic bridge/session context is a provider message");
    let current_index = contents
        .iter()
        .position(|content| content.contains("@Kordi ask @Bob's Kordi"))
        .expect("current user message is present");
    assert!(
        context_index < current_index,
        "dynamic context should precede the current user message\n{contents:#?}"
    );
}

struct PanicTool;

#[async_trait]
impl Tool for PanicTool {
    fn name(&self) -> &str {
        "panic-tool"
    }

    fn description(&self) -> &str {
        "panic test tool"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {},
        })
    }

    async fn execute(
        &self,
        _params: serde_json::Value,
        _ctx: &kordi_tools::ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        panic!("panic containment test marker");
    }
}

struct FailingTool;

#[async_trait]
impl Tool for FailingTool {
    fn name(&self) -> &str {
        "failing-tool"
    }

    fn description(&self) -> &str {
        "returns an errored tool result"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {},
        })
    }

    async fn execute(
        &self,
        _params: serde_json::Value,
        _ctx: &kordi_tools::ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        Ok(ToolResult {
            content: vec![ContentBlock::Text {
                text: "Error: command timed out".to_string(),
            }],
            details: Some(json!({
                "timedOut": true,
            })),
            is_error: true,
            artifact_path: None,
        })
    }
}

struct MultiToolProvider {
    tool_name: &'static str,
    first_args: &'static str,
    second_args: &'static str,
    call_count: AtomicUsize,
}

#[async_trait]
impl Provider for MultiToolProvider {
    fn name(&self) -> &str {
        "multi-tool"
    }

    async fn complete(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(Vec::new())
    }

    async fn stream(
        &self,
        _request: CompletionRequest,
        _options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let call_index = self.call_count.fetch_add(1, Ordering::SeqCst);
        if call_index == 0 {
            let _ = tx.send(StreamEvent::ToolCallStart {
                id: "tool-a".to_string(),
                name: self.tool_name.to_string(),
            });
            let _ = tx.send(StreamEvent::ToolCallDelta {
                id: "tool-a".to_string(),
                arguments_delta: self.first_args.to_string(),
            });
            let _ = tx.send(StreamEvent::ToolCallStart {
                id: "tool-b".to_string(),
                name: self.tool_name.to_string(),
            });
            let _ = tx.send(StreamEvent::ToolCallDelta {
                id: "tool-b".to_string(),
                arguments_delta: self.second_args.to_string(),
            });
        } else {
            let _ = tx.send(StreamEvent::TextDelta {
                text: "done".to_string(),
            });
        }
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

struct OverlapProbeTool {
    entered: Arc<AtomicUsize>,
    notify: Arc<Notify>,
}

#[async_trait]
impl Tool for OverlapProbeTool {
    fn name(&self) -> &str {
        "overlap-probe"
    }

    fn description(&self) -> &str {
        "verifies read-only tool calls can overlap"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({"type": "object"})
    }

    async fn execute(
        &self,
        _params: serde_json::Value,
        _ctx: &kordi_tools::ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let entered = self.entered.fetch_add(1, Ordering::SeqCst) + 1;
        if entered < 2 {
            timeout(Duration::from_millis(200), async {
                while self.entered.load(Ordering::SeqCst) < 2 {
                    self.notify.notified().await;
                }
            })
            .await
            .map_err(|_| {
                kordi_core::error::KordiError::Tool("tool calls did not overlap".into())
            })?;
        } else {
            self.notify.notify_waiters();
        }

        Ok(ToolResult {
            content: vec![ContentBlock::Text {
                text: "overlap ok".to_string(),
            }],
            details: None,
            is_error: false,
            artifact_path: None,
        })
    }
}

struct SameFileMutationProbeTool {
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
}

#[async_trait]
impl Tool for SameFileMutationProbeTool {
    fn name(&self) -> &str {
        "same-file-mutation-probe"
    }

    fn description(&self) -> &str {
        "verifies same-file mutation windows are serialized"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"}
            },
            "required": ["path"]
        })
    }

    fn scheduling(
        &self,
        params: &serde_json::Value,
        ctx: &kordi_tools::ToolContext,
    ) -> ToolScheduling {
        let path = params
            .get("path")
            .and_then(|value| value.as_str())
            .map(std::path::Path::new)
            .map(|path| {
                if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    ctx.cwd.join(path)
                }
            })
            .unwrap_or_else(|| ctx.cwd.join("unknown"));
        ToolScheduling::single_mutating_path(path)
    }

    async fn execute(
        &self,
        _params: serde_json::Value,
        _ctx: &kordi_tools::ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let current = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        let mut observed = self.max_active.load(Ordering::SeqCst);
        while current > observed {
            match self.max_active.compare_exchange(
                observed,
                current,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(next) => observed = next,
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        self.active.fetch_sub(1, Ordering::SeqCst);

        Ok(ToolResult {
            content: vec![ContentBlock::Text {
                text: "mutation ok".to_string(),
            }],
            details: None,
            is_error: false,
            artifact_path: None,
        })
    }
}

fn test_model(context_window: u64) -> kordi_provider::registry::Model {
    kordi_provider::registry::Model {
        id: "dummy-model".to_string(),
        name: "dummy-model".to_string(),
        provider: "dummy".to_string(),
        api: kordi_provider::registry::ApiType::OpenaiCompletions,
        context_window,
        max_tokens: 4_096,
        reasoning: false,
        input: vec![kordi_provider::registry::ModelInput::Text],
        base_url: None,
        cost: Default::default(),
    }
}

fn test_request_metrics_tracker() -> Arc<tokio::sync::Mutex<RequestMetricsTracker>> {
    Arc::new(tokio::sync::Mutex::new(RequestMetricsTracker::new()))
}

fn test_tool_context() -> kordi_tools::ToolContext {
    kordi_tools::ToolContext {
        cwd: "/tmp".into(),
        artifacts_dir: "/tmp".into(),
        execution_policy: kordi_tools::ExecutionPolicy::Safety,
        on_output: None,
        web_search: None,
        reach_out: None,
        execution_mode: kordi_tools::ToolExecutionMode::Interactive,
        request_approval: None,
    }
}

struct LocalModelTimeoutOverrideGuard;

impl Drop for LocalModelTimeoutOverrideGuard {
    fn drop(&mut self) {
        super::runner::set_local_model_overload_timeout_override_for_tests(None);
    }
}

fn set_local_model_timeout_override(timeout: Duration) -> LocalModelTimeoutOverrideGuard {
    super::runner::set_local_model_overload_timeout_override_for_tests(Some(timeout));
    LocalModelTimeoutOverrideGuard
}

mod compaction;
mod provider_failures;
mod tool_execution;
