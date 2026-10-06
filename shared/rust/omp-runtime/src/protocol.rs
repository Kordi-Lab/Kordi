use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub run_id: String,
    pub request_id: String,
    pub attempt_id: String,
    pub session_id: String,
    pub model: ModelConfig,
    pub auth: AuthConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    pub system_prompt: String,
    /// Structured history ending before `prompt`.
    #[serde(default)]
    pub messages: Vec<Value>,
    /// Stable Kordi entry IDs aligned with `messages`, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_entry_ids: Option<Vec<Option<String>>>,
    pub prompt: Prompt,
    pub cwd: String,
    #[serde(default)]
    pub tools: Vec<ToolDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hooks: Vec<String>,
    #[serde(default)]
    pub limits: RunLimits,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<CompactionSettings>,
    #[serde(default)]
    pub capabilities: Capabilities,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub provider: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    ApiKey,
    Oauth,
    None,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    pub kind: AuthKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub text: String,
    /// Continue an admitted turn from completed message/tool history.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub resume: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageInput>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trailing_messages: Vec<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    #[serde(rename = "type")]
    pub kind: String,
    pub data: String,
    pub mime_type: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLimits {
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
    pub max_tool_calls: usize,
    pub max_steps: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSettings {
    pub enabled: bool,
    pub reserve_tokens: u32,
    pub keep_recent_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold_tokens: Option<u32>,
}

impl Default for RunLimits {
    fn default() -> Self {
        Self {
            timeout_ms: 600_000,
            max_output_bytes: 8 * 1024 * 1024,
            max_tool_calls: 12,
            max_steps: 8,
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    #[serde(default)]
    pub owner_local: bool,
    #[serde(default)]
    pub computer: bool,
    #[serde(default)]
    pub browser: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum WorkerInput<'a> {
    Run {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(flatten)]
        request: &'a RunRequest,
    },
    ToolResult {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "runId")]
        run_id: &'a str,
        #[serde(rename = "attemptId")]
        attempt_id: &'a str,
        #[serde(rename = "callId")]
        call_id: &'a str,
        result: &'a ToolResult,
    },
    HookResult {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "runId")]
        run_id: &'a str,
        #[serde(rename = "attemptId")]
        attempt_id: &'a str,
        #[serde(rename = "callId")]
        call_id: &'a str,
        result: &'a Value,
    },
    Cancel {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "runId")]
        run_id: &'a str,
        #[serde(rename = "attemptId")]
        attempt_id: &'a str,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum WorkerOutput {
    Ready {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
    },
    Event {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        sequence: u64,
        event: RuntimeEvent,
    },
    ToolCall {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        sequence: u64,
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        input: Value,
    },
    HookCall {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        sequence: u64,
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        input: Value,
    },
    Result {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        sequence: u64,
        text: String,
        #[serde(default)]
        messages: Vec<Value>,
        #[serde(default, rename = "contextMessages")]
        context_messages: Vec<Value>,
        #[serde(default)]
        usage: Option<Value>,
        #[serde(default, rename = "stopReason")]
        stop_reason: Option<String>,
        #[serde(default)]
        checkpoint: Option<Checkpoint>,
    },
    Error {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        sequence: u64,
        code: String,
        #[serde(rename = "message")]
        _message: String,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub kind: String,
    #[serde(flatten)]
    pub data: Map<String, Value>,
}

#[derive(Clone)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub ok: bool,
    pub content: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

pub struct RunResult {
    pub text: String,
    pub messages: Vec<Value>,
    pub context_messages: Vec<Value>,
    pub usage: Option<Value>,
    pub stop_reason: Option<String>,
    pub checkpoint: Option<Checkpoint>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub first_kept_message_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_kept_entry_id: Option<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub short_summary: Option<String>,
    #[serde(default)]
    pub tokens_before: u64,
}
