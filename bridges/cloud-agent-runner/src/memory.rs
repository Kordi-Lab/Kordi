//! Account memories for cloud runs (#1710).
//!
//! The runner reads the run owner's memories once at run start, plus the
//! group memories other members saved (group memories are shared by the
//! group), and saves new ones through the `reflection` tool. The server owns the guards and the
//! account setting; the runner only drops the tool and the prompt section
//! when memory is off, and never fails a run because memory is unavailable.

use serde::{Deserialize, Serialize};

use crate::client::{CloudAgentRun, CloudAgentRunClient, HttpCloudAgentRunClient};

use kordi_tools::memory_prompt::{MemoryRun, MemorySettings, PromptMemory};
pub use kordi_tools::reflection_tool::{MAX_PROMPT_MEMORIES, MAX_PROMPT_MEMORY_CHARS};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerMemory {
    pub memory_id: String,
    pub scope: String,
    pub scope_id: String,
    #[serde(default)]
    pub scope_label: Option<String>,
    pub source: String,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
    /// The account that saved the memory. The prompt never shows owners.
    #[serde(default)]
    pub owner_account_id: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub declaration_type: Option<String>,
    #[serde(default)]
    pub confidence: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub profile_kind: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerMemorySettings {
    pub memory_enabled: bool,
    pub exclude_sensitive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunnerMemoryContext {
    pub memories: Vec<RunnerMemory>,
    pub settings: RunnerMemorySettings,
}

/// Body of a runner memory save. The HTTP client adds `runnerId`. There is
/// no `declaredBy`: the server files every runner save as model-inferred.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRunnerMemory {
    pub scope: String,
    pub scope_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_label: Option<String>,
    pub source: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_memory_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MemoryRequestError {
    /// The server has no memory route for this run (older server or 404).
    #[error("account memory is unavailable")]
    Unavailable,
    /// The server answered with `{ errorCode, message }`.
    #[error("{message}")]
    Server {
        status: u16,
        code: String,
        message: String,
    },
    #[error("memory request failed: {0}")]
    Request(String),
}

#[derive(Deserialize)]
struct MemoryEnvelope {
    memory: RunnerMemory,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

fn memory_path(run_id: &str) -> String {
    format!("/v1/cloud/agent-runs/{run_id}/memory")
}

async fn read_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, MemoryRequestError> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| MemoryRequestError::Request(err.to_string()))?;
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(MemoryRequestError::Unavailable);
    }
    if !status.is_success() {
        let body: Option<ErrorBody> = serde_json::from_str(&text).ok();
        let code = body.as_ref().and_then(|body| body.error_code.clone());
        let message = body.and_then(|body| body.message);
        return Err(MemoryRequestError::Server {
            status: status.as_u16(),
            code: code.unwrap_or_else(|| "server_error".to_string()),
            message: message.unwrap_or_else(|| format!("Memory request returned {status}.")),
        });
    }
    serde_json::from_str(&text).map_err(|err| MemoryRequestError::Request(err.to_string()))
}

pub(crate) async fn http_fetch_memory(
    client: &HttpCloudAgentRunClient,
    run_id: &str,
) -> Result<RunnerMemoryContext, MemoryRequestError> {
    let response = client
        .http
        .get(format!("{}{}", client.base_url, memory_path(run_id)))
        .query(&[("runnerId", client.runner_id.as_str())])
        .bearer_auth(&client.runner_token)
        .send()
        .await
        .map_err(|err| MemoryRequestError::Request(err.to_string()))?;
    read_response(response).await
}

pub(crate) async fn http_save_memory(
    client: &HttpCloudAgentRunClient,
    run_id: &str,
    memory: NewRunnerMemory,
) -> Result<RunnerMemory, MemoryRequestError> {
    let mut body =
        serde_json::to_value(memory).map_err(|err| MemoryRequestError::Request(err.to_string()))?;
    body["runnerId"] = serde_json::Value::String(client.runner_id.clone());
    let response = client
        .http
        .post(format!("{}{}", client.base_url, memory_path(run_id)))
        .bearer_auth(&client.runner_token)
        .json(&body)
        .send()
        .await
        .map_err(|err| MemoryRequestError::Request(err.to_string()))?;
    let envelope: MemoryEnvelope = read_response(response).await?;
    Ok(envelope.memory)
}

