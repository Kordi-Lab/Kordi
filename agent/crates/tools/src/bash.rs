mod options;
mod output;
mod process;
mod safety;

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{Value, json};
use std::future;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::bash_policy::{BashSafetyDisposition, classify_bash_command};
use crate::sandbox;
use crate::support::text_result_with;
use crate::{Tool, ToolContext, ToolMetadata, ToolResult, ToolRiskLevel, ToolScheduling};

#[cfg(test)]
use crate::ToolExecutionMode;

use output::{BashOutputRedactor, redact_bash_output_text, store_bash_output};
use process::{SpawnedProcess, kill_running_process, spawn_bash_process};
use safety::{
    BashResultDetails, BashSafetyContext, build_details, render_sandbox_failure_output,
    request_bash_approval,
};

pub struct BashTool;

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }

    fn description(&self) -> &str {
        "Execute a bash command in the current working directory. Returns stdout and stderr. \
         Output is truncated to 2000 lines or 50KB (whichever is hit first). \
         Optionally provide a timeout in seconds. \
         In safety mode, read-only commands run inside the sandbox immediately; anything else \
         requires approval in interactive mode and is denied in non-interactive mode."
    }

    fn parameters_schema(&self) -> Value {
        options::schema()
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::execution(ToolRiskLevel::High)
    }

    fn scheduling(&self, params: &Value, _ctx: &ToolContext) -> ToolScheduling {
        match params
            .get("command")
            .and_then(Value::as_str)
            .map(classify_bash_command)
        {
            Some(safety) if safety.disposition == BashSafetyDisposition::Safe => {
                ToolScheduling::ReadOnly
            }
            _ => ToolScheduling::MutatingUnknown,
        }
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let workdir = options::resolve(&params, ctx)?;
        let command = params
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| KordiError::Tool("Missing 'command' parameter".into()))?;

        let timeout_secs = options::timeout(&params)?;
        let raw_output = params.get("raw").and_then(|v| v.as_bool()).unwrap_or(false);

        let safety = classify_bash_command(command);
        let approved = match request_bash_approval(command, ctx, &safety).await {
            Ok(approved) => approved,
            Err(result) => return Ok(*result),
        };

        let safety_context = BashSafetyContext {
            safety: &safety,
            approval_required: ctx.execution_policy == crate::ExecutionPolicy::Safety
                && matches!(
                    safety.disposition,
                    crate::bash_policy::BashSafetyDisposition::ApprovalRequired
                ),
            approved,
            execution_policy: ctx.execution_policy,
        };

        let SpawnedProcess {
            mut child,
            sandbox_backend,
            output_optimization,
            #[cfg(unix)]
            process_group_id,
        } = match spawn_bash_process(command, raw_output, ctx, &workdir, safety_context).await {
            Ok(process) => process,
            Err(result) => return Ok(*result),
        };

        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let mut stdout_buf = Vec::new();
        let mut stderr_buf = Vec::new();
        let mut stdout_chunk = [0u8; 4096];
        let mut stderr_chunk = [0u8; 4096];
        let mut status = None;
        let mut cancelled = false;
        let mut timed_out = false;
        let mut live_redactor = BashOutputRedactor::default();
        let timeout = timeout_secs.map(tokio::time::sleep);
        tokio::pin!(timeout);

        while status.is_none() {
            tokio::select! {
                _ = cancel.cancelled(), if !cancelled => {
                    cancelled = true;
                    kill_running_process(
                        &mut child,
                        #[cfg(unix)]
                        process_group_id,
                    ).await;
                    status = Some(child.wait().await.map_err(|e| KordiError::Tool(format!("Failed while waiting for cancelled bash command: {e}")))?);
                }
                _ = async {
                    if let Some(timeout) = timeout.as_mut().as_pin_mut() {
                        timeout.await;
                    } else {
                        future::pending::<()>().await;
                    }
                }, if timeout_secs.is_some() && !timed_out => {
                    timed_out = true;
                    kill_running_process(
                        &mut child,
                        #[cfg(unix)]
                        process_group_id,
                    ).await;
                    status = Some(child.wait().await.map_err(|e| KordiError::Tool(format!("Failed while waiting for timed out bash command: {e}")))?);
                }
                result = child.wait() => {
                    status = Some(result.map_err(|e| KordiError::Tool(format!("Failed while waiting for bash command: {e}")))?);
                }
                result = async {
                    if let Some(stdout) = stdout.as_mut() {
                        stdout.read(&mut stdout_chunk).await
                    } else {
                        future::pending::<std::io::Result<usize>>().await
                    }
                }, if stdout.is_some() => {
                    let n = result.map_err(|e| KordiError::Tool(format!("Failed reading bash stdout: {e}")))?;
                    if n == 0 {
                        stdout = None;
                    } else {
                        let chunk = String::from_utf8_lossy(&stdout_chunk[..n]);
                        if let Some(ref on_output) = ctx.on_output {
                            let redacted = live_redactor.push(&chunk);
                            if !redacted.is_empty() {
                                on_output(&redacted);
                            }
                        }
                        stdout_buf.extend_from_slice(&stdout_chunk[..n]);
                    }
                }
                result = async {
                    if let Some(stderr) = stderr.as_mut() {
                        stderr.read(&mut stderr_chunk).await
                    } else {
                        future::pending::<std::io::Result<usize>>().await
                    }
                }, if stderr.is_some() => {
                    let n = result.map_err(|e| KordiError::Tool(format!("Failed reading bash stderr: {e}")))?;
                    if n == 0 {
                        stderr = None;
                    } else {
                        let chunk = String::from_utf8_lossy(&stderr_chunk[..n]);
                        if let Some(ref on_output) = ctx.on_output {
                            let redacted = live_redactor.push(&chunk);
                            if !redacted.is_empty() {
                                on_output(&redacted);
                            }
                        }
                        stderr_buf.extend_from_slice(&stderr_chunk[..n]);
                    }
                }
            }
        }

        if let Some(stdout) = stdout.as_mut() {
            // The child may exit before both pipes have been fully read. Drain any remaining bytes
            // through the live redactor so streamed output stays in sync with the final result.
            let drained_from = stdout_buf.len();
            stdout
                .read_to_end(&mut stdout_buf)
                .await
                .map_err(|e| KordiError::Tool(format!("Failed draining bash stdout: {e}")))?;
            if let Some(ref on_output) = ctx.on_output {
                let drained = String::from_utf8_lossy(&stdout_buf[drained_from..]);
                let redacted = live_redactor.push(&drained);
                if !redacted.is_empty() {
                    on_output(&redacted);
                }
            }
        }
        if let Some(stderr) = stderr.as_mut() {
            let drained_from = stderr_buf.len();
            stderr
                .read_to_end(&mut stderr_buf)
                .await
                .map_err(|e| KordiError::Tool(format!("Failed draining bash stderr: {e}")))?;
            if let Some(ref on_output) = ctx.on_output {
                let drained = String::from_utf8_lossy(&stderr_buf[drained_from..]);
                let redacted = live_redactor.push(&drained);
                if !redacted.is_empty() {
                    on_output(&redacted);
                }
            }
        }

        if let Some(ref on_output) = ctx.on_output {
            let final_redacted = live_redactor.finish();
            if !final_redacted.is_empty() {
                on_output(&final_redacted);
            }
        }

        let exit_code = status.map(|s| s.code().unwrap_or(-1));

        let stdout_str = String::from_utf8_lossy(&stdout_buf);
        let stderr_str = String::from_utf8_lossy(&stderr_buf);

        let mut output = String::new();
        if !stdout_str.is_empty() {
            output.push_str(&stdout_str);
        }
        if !stderr_str.is_empty() {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(&stderr_str);
        }

        let sandbox_failure = sandbox_backend.and_then(|_| {
            if cancelled || timed_out || exit_code.unwrap_or_default() == 0 {
                None
            } else {
                sandbox::classify_sandbox_failure(&stderr_str)
            }
        });

        if let Some(failure) = sandbox_failure.as_ref() {
            output = render_sandbox_failure_output(failure, &output);
        }

        output = redact_bash_output_text(&output);

        let stored_output = store_bash_output(&output, &ctx.artifacts_dir);

        let mut details = build_details(BashResultDetails {
            command,
            exit_code,
            cancelled,
            timed_out,
            truncated: stored_output.truncated,
            safety: safety_context,
            sandbox_backend,
            sandbox_failure: sandbox_failure.as_ref(),
            output_optimization,
        });
        details["executionLocation"] = json!("local");
        details["workingDirectory"] = json!(workdir);
        Ok(text_result_with(
            stored_output.output,
            Some(details),
            cancelled || exit_code.map(|c| c != 0).unwrap_or(true),
            stored_output.artifact_path,
        ))
    }
}

#[cfg(test)]
mod tests;
