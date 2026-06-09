use futures::future::join_all;
use kordi_core::{
    error::{KordiError, KordiResult},
    types::ContentBlock,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use tokio_util::sync::CancellationToken;

use crate::{Tool, ToolContext, ToolResult, ToolScheduling};

const MAX_TOOL_RESULT_TEXT_BYTES: usize = 50 * 1024;

/// Per-file mutation queue to prevent parallel write conflicts while still
/// allowing unrelated read-only work and unrelated file mutations to overlap.
pub struct FileQueue {
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    mutation_gate: Arc<RwLock<()>>,
}

impl Default for FileQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl FileQueue {
    pub fn new() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
            mutation_gate: Arc::new(RwLock::new(())),
        }
    }

    /// Acquire or create the mutex for a specific file path.
    pub async fn lock(&self, path: &Path) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks
            .entry(path.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn reserve_scheduling(&self, scheduling: &ToolScheduling) -> FileQueueReservation {
        match scheduling {
            ToolScheduling::ReadOnly => {
                FileQueueReservation::new(FileQueueReservationInner::ReadOnly)
            }
            ToolScheduling::MutatingUnknown => {
                FileQueueReservation::new(FileQueueReservationInner::UnknownMutation {
                    _gate: self.mutation_gate.clone().write_owned().await,
                })
            }
            ToolScheduling::MutatingPaths(paths) => {
                let mut normalized = paths.clone();
                normalized.sort();
                normalized.dedup();

                if normalized.is_empty() {
                    return FileQueueReservation::new(FileQueueReservationInner::UnknownMutation {
                        _gate: self.mutation_gate.clone().write_owned().await,
                    });
                }

                let gate = self.mutation_gate.clone().read_owned().await;
                let mut guards = Vec::with_capacity(normalized.len());
                for path in normalized {
                    let lock = self.lock(&path).await;
                    guards.push(lock.lock_owned().await);
                }
                FileQueueReservation::new(FileQueueReservationInner::KnownMutation {
                    _gate: gate,
                    _guards: guards,
                })
            }
        }
    }
}

pub struct FileQueueReservation(FileQueueReservationInner);

impl FileQueueReservation {
    fn new(inner: FileQueueReservationInner) -> Self {
        Self(inner)
    }

    #[allow(dead_code)]
    fn hold(&self) {
        let _ = &self.0;
    }
}

enum FileQueueReservationInner {
    ReadOnly,
    KnownMutation {
        _gate: OwnedRwLockReadGuard<()>,
        _guards: Vec<OwnedMutexGuard<()>>,
    },
    UnknownMutation {
        _gate: OwnedRwLockWriteGuard<()>,
    },
}

/// Execute a single tool call with mutation-aware scheduling.
pub async fn execute_reserved_tool_call(
    tool: &(dyn Tool + Send + Sync),
    args: Value,
    ctx: &ToolContext,
    cancel: CancellationToken,
    reservation: FileQueueReservation,
) -> KordiResult<ToolResult> {
    reservation.hold();
    tool.execute(args, ctx, cancel).await.map(cap_tool_result)
}

fn cap_tool_result(mut result: ToolResult) -> ToolResult {
    let (content, details) = cap_tool_result_content(result.content, result.details);
    result.content = content;
    result.details = details;
    result
}

pub fn cap_tool_result_content(
    content: Vec<ContentBlock>,
    details: Option<Value>,
) -> (Vec<ContentBlock>, Option<Value>) {
    let mut largest_original_text_bytes = 0usize;
    let mut truncated_any = false;

    let content = content
        .into_iter()
        .map(|block| match block {
            ContentBlock::Text { text } if text.len() > MAX_TOOL_RESULT_TEXT_BYTES => {
                largest_original_text_bytes = largest_original_text_bytes.max(text.len());
                truncated_any = true;
                ContentBlock::Text {
                    text: truncate_tool_text(&text, MAX_TOOL_RESULT_TEXT_BYTES),
                }
            }
            other => other,
        })
        .collect();

    let details = if truncated_any {
        Some(mark_truncated_details(
            details,
            largest_original_text_bytes,
            MAX_TOOL_RESULT_TEXT_BYTES,
        ))
    } else {
        details
    };

    (content, details)
}

fn mark_truncated_details(
    details: Option<Value>,
    original_bytes: usize,
    max_bytes: usize,
) -> Value {
    match details {
        Some(Value::Object(mut object)) => {
            object.insert("outputTruncated".to_string(), json!(true));
            object.insert("originalOutputBytes".to_string(), json!(original_bytes));
            object.insert("maxOutputBytes".to_string(), json!(max_bytes));
            Value::Object(object)
        }
        Some(other) => json!({
            "outputTruncated": true,
            "originalOutputBytes": original_bytes,
            "maxOutputBytes": max_bytes,
            "originalDetails": other,
        }),
        None => json!({
            "outputTruncated": true,
            "originalOutputBytes": original_bytes,
            "maxOutputBytes": max_bytes,
        }),
    }
}

fn truncate_tool_text(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }

    let marker = format!(
        "\n\n[tool output truncated: original {} bytes, capped at {} bytes; middle omitted]\n\n",
        text.len(),
        max_bytes,
    );
    if marker.len() >= max_bytes {
        return utf8_prefix(text, max_bytes).to_string();
    }

    let content_budget = max_bytes - marker.len();
    let prefix_budget = content_budget / 2;
    let suffix_budget = content_budget - prefix_budget;
    let prefix = utf8_prefix(text, prefix_budget);
    let suffix = utf8_suffix(text, suffix_budget);
    format!("{prefix}{marker}{suffix}")
}

fn utf8_prefix(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn utf8_suffix(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Execute a single tool call with mutation-aware scheduling.
pub async fn execute_tool_call(
    tool: &(dyn Tool + Send + Sync),
    args: Value,
    ctx: &ToolContext,
    cancel: CancellationToken,
    file_queue: &FileQueue,
) -> KordiResult<ToolResult> {
    let reservation = file_queue
        .reserve_scheduling(&tool.scheduling(&args, ctx))
        .await;
    execute_reserved_tool_call(tool, args, ctx, cancel, reservation).await
}

/// Execute multiple tool calls, allowing read-only and non-conflicting file
/// mutations to overlap while serializing same-file mutation windows.
pub async fn execute_tool_calls(
    tools: &[Box<dyn Tool>],
    calls: &[(String, String, Value)],
    ctx: &ToolContext,
    cancel: CancellationToken,
    file_queue: &FileQueue,
) -> Vec<(String, KordiResult<ToolResult>)> {
    let mut pending = Vec::new();
    let mut immediate = Vec::new();

    for (index, (call_id, tool_name, args)) in calls.iter().enumerate() {
        let Some(tool) = tools.iter().find(|tool| tool.name() == tool_name) else {
            immediate.push((
                index,
                call_id.clone(),
                Err(KordiError::Tool(format!("Unknown tool: {tool_name}"))),
            ));
            continue;
        };

        let cancel = cancel.clone();
        pending.push(async move {
            let result =
                execute_tool_call(tool.as_ref(), args.clone(), ctx, cancel, file_queue).await;
            (index, call_id.clone(), result)
        });
    }

    let mut results = immediate;
    results.extend(join_all(pending).await);
    results.sort_by_key(|(index, _, _)| *index);
    results
        .into_iter()
        .map(|(_, call_id, result)| (call_id, result))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use kordi_core::types::ContentBlock;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::{Mutex as TokioMutex, Notify};
    use tokio::time::{Duration, sleep, timeout};

    fn test_context() -> ToolContext {
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
}
