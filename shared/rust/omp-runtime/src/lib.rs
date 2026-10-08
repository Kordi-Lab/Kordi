//! Supervised, per-turn JSONL transport for the Kordi OMP worker.
//! Provider credentials are written only to the child's stdin, never to its
//! arguments, environment, diagnostics, or this crate's error strings.

mod error;
mod protocol;
mod supervisor_helpers;
mod warm_pool;
pub use error::RuntimeError;
use supervisor_helpers::{
    ToolCancelGuard, acquire_computer_lock, check_frame, read_line_bounded, validate_request,
    write_json_line,
};
use warm_pool::{AttachedWorker, WarmPool, spawn_worker};

pub use protocol::{
    AuthConfig, AuthKind, Capabilities, Checkpoint, CompactionSettings, ImageInput, ModelConfig,
    Prompt, RunLimits, RunRequest, RunResult, RuntimeEvent, SCHEMA_VERSION, ToolCall,
    ToolDefinition, ToolResult,
};

use std::collections::HashSet;
use std::ffi::OsString;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::{StreamExt, future::BoxFuture, stream::FuturesUnordered};
use protocol::{WorkerInput, WorkerOutput};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct WorkerCommand {
    pub program: PathBuf,
    /// Executable/script flags only. Never place auth material here.
    pub args: Vec<OsString>,
    /// Stable file inside the owning user's private app-data directory.
    pub computer_lock_path: Option<PathBuf>,
}

impl WorkerCommand {
    pub fn sidecar(path: impl Into<PathBuf>) -> Self {
        Self {
            program: path.into(),
            args: Vec::new(),
            computer_lock_path: None,
        }
    }

    pub fn node(script: impl Into<PathBuf>) -> Self {
        Self {
            program: PathBuf::from("node"),
            args: vec![script.into().into_os_string()],
            computer_lock_path: None,
        }
    }

    pub fn with_computer_lock(mut self, path: impl Into<PathBuf>) -> Self {
        self.computer_lock_path = Some(path.into());
        self
    }
}

#[async_trait]
pub trait HostTool: Send + Sync {
    async fn execute(&self, call: ToolCall, cancel: CancellationToken) -> ToolResult;

    async fn hook(
        &self,
        _name: &str,
        input: serde_json::Value,
        _cancel: CancellationToken,
    ) -> Result<serde_json::Value, String> {
        Ok(input)
    }
}

#[async_trait]
impl<F, Fut> HostTool for F
where
    F: Fn(ToolCall, CancellationToken) -> Fut + Send + Sync,
    Fut: Future<Output = ToolResult> + Send,
{
    async fn execute(&self, call: ToolCall, cancel: CancellationToken) -> ToolResult {
        (self)(call, cancel).await
    }
}

#[async_trait]
pub trait EventSink: Send + Sync {
    async fn on_event(&self, event: RuntimeEvent) -> Result<(), String>;
}

#[async_trait]
impl<F, Fut> EventSink for F
where
    F: Fn(RuntimeEvent) -> Fut + Send + Sync,
    Fut: Future<Output = Result<(), String>> + Send,
{
    async fn on_event(&self, event: RuntimeEvent) -> Result<(), String> {
        (self)(event).await
    }
}

#[derive(Clone)]
pub struct OmpRuntime {
    command: WorkerCommand,
    warm: Option<Arc<WarmPool>>,
}

impl OmpRuntime {
    pub fn new(command: WorkerCommand) -> Self {
        Self {
            command,
            warm: None,
        }
    }

    /// Keeps up to `count` idle one-shot workers started ahead of their turn.
    /// Zero (the default) spawns every worker on demand. Clones share the pool.
    pub fn with_warm_workers(mut self, count: usize) -> Self {
        self.warm = (count > 0).then(|| Arc::new(WarmPool::new(count)));
        self
    }

    /// Starts the warm workers now. Needs a Tokio runtime context.
    pub fn prewarm(&self) {
        if let Some(pool) = &self.warm {
            pool.fill(&self.command);
        }
    }

    /// Kills idle warm workers and stops refilling. Turns still run on demand.
    pub fn shutdown(&self) {
        if let Some(pool) = &self.warm {
            pool.shutdown();
        }
    }

    fn take_worker(&self) -> Result<(AttachedWorker, bool), RuntimeError> {
        let Some(pool) = &self.warm else {
            return Ok((AttachedWorker::attach(spawn_worker(&self.command)?)?, false));
        };
        let taken = pool.take();
        pool.refill_in_background(&self.command);
        match taken {
            Some(child) => Ok((AttachedWorker::attach(child)?, true)),
            None => Ok((AttachedWorker::attach(spawn_worker(&self.command)?)?, false)),
        }
    }

