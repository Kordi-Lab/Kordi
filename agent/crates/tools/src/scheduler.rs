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

#[cfg(test)]
mod shared_tests;

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
    ensure_tool_allowed(tool, ctx)?;
    tool.execute(args, ctx, cancel).await.map(cap_tool_result)
}

pub fn ensure_tool_allowed(tool: &(dyn Tool + Send + Sync), ctx: &ToolContext) -> KordiResult<()> {
    if ctx.execution_policy == crate::ExecutionPolicy::Shared && !tool.allows_shared_requests() {
        return Err(KordiError::Tool(format!(
            "Tool {} is unavailable for a non-owner shared request. The owner's local files, commands and private capabilities are not authorized.",
            tool.name()
        )));
    }
    Ok(())
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
    ensure_tool_allowed(tool, ctx)?;
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
mod tests;
