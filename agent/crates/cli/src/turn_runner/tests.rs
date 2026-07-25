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
use kordi_provider::{
    CompletionRequest, Provider, ProviderError, ProviderHttpError, RequestOptions, StreamEvent,
    UsageInfo,
};
use kordi_session::store;
use kordi_tools::{Tool, ToolResult, ToolScheduling};
use reqwest::StatusCode;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::{Notify, mpsc};
use tokio::time::{Duration, timeout};
use tokio_util::sync::CancellationToken;

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
                error: ProviderError::stream(
                    "openai",
                    "test stream",
                    Some("An error occurred while processing your request. You can retry your request."),
                    Some("server_error"),
                ),
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

struct AlwaysStreamErrorProvider {
    call_count: AtomicUsize,
    visible_output_before_error: bool,
    error: ProviderError,
}

#[async_trait]
impl Provider for AlwaysStreamErrorProvider {
    fn name(&self) -> &str {
        "always-stream-error"
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
        self.call_count.fetch_add(1, Ordering::SeqCst);
        if self.visible_output_before_error {
            let _ = tx.send(StreamEvent::TextDelta {
                text: "partial".to_string(),
            });
        }
        let _ = tx.send(StreamEvent::Error {
            error: self.error.clone(),
        });
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

fn terminal_http_error() -> ProviderError {
    ProviderError::Http(ProviderHttpError {
        provider: "openai".to_string(),
        operation: "responses".to_string(),
        status: StatusCode::FORBIDDEN,
        url: "https://chatgpt.com/backend-api/codex/responses".to_string(),
        content_type: Some("text/html".to_string()),
        message: "Unknown error".to_string(),
        code: None,
        request_id: None,
        cf_ray: Some("ray-test-HKG".to_string()),
        retry_after_ms: None,
        body_truncated: true,
        cloudflare_block: true,
        hint: None,
    })
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

struct ReflectionCallProvider {
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
            error: ProviderError::stream(
                "openai",
                "test stream",
                Some("context_length_exceeded"),
                Some("context_length_exceeded"),
            ),
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
impl Provider for ReflectionCallProvider {
    fn name(&self) -> &str {
        "reflection-call-provider"
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
                id: "reflection-tool-1".to_string(),
                name: "reflection".to_string(),
            });
            let _ = tx.send(StreamEvent::ToolCallDelta {
                id: "reflection-tool-1".to_string(),
                arguments_delta: r#"{"scope":"conversation","scopeId":"session-1","source":"manual","lesson":"Keep lesson storage scoped."}"#.to_string(),
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
                error: ProviderError::other("missing tool error flag", false),
            });
            Ok(())
        }
    }
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
        model: None,
        execution_policy: kordi_tools::ExecutionPolicy::Safety,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: None,
        task_operator: None,
        schedule_task: None,
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

mod cancellation;
mod compaction;
mod provider_failures;
mod tool_execution;
