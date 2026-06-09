use std::path::PathBuf;

use kordi_core::types::ContentBlock;
use kordi_tools::{
    web_fetch::WebFetchTool, web_search::WebSearchTool, ExecutionPolicy, Tool, ToolContext,
    ToolExecutionMode, ToolResult,
};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::sandbox_client::{BashOutput, SandboxBackendHandle, SandboxClientError};
use crate::tool_policy::{decide_runner_tool, RunnerToolDecision, RunnerToolRequest};

#[derive(Debug, thiserror::Error)]
pub enum CloudToolExecutionError {
    #[error("{0}")]
    Blocked(String),
    #[error(transparent)]
    Sandbox(#[from] SandboxClientError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudToolOutput {
    Text(String),
    List(Vec<String>),
    Bash(BashOutput),
}

pub struct CloudToolExecutor {
    sandbox: SandboxBackendHandle,
}

impl CloudToolExecutor {
    pub fn new(sandbox: SandboxBackendHandle) -> Self {
        Self { sandbox }
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
            RunnerToolDecision::AllowRemoteWeb | RunnerToolDecision::AllowSandbox => {}
        }

        match request.tool_name {
            "read" => Ok(CloudToolOutput::Text(
                self.sandbox.read_text(primary_arg.unwrap_or_default()).await?,
            )),
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
                Ok(CloudToolOutput::Text(format_kordi_tool_result(result)))
            }
            "web_fetch" => {
                let ctx = cloud_tool_context(&self.sandbox);
                let result = WebFetchTool
                    .execute(arguments.clone(), &ctx, CancellationToken::new())
                    .await
                    .map_err(|err| CloudToolExecutionError::Blocked(err.to_string()))?;
                Ok(CloudToolOutput::Text(format_kordi_tool_result(result)))
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
        model: None,
        execution_policy: ExecutionPolicy::Safety,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        task_operator: None,
        schedule_task: None,
        execution_mode: ToolExecutionMode::NonInteractive,
        request_approval: None,
    }
}

fn cloud_runner_tmp_dir() -> PathBuf {
    std::env::temp_dir().join("kordi-cloud-agent-runner-web-tools")
}

fn format_kordi_tool_result(result: ToolResult) -> String {
    result
        .content
        .into_iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text,
            ContentBlock::Image { mime_type, .. } => format!("[image result: {mime_type}]"),
        })
        .collect::<Vec<_>>()
        .join("\n")
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
