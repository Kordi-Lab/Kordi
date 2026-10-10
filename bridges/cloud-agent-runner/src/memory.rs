//! Account memories for cloud runs (#1710).
//!
//! The runner reads the run owner's memories once at run start and saves new
//! ones through the `reflection` tool. The server owns the guards and the
//! account setting; the runner only drops the tool and the prompt section
//! when memory is off, and never fails a run because memory is unavailable.

use serde::{Deserialize, Serialize};

use crate::client::{CloudAgentRun, CloudAgentRunClient, HttpCloudAgentRunClient};

pub const MAX_PROMPT_MEMORIES: usize = 40;
pub const MAX_PROMPT_MEMORY_CHARS: usize = 8000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

/// Body of a runner memory save. The HTTP client adds `runnerId`.
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

/// Scope ids this run reads memories from.
///
/// Every run reads the owner's global memories (scope id `account`). The cloud
/// run carries one conversation id, `sessionId` (for example
/// `session:group:<groupId>` or `session:direct-person:<a>:<b>`), plus a
/// `subsessionId` for execution subsessions. Both are conversation scope ids.
/// A group conversation also exposes its group id. Runs carry no project id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunMemoryScopes {
    pub conversation_ids: Vec<String>,
    pub group_id: Option<String>,
    pub project_id: Option<String>,
}

/// Prompt blocks in display order: global first, then the run's scopes.
const PROMPT_BLOCKS: [(&str, &str); 4] = [
    ("global", "Global"),
    ("conversation", "This conversation"),
    ("group", "This group"),
    ("project", "This project"),
];

impl RunMemoryScopes {
    pub fn for_run(run: &CloudAgentRun) -> Self {
        let mut conversation_ids = vec![run.session_id.clone()];
        if let Some(subsession_id) = run.subsession_id.as_ref() {
            if !subsession_id.trim().is_empty() && subsession_id != &run.session_id {
                conversation_ids.push(subsession_id.clone());
            }
        }
        let group_id = run
            .session_id
            .strip_prefix("session:group:")
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string);
        Self {
            conversation_ids,
            group_id,
            project_id: None,
        }
    }

    fn applies(&self, memory: &RunnerMemory) -> bool {
        let scope_id = memory.scope_id.as_str();
        match memory.scope.as_str() {
            "global" => scope_id == GLOBAL_SCOPE_ID,
            "conversation" => self.conversation_ids.iter().any(|id| id == scope_id),
            "group" => self.group_id.as_deref() == Some(scope_id),
            "project" => self.project_id.as_deref() == Some(scope_id),
            _ => false,
        }
    }
}

fn memory_line(memory: &RunnerMemory) -> String {
    let text = memory.text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("- {text}")
}

/// The `## Memories` system prompt section, or `None` when memory is off.
pub fn memory_prompt_section(run: &CloudAgentRun, memory: &RunMemory) -> Option<String> {
    if !memory.enabled {
        return None;
    }
    let scopes = RunMemoryScopes::for_run(run);
    let first = if memory.exclude_sensitive {
        "Memories sync with the account and must not record health, finances, relationships, identity attributes, credentials, or other people's private details."
    } else {
        "Memories sync with the account."
    };
    let mut section = format!(
        "## Memories\n{first} After corrections, repeated failures, or outcomes, call `reflection` to save a concise memory. Before saving, check the memories below and skip anything already there or restated; when a preference changes, save the corrected version. Use `global` only for preferences the user wants everywhere (\"from now on\", \"always\"); keep everything else in its conversation or group scope."
    );
    let mut scope_ids = vec![
        format!("global `{GLOBAL_SCOPE_ID}`"),
        format!("conversation `{}`", run.session_id),
    ];
    if let Some(group_id) = &scopes.group_id {
        scope_ids.push(format!("group `{group_id}`"));
    }
    section.push_str(&format!(
        "\nScope ids for this run: {}.",
        scope_ids.join(", ")
    ));

    let applicable = memory
        .memories
        .iter()
        .filter(|memory| scopes.applies(memory))
        .collect::<Vec<_>>();
    let mut used_chars = 0usize;
    let mut shown = 0usize;
    'blocks: for (scope, heading) in PROMPT_BLOCKS {
        let mut block = applicable
            .iter()
            .filter(|memory| memory.scope == scope)
            .collect::<Vec<_>>();
        block.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.created_at.cmp(&left.created_at))
        });
        let mut wrote_heading = false;
        for memory in block {
            let line = memory_line(memory);
            let chars = line.chars().count() + 1;
            if shown >= MAX_PROMPT_MEMORIES || used_chars + chars > MAX_PROMPT_MEMORY_CHARS {
                break 'blocks;
            }
            if !wrote_heading {
                section.push_str(&format!("\n{heading}:"));
                wrote_heading = true;
            }
            section.push('\n');
            section.push_str(&line);
            used_chars += chars;
            shown += 1;
        }
    }
    if shown < applicable.len() {
        section.push_str("\n(more memories omitted)");
    }
    Some(section)
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
