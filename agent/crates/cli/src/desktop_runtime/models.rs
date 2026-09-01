//! Stable desktop runtime DTOs shared with UI and command adapters.

use serde::{Deserialize, Serialize};

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatModelOption {
    pub provider: String,
    pub provider_label: String,
    pub value: String,
    pub label: String,
    pub detail: String,
    pub thinking_levels: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatSlashCommand {
    pub label: String,
    pub detail: Option<String>,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopVisibleTaskRecord {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub involved_participants: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatContextMessage {
    pub id: String,
    pub author_name: String,
    pub author_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_role: Option<String>,
    pub text: String,
    pub created_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatStoredTool {
    pub id: String,
    pub name: String,
    pub status: String,
    pub arguments: String,
    pub live_output: String,
    pub result_text: Option<String>,
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_layer: Option<String>,
    pub is_error: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatAttachment {
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionArtifact {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub summary: String,
    pub time_label: Option<String>,
    pub pinned: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatMessage {
    pub role: String,
    pub sender: Option<String>,
    pub text: String,
    pub detail: Option<String>,
    pub time_label: String,
    pub timestamp_ms: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub failed: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub cancelled: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<DesktopChatAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<DesktopChatStoredTool>,
    /// Stable id of the underlying session entry. Present for messages
    /// that map to a canonical entry, including aggregated assistant turns;
    /// `None` only for rows synthesized outside transcript history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatSessionSummary {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub updated_at_label: String,
    pub updated_at_ms: i64,
    pub message_count: usize,
    pub draft: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_message_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatProjectGroup {
    pub id: String,
    pub name: String,
    pub root: String,
    pub summary: String,
    pub background_system: Option<String>,
    pub shared_sources: Vec<DesktopChatProjectSource>,
    pub sessions: Vec<DesktopChatSessionSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatContextWindowStatus {
    pub context_window: u64,
    pub used_tokens: Option<u64>,
    pub used_percent: Option<f64>,
    pub auto_compaction: bool,
    pub compaction_threshold_percent: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatProjectSource {
    pub label: String,
    pub path: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatProjectInfo {
    pub name: String,
    pub root: String,
    pub shared_context: Option<String>,
    pub background_system: Option<String>,
    pub shared_sources: Vec<DesktopChatProjectSource>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatAgentProfile {
    pub label: String,
    pub system_prompt: String,
    pub loaded_skills: Vec<String>,
    pub loaded_tools: Vec<String>,
    pub loaded_plugins: Vec<String>,
    pub identity_files: Vec<String>,
    pub default_provider: String,
    pub default_model: String,
    pub workspace_root: String,
    pub last_activities: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatSessionDetail {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub subtitle: String,
    pub provider: String,
    pub provider_label: String,
    pub model: String,
    pub model_label: String,
    pub thinking: String,
    pub thinking_label: String,
    pub thinking_levels: Vec<String>,
    pub updated_at_label: String,
    pub updated_at_ms: i64,
    pub message_count: usize,
    pub draft: bool,
    pub cache_monitor_text: Option<String>,
    pub context_window_text: String,
    pub context_window_status: DesktopChatContextWindowStatus,
    pub project: Option<DesktopChatProjectInfo>,
    pub reflection_lesson_artifacts: Vec<DesktopSessionArtifact>,
    pub messages: Vec<DesktopChatMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_message_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopForkSessionOutcome {
    pub session_id: String,
    pub source_session_id: String,
    pub source_entry_id: String,
    pub selected_text: String,
    pub branch_leaf_id: Option<String>,
    pub cwd: String,
}