    pub async fn run_turn<H: HostTool, E: EventSink>(
        &self,
        request: &RunRequest,
        tools: &H,
        events: &E,
        cancel: CancellationToken,
    ) -> Result<RunResult, RuntimeError> {
        validate_request(request)?;
        let _computer_lock = if request.capabilities.computer {
            let path = self
                .command
                .computer_lock_path
                .as_ref()
                .ok_or(RuntimeError::InvalidRequest)?;
            Some(acquire_computer_lock(path, &cancel, request.limits.timeout_ms).await?)
        } else {
            None
        };
        let (mut worker, mut warm) = self.take_worker()?;
        let deadline = Instant::now() + Duration::from_millis(request.limits.timeout_ms);
        let run_command = WorkerInput::Run {
            schema_version: SCHEMA_VERSION,
            request,
        };
        loop {
            let written = tokio::select! {
                _ = cancel.cancelled() => return Err(RuntimeError::Cancelled),
                _ = tokio::time::sleep_until(deadline) => return Err(RuntimeError::Timeout),
                result = write_json_line(&mut worker.stdin, &run_command) => result,
            };
            match written {
                // A warm worker can die between its liveness check and the
                // write. Fall back to a fresh worker once.
                Err(RuntimeError::UnexpectedExit) if warm => {
                    warm = false;
                    worker = AttachedWorker::attach(spawn_worker(&self.command)?)?;
                }
                result => break result?,
            }
        }
        let AttachedWorker {
            _child: _worker_guard,
            mut stdin,
            stdout,
            stderr_overflow: mut stderr_overflow_rx,
        } = worker;

        let mut stdout = BufReader::new(stdout);
        let mut seen_ready = false;
        let mut last_sequence = None;
        let mut output_bytes = 0usize;
        let mut tool_calls = HashSet::new();
        let mut hook_calls = HashSet::new();
        let tool_cancel = cancel.child_token();
        let _tool_cancel_guard = ToolCancelGuard(tool_cancel.clone());
        let mut pending_tools: FuturesUnordered<BoxFuture<'_, (String, ToolResult)>> =
            FuturesUnordered::new();
        let mut pending_hooks: FuturesUnordered<
            BoxFuture<'_, (String, Result<serde_json::Value, String>)>,
        > = FuturesUnordered::new();
        let mut stderr_watch = true;
        loop {
            enum Next {
                Line(Option<Vec<u8>>),
                Tool(String, ToolResult),
                Hook(String, Result<serde_json::Value, String>),
            }
            let next = tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = tokio::time::timeout(Duration::from_millis(100), write_json_line(
                        &mut stdin,
                        &WorkerInput::Cancel {
                            schema_version: SCHEMA_VERSION,
                            run_id: &request.run_id,
                            attempt_id: &request.attempt_id,
                        },
                    )).await;
                    return Err(RuntimeError::Cancelled);
                },
                _ = tokio::time::sleep_until(deadline) => return Err(RuntimeError::Timeout),
                result = &mut stderr_overflow_rx, if stderr_watch => {
                    if result.is_ok() { return Err(RuntimeError::OutputLimit); }
                    stderr_watch = false;
                    continue;
                },
                result = read_line_bounded(&mut stdout, &mut output_bytes, request.limits.max_output_bytes) => Next::Line(result?),
                Some((call_id, result)) = pending_tools.next(), if !pending_tools.is_empty() => Next::Tool(call_id, result),
                Some((call_id, result)) = pending_hooks.next(), if !pending_hooks.is_empty() => Next::Hook(call_id, result),
            };
            if let Next::Tool(call_id, result) = next {
                let reply = WorkerInput::ToolResult {
                    schema_version: SCHEMA_VERSION,
                    run_id: &request.run_id,
                    attempt_id: &request.attempt_id,
                    call_id: &call_id,
                    result: &result,
                };
                tokio::select! {
                    _ = cancel.cancelled() => return Err(RuntimeError::Cancelled),
                    _ = tokio::time::sleep_until(deadline) => return Err(RuntimeError::Timeout),
                    result = write_json_line(&mut stdin, &reply) => result?,
                }
                continue;
            }
            if let Next::Hook(call_id, result) = next {
                let result = result.map_err(|_| RuntimeError::Callback)?;
                if !result.is_object() {
                    return Err(RuntimeError::Callback);
                }
                let reply = WorkerInput::HookResult {
                    schema_version: SCHEMA_VERSION,
                    run_id: &request.run_id,
                    attempt_id: &request.attempt_id,
                    call_id: &call_id,
                    result: &result,
                };
                tokio::select! {
                    _ = cancel.cancelled() => return Err(RuntimeError::Cancelled),
                    _ = tokio::time::sleep_until(deadline) => return Err(RuntimeError::Timeout),
                    result = write_json_line(&mut stdin, &reply) => result?,
                }
                continue;
            }
            let Next::Line(line) = next else {
                unreachable!()
            };
            let Some(line) = line else {
                return Err(RuntimeError::UnexpectedExit);
            };
            let output: WorkerOutput =
                serde_json::from_slice(&line).map_err(|_| RuntimeError::Protocol)?;
            match output {
                WorkerOutput::Ready { schema_version } => {
                    if seen_ready || schema_version != SCHEMA_VERSION {
                        return Err(RuntimeError::Protocol);
                    }
                    seen_ready = true;
                }
                WorkerOutput::Event {
                    schema_version,
                    run_id,
                    attempt_id,
                    sequence,
                    event,
                } => {
                    check_frame(
                        request,
                        seen_ready,
                        schema_version,
                        &run_id,
                        &attempt_id,
                        sequence,
                        &mut last_sequence,
                    )?;
                    // A terminal UI state belongs to the validated result, not
                    // an earlier worker status frame.
                    if event.kind == "status"
                        && event.data.get("status").and_then(|value| value.as_str())
                            == Some("completed")
                    {
                        continue;
                    }
                    tokio::select! {
                        _ = cancel.cancelled() => return Err(RuntimeError::Cancelled),
                        _ = tokio::time::sleep_until(deadline) => return Err(RuntimeError::Timeout),
                        result = events.on_event(event) => result.map_err(|_| RuntimeError::Callback)?,
                    }
                }
                WorkerOutput::ToolCall {
                    schema_version,
                    run_id,
                    attempt_id,
                    sequence,
                    call_id,
                    name,
                    input,
                } => {
                    check_frame(
                        request,
                        seen_ready,
                        schema_version,
                        &run_id,
                        &attempt_id,
                        sequence,
                        &mut last_sequence,
                    )?;
                    if call_id.trim().is_empty()
                        || !tool_calls.insert(call_id.clone())
                        || hook_calls.contains(&call_id)
                        || tool_calls.len() > request.limits.max_tool_calls
                        || !request.tools.iter().any(|tool| tool.name == name)
                    {
                        return Err(RuntimeError::Protocol);
                    }
                    let token = tool_cancel.child_token();
                    pending_tools.push(Box::pin(async move {
                        let result = tools
                            .execute(
                                ToolCall {
                                    call_id: call_id.clone(),
                                    name,
                                    input,
                                },
                                token,
                            )
                            .await;
                        (call_id, result)
                    }));
                }
                WorkerOutput::HookCall {
                    schema_version,
                    run_id,
                    attempt_id,
                    sequence,
                    call_id,
                    name,
                    input,
                } => {
                    check_frame(
                        request,
                        seen_ready,
                        schema_version,
                        &run_id,
                        &attempt_id,
                        sequence,
                        &mut last_sequence,
                    )?;
                    if call_id.trim().is_empty()
                        || tool_calls.contains(&call_id)
                        || !hook_calls.insert(call_id.clone())
                        || hook_calls.len() > request.limits.max_steps.saturating_mul(4).max(64)
                        || !matches!(name.as_str(), "context" | "before_provider_request")
                        || !request.hooks.iter().any(|hook| hook == &name)
                    {
                        return Err(RuntimeError::Protocol);
                    }
                    let token = tool_cancel.child_token();
                    pending_hooks.push(Box::pin(async move {
                        let result = tools.hook(&name, input, token).await;
                        (call_id, result)
                    }));
                }
                WorkerOutput::Result {
                    schema_version,
                    run_id,
                    attempt_id,
                    sequence,
                    text,
                    messages,
                    context_messages,
                    usage,
                    stop_reason,
                    checkpoint,
                } => {
                    check_frame(
                        request,
                        seen_ready,
                        schema_version,
                        &run_id,
                        &attempt_id,
                        sequence,
                        &mut last_sequence,
                    )?;
                    if !pending_tools.is_empty() || !pending_hooks.is_empty() {
                        return Err(RuntimeError::Protocol);
                    }
                    return Ok(RunResult {
                        text,
                        messages,
                        context_messages,
                        usage,
                        stop_reason,
                        checkpoint,
                    });
                }
                WorkerOutput::Error {
                    schema_version,
                    run_id,
                    attempt_id,
                    sequence,
                    code,
                    _message: _,
                } => {
                    check_frame(
                        request,
                        seen_ready,
                        schema_version,
                        &run_id,
                        &attempt_id,
                        sequence,
                        &mut last_sequence,
                    )?;
                    let code = if code.len() <= 64
                        && code
                            .chars()
                            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
                    {
                        code
                    } else {
                        "worker_error".to_string()
                    };
                    return Err(RuntimeError::Worker(code));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
