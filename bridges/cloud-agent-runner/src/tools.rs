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
    RemoteWebAllowed,
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
    ) -> Result<CloudToolOutput, CloudToolExecutionError> {
        match decide_runner_tool(&request) {
            RunnerToolDecision::Block(reason) => {
                return Err(CloudToolExecutionError::Blocked(
                    reason.explanation().to_string(),
                ));
            }
            RunnerToolDecision::AllowRemoteWeb => return Ok(CloudToolOutput::RemoteWebAllowed),
            RunnerToolDecision::AllowSandbox => {}
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
            _ => Err(CloudToolExecutionError::Blocked(
                "This tool is not available in Cloud fallback until a safe remote implementation exists."
                    .to_string(),
            )),
        }
    }
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
            )
            .await;
        let message = result.unwrap_err().to_string();
        assert!(message.contains("Cloud fallback"));
        assert!(!message.contains("approval"));

        let _ = fs::remove_dir_all(root);
    }
}
