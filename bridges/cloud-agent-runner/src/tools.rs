use std::path::PathBuf;

use kordi_core::error::KordiError;
use kordi_core::types::ContentBlock;
use kordi_tools::{
    reflection_tool::ReflectionTool, web_fetch::WebFetchTool, web_search::WebSearchTool,
    ExecutionPolicy, ReflectionLessonRequest, ReflectionLessonResponse, ReflectionRuntime,
    SaveReflectionLessonFn, Tool, ToolContext, ToolExecutionMode, ToolResult,
};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::client::CloudAgentRunClient;
use crate::memory::{MemoryRequestError, NewRunnerMemory};
use crate::sandbox_client::{BashOutput, SandboxBackendHandle, SandboxClientError};
use crate::tool_policy::{decide_runner_tool, RunnerToolDecision, RunnerToolRequest};

#[derive(Debug, thiserror::Error)]
pub enum CloudToolExecutionError {
    #[error("{0}")]
    Blocked(String),
    #[error(transparent)]
    Sandbox(#[from] SandboxClientError),
}

#[derive(Debug, Clone, PartialEq)]
pub enum CloudToolOutput {
    Text(String),
    List(Vec<String>),
    Bash(BashOutput),
    Content(Vec<ContentBlock>),
}

pub struct CloudToolExecutor {
    sandbox: SandboxBackendHandle,
    memory_enabled: bool,
}

type LessonReply =
    tokio::sync::oneshot::Sender<kordi_core::error::KordiResult<ReflectionLessonResponse>>;

impl CloudToolExecutor {
    pub fn new(sandbox: SandboxBackendHandle) -> Self {
        Self {
            sandbox,
            memory_enabled: false,
        }
    }

    /// Enables the `reflection` tool when the account has memory on.
    pub fn with_memory(mut self, enabled: bool) -> Self {
        self.memory_enabled = enabled;
        self
    }

    /// Runs the `reflection` tool, saving the lesson as an account memory
    /// through the run-scoped server route.
    pub async fn execute_reflection<C: CloudAgentRunClient + Sync>(
        &self,
        client: &C,
        run_id: &str,
        request: RunnerToolRequest<'_>,
        arguments: &Value,
    ) -> Result<CloudToolOutput, CloudToolExecutionError> {
        if let RunnerToolDecision::Block(reason) = decide_runner_tool(&request) {
            return Err(CloudToolExecutionError::Blocked(
                reason.explanation().to_string(),
            ));
        }
        if !self.memory_enabled {
            return Err(CloudToolExecutionError::Blocked(
                "Memory is off for this account.".to_string(),
            ));
        }
        // The tool runtime must be 'static, so it hands each save back to this
        // task, which holds the borrowed client.
        let (sender, mut receiver) =
            tokio::sync::mpsc::unbounded_channel::<(ReflectionLessonRequest, LessonReply)>();
        let save_lesson: SaveReflectionLessonFn = std::sync::Arc::new(move |request| {
            let sender = sender.clone();
            Box::pin(async move {
                let (reply, response) = tokio::sync::oneshot::channel();
                sender
                    .send((request, reply))
                    .map_err(|_| KordiError::Tool("Memory is unavailable.".to_string()))?;
                response
                    .await
                    .map_err(|_| KordiError::Tool("Memory is unavailable.".to_string()))?
            })
        });
        let mut ctx = cloud_tool_context(&self.sandbox);
        ctx.reflection = Some(ReflectionRuntime { save_lesson });
        let tool = ReflectionTool.execute(arguments.clone(), &ctx, CancellationToken::new());
        tokio::pin!(tool);
        let result = loop {
            tokio::select! {
                result = &mut tool => break result,
                Some((request, reply)) = receiver.recv() => {
                    let _ = reply.send(save_lesson_as_memory(client, run_id, request).await);
                }
            }
        };
        match result {
            Ok(result) => Ok(format_kordi_tool_result(result)),
            Err(KordiError::Tool(message)) => Err(CloudToolExecutionError::Blocked(message)),
            Err(error) => Err(CloudToolExecutionError::Blocked(error.to_string())),
        }
    }

