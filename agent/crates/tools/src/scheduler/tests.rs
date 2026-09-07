use super::*;
use async_trait::async_trait;
use kordi_core::types::ContentBlock;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::{Mutex as TokioMutex, Notify};
use tokio::time::{Duration, sleep, timeout};

pub(super) fn test_context() -> ToolContext {
    ToolContext {
        cwd: "/tmp".into(),
        artifacts_dir: "/tmp".into(),
        model: None,
        execution_policy: crate::ExecutionPolicy::Safety,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: None,
        task_operator: None,
        schedule_task: None,
        execution_mode: crate::ToolExecutionMode::Interactive,
        request_approval: None,
    }
}

fn text_result(text: &str) -> ToolResult {
    ToolResult {
        content: vec![ContentBlock::Text {
            text: text.to_string(),
        }],
        details: None,
        is_error: false,
        artifact_path: None,
    }
}

struct CoordinatedReadTool {
    entered: Arc<TokioMutex<usize>>,
    notify: Arc<Notify>,
}

#[async_trait]
impl Tool for CoordinatedReadTool {
    fn name(&self) -> &str {
        "coordinated-read"
    }

    fn description(&self) -> &str {
        "verifies read-only calls can overlap"
    }

    fn parameters_schema(&self) -> Value {
        json!({"type": "object"})
    }

    async fn execute(
        &self,
        _params: Value,
        _ctx: &ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let should_wait = {
            let mut entered = self.entered.lock().await;
            *entered += 1;
            let should_wait = *entered < 2;
            if !should_wait {
                self.notify.notify_waiters();
            }
            should_wait
        };

        if should_wait {
            timeout(Duration::from_millis(200), async {
                loop {
                    if *self.entered.lock().await >= 2 {
                        break;
                    }
                    self.notify.notified().await;
                }
            })
            .await
            .map_err(|_| KordiError::Tool("read-only tool calls did not overlap".into()))?;
        }

        Ok(text_result("ok"))
    }
}

struct MutatingProbeTool {
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
}

struct HugeOutputTool;

#[async_trait]
impl Tool for HugeOutputTool {
    fn name(&self) -> &str {
        "huge-output"
    }

    fn description(&self) -> &str {
        "returns an oversized text payload"
    }

    fn parameters_schema(&self) -> Value {
        json!({"type": "object"})
    }

    async fn execute(
        &self,
        _params: Value,
        _ctx: &ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        Ok(ToolResult {
            content: vec![ContentBlock::Text {
                text: format!(
                    "{}{}{}",
                    "A".repeat(80 * 1024),
                    "middle-marker",
                    "Z".repeat(80 * 1024)
                ),
            }],
            details: Some(json!({"source": "test"})),
            is_error: false,
            artifact_path: None,
        })
    }
}

#[async_trait]
impl Tool for MutatingProbeTool {
    fn name(&self) -> &str {
        "mutating-probe"
    }

    fn description(&self) -> &str {
        "tracks concurrent mutation windows"
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"}
            },
            "required": ["path"]
        })
    }

    fn scheduling(&self, params: &Value, ctx: &ToolContext) -> ToolScheduling {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .map(|path| crate::path::resolve_path(&ctx.cwd, path))
            .unwrap_or_else(|| ctx.cwd.join("unknown"));
        ToolScheduling::single_mutating_path(path)
    }

    async fn execute(
        &self,
        _params: Value,
        _ctx: &ToolContext,
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
        sleep(Duration::from_millis(50)).await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(text_result("ok"))
    }
}

#[tokio::test]
async fn read_only_calls_can_run_in_parallel() {
    let queue = FileQueue::new();
    let entered = Arc::new(TokioMutex::new(0));
    let notify = Arc::new(Notify::new());
    let tools: Vec<Box<dyn Tool>> = vec![Box::new(CoordinatedReadTool { entered, notify })];
    let calls = vec![
        (
            "call-1".to_string(),
            "coordinated-read".to_string(),
            json!({}),
        ),
        (
            "call-2".to_string(),
            "coordinated-read".to_string(),
            json!({}),
        ),
    ];

    let results = execute_tool_calls(
        &tools,
        &calls,
        &test_context(),
        CancellationToken::new(),
        &queue,
    )
    .await;

    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|(_, result)| result.is_ok()));
}

#[tokio::test]
async fn tool_results_are_capped_before_leaving_scheduler() {
    let queue = FileQueue::new();
    let result = execute_tool_call(
        &HugeOutputTool,
        json!({}),
        &test_context(),
        CancellationToken::new(),
        &queue,
    )
    .await
    .expect("tool should run");

    let ContentBlock::Text { text } = &result.content[0] else {
        panic!("expected text result");
    };
    assert!(
        text.len() < 70 * 1024,
        "tool text should be capped, got {} bytes",
        text.len()
    );
    assert!(text.contains("tool output truncated"));
    assert!(text.contains("AAAA"), "head should be preserved");
    assert!(text.contains("ZZZZ"), "tail should be preserved");
    assert!(
        !text.contains("middle-marker"),
        "middle of huge output should be omitted"
    );
    assert_eq!(
        result
            .details
            .as_ref()
            .and_then(|details| details.get("outputTruncated"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        result
            .details
            .as_ref()
            .and_then(|details| details.get("source"))
            .and_then(Value::as_str),
        Some("test")
    );
}

#[tokio::test]
async fn same_file_mutations_are_serialized() {
    let queue = FileQueue::new();
    let max_active = Arc::new(AtomicUsize::new(0));
    let tools: Vec<Box<dyn Tool>> = vec![Box::new(MutatingProbeTool {
        active: Arc::new(AtomicUsize::new(0)),
        max_active: max_active.clone(),
    })];
    let calls = vec![
        (
            "call-1".to_string(),
            "mutating-probe".to_string(),
            json!({"path": "shared.txt"}),
        ),
        (
            "call-2".to_string(),
            "mutating-probe".to_string(),
            json!({"path": "shared.txt"}),
        ),
    ];

    let results = execute_tool_calls(
        &tools,
        &calls,
        &test_context(),
        CancellationToken::new(),
        &queue,
    )
    .await;

    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|(_, result)| result.is_ok()));
    assert_eq!(max_active.load(Ordering::SeqCst), 1);
}