/// The memory state a run uses for its tool set and system prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunMemory {
    pub enabled: bool,
    pub exclude_sensitive: bool,
    pub memories: Vec<RunnerMemory>,
}

impl RunMemory {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            exclude_sensitive: true,
            memories: Vec::new(),
        }
    }
}

/// Fetches the run owner's memories once. Any failure disables memory for
/// this run instead of failing it.
pub async fn load_run_memory<C: CloudAgentRunClient + Sync>(
    client: &C,
    run: &CloudAgentRun,
) -> RunMemory {
    match client.fetch_memory(&run.run_id).await {
        Ok(context) => RunMemory {
            enabled: context.settings.memory_enabled,
            exclude_sensitive: context.settings.exclude_sensitive,
            memories: context.memories,
        },
        Err(MemoryRequestError::Unavailable) => {
            tracing::debug!(run_id = %run.run_id, "account memory route unavailable; memory off for this run");
            RunMemory::disabled()
        }
        Err(error) => {
            tracing::warn!(run_id = %run.run_id, error = %error, "account memory fetch failed; memory off for this run");
            RunMemory::disabled()
        }
    }
}

/// Scope id of every global memory: global memories belong to the account.
pub const GLOBAL_SCOPE_ID: &str = kordi_tools::reflection_tool::GLOBAL_SCOPE_ID;

/// Scope ids a run reads memories from, shared with the server
/// ([`kordi_tools::memory_prompt::MemoryScopes`]).
pub use kordi_tools::memory_prompt::MemoryScopes as RunMemoryScopes;

/// The run's identity as the shared memory section reads it.
fn memory_run(run: &CloudAgentRun) -> MemoryRun<'_> {
    MemoryRun {
        session_id: &run.session_id,
        subsession_id: run.subsession_id.as_deref(),
        owner_request: run.owner_account_id == run.requester_account_id,
    }
}

/// Scope ids this run reads memories from: its conversation, its execution
/// subsession and its group.
pub fn run_memory_scopes(run: &CloudAgentRun) -> RunMemoryScopes {
    RunMemoryScopes::for_run(&memory_run(run))
}

impl RunnerMemory {
    /// The fields the shared memory section reads.
    pub fn prompt_memory(&self) -> PromptMemory<'_> {
        PromptMemory {
            scope: &self.scope,
            scope_id: &self.scope_id,
            text: &self.text,
            created_at: &self.created_at,
            updated_at: &self.updated_at,
        }
    }
}

/// Whether the run looks memories up with `search_memory` instead of
/// getting them in its system prompt: a proactive run
/// (docs/development/proactive-agent.md), or any run whose lease carries
/// the tool.
pub fn searches_memory(run: &CloudAgentRun) -> bool {
    use crate::proactive::{is_evaluation, APPROVED_RUN_PREFIX, SEARCH_MEMORY_TOOL};
    is_evaluation(&run.run_id)
        || run.run_id.starts_with(APPROVED_RUN_PREFIX)
        || run.connectors.descriptor(SEARCH_MEMORY_TOOL).is_some()
}

/// The `## Memories` system prompt section, or `None` when memory is off or
/// the run searches memories instead ([`searches_memory`]).
pub fn memory_prompt_section(run: &CloudAgentRun, memory: &RunMemory) -> Option<String> {
    if searches_memory(run) {
        return None;
    }
    let memories = memory
        .memories
        .iter()
        .map(RunnerMemory::prompt_memory)
        .collect::<Vec<_>>();
    kordi_tools::memory_prompt::memory_prompt_section(
        &memory_run(run),
        MemorySettings {
            enabled: memory.enabled,
            exclude_sensitive: memory.exclude_sensitive,
        },
        &memories,
    )
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