    pub async fn execute(
        &self,
        request: RunnerToolRequest<'_>,
        primary_arg: Option<&str>,
        content: Option<&str>,
        arguments: &Value,
    ) -> Result<CloudToolOutput, CloudToolExecutionError> {
        match decide_runner_tool(&request) {
            RunnerToolDecision::Block(reason) => {
                return Err(CloudToolExecutionError::Blocked(
                    reason.explanation().to_string(),
                ));
            }
            RunnerToolDecision::AllowRemoteWeb
            | RunnerToolDecision::AllowSandbox
            | RunnerToolDecision::AllowConnector => {}
        }

        match request.tool_name {
            "read" => {
                let path = primary_arg.unwrap_or_default();
                if kordi_tools::image_input::is_image_path(std::path::Path::new(path)) {
                    let bytes = tokio::time::timeout(std::time::Duration::from_secs(65), self.sandbox.read_bytes_bounded(path, kordi_tools::image_input::MAX_IMAGE_BYTES))
                        .await.map_err(|_| CloudToolExecutionError::Blocked("Image read timed out.".into()))??;
                    let content = tokio::task::spawn_blocking(move || kordi_tools::image_input::image_content(&bytes))
                        .await.map_err(|_| CloudToolExecutionError::Blocked("Image decoding failed.".into()))?
                        .map_err(|err| CloudToolExecutionError::Blocked(err.to_string()))?;
                    return Ok(CloudToolOutput::Content(vec![content]));
                }
                Ok(CloudToolOutput::Text(self.sandbox.read_text(path).await?))
            },
            "write" | "edit" => {
                self.sandbox
                    .write_text(primary_arg.unwrap_or_default(), content.unwrap_or_default())
                    .await?;
                Ok(CloudToolOutput::Text("ok".to_string()))
            }
            "ls" | "find" | "grep" => Ok(CloudToolOutput::List(
                self.sandbox.list(primary_arg.unwrap_or_default()).await?,
            )),
            "bash" => Ok(CloudToolOutput::Bash(
                self.sandbox.run_bash(primary_arg.unwrap_or_default()).await?,
            )),
            "web_search" => {
                let ctx = cloud_tool_context(&self.sandbox);
                let result = WebSearchTool
                    .execute(arguments.clone(), &ctx, CancellationToken::new())
                    .await
                    .map_err(|err| CloudToolExecutionError::Blocked(err.to_string()))?;
                Ok(format_kordi_tool_result(result))
            }
            "web_fetch" => {
                let ctx = cloud_tool_context(&self.sandbox);
                let result = WebFetchTool
                    .execute(arguments.clone(), &ctx, CancellationToken::new())
                    .await
                    .map_err(|err| CloudToolExecutionError::Blocked(err.to_string()))?;
                Ok(format_kordi_tool_result(result))
            }
            _ => Err(CloudToolExecutionError::Blocked(
                "This tool is not available in Cloud fallback until a safe remote implementation exists."
                    .to_string(),
            )),
        }
    }
}

fn cloud_tool_context(sandbox: &SandboxBackendHandle) -> ToolContext {
    let root = sandbox
        .root_for_tests()
        .map_or_else(cloud_runner_tmp_dir, PathBuf::from);
    ToolContext {
        cwd: root.clone(),
        artifacts_dir: root,
        invocation_id: None,
        model: None,
        execution_policy: ExecutionPolicy::Shared,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: None,
        task_operator: None,
        schedule_task: None,
        mac_local: None,
        execution_mode: ToolExecutionMode::NonInteractive,
        connector_tools: None,
        request_approval: None,
    }
}

/// Stable pseudo path returned as the lesson artifact. It is reported to the
/// model only; nothing in the runner opens it as a file.
pub fn memory_artifact_path(scope: &str, scope_id: &str) -> String {
    format!("kordi-memory://{scope}/{scope_id}")
}

async fn save_lesson_as_memory<C: CloudAgentRunClient + Sync>(
    client: &C,
    run_id: &str,
    request: ReflectionLessonRequest,
) -> kordi_core::error::KordiResult<ReflectionLessonResponse> {
    let memory = NewRunnerMemory {
        scope: request.scope.trim().to_string(),
        scope_id: request.scope_id.trim().to_string(),
        scope_label: None,
        source: request.source.trim().to_string(),
        text: request.lesson.trim().to_string(),
        client_memory_id: Some(format!("mem_{}", uuid::Uuid::new_v4().simple())),
    };
    match client.save_memory(run_id, memory).await {
        Ok(saved) => Ok(ReflectionLessonResponse {
            artifact_path: memory_artifact_path(&saved.scope, &saved.scope_id),
            lesson_id: saved.memory_id,
            scope: saved.scope,
            scope_id: saved.scope_id,
        }),
        Err(MemoryRequestError::Server { message, .. }) => Err(KordiError::Tool(message)),
        Err(MemoryRequestError::Unavailable) => Err(KordiError::Tool(
            "Memory is unavailable for this run.".to_string(),
        )),
        Err(MemoryRequestError::Request(_)) => Err(KordiError::Tool(
            "Memory could not be saved. Try again later.".to_string(),
        )),
    }
}

fn cloud_runner_tmp_dir() -> PathBuf {
    std::env::temp_dir().join("kordi-cloud-agent-runner-web-tools")
}

fn format_kordi_tool_result(result: ToolResult) -> CloudToolOutput {
    if result
        .content
        .iter()
        .any(|b| matches!(b, ContentBlock::Image { .. }))
    {
        return CloudToolOutput::Content(result.content);
    }
    CloudToolOutput::Text(
        result
            .content
            .into_iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text),
                ContentBlock::Image { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn request<'a>(tool_name: &'a str, path_args: Vec<&'a str>) -> RunnerToolRequest<'a> {
        RunnerToolRequest {
            tool_name,
            path_args,
            url_args: Vec::new(),
            requester_account_id: "acct_requester",
            owner_account_id: "acct_owner",
            data_owner_account_id: None,
            connector_tools: &[],
        }
    }

    #[tokio::test]
    async fn executor_returns_boundary_explanation_for_blocked_tools() {
        let root = std::env::temp_dir().join(format!(
            "kordi-tool-executor-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).unwrap();
        let executor = CloudToolExecutor::new(std::sync::Arc::new(
            crate::sandbox_client::LocalSandboxBackend::new(root.clone()),
        ));

        let result = executor
            .execute(
                request("read", vec!["/Users/owner/private.txt"]),
                Some("/Users/owner/private.txt"),
                None,
                &serde_json::json!({}),
            )
            .await;
        let message = result.unwrap_err().to_string();
        assert!(message.contains("Cloud fallback"));
        assert!(!message.contains("approval"));

        let _ = fs::remove_dir_all(root);
    }
}
