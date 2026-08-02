//! Stable DTOs exposed by desktop chat commands and internal adapters.

use kordi_cli::desktop_runtime::{
    DesktopChatAgentProfile, DesktopChatModelOption, DesktopChatProjectGroup,
    DesktopChatSessionDetail, DesktopChatSessionSummary, DesktopChatSlashCommand,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopStoredChatAttachment {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub mime_type: Option<String>,
    pub format_label: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatState {
    pub cwd: String,
    pub active_session_id: String,
    pub sessions: Vec<DesktopChatSessionSummary>,
    pub projects: Vec<DesktopChatProjectGroup>,
    pub active_session: DesktopChatSessionDetail,
    pub local_agent: DesktopChatAgentProfile,
    pub model_options: Vec<DesktopChatModelOption>,
    pub slash_commands: Vec<DesktopChatSlashCommand>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatToolSnapshot {
    pub id: String,
    pub name: String,
    pub status: String,
    pub arguments: String,
    pub live_output: String,
    pub result_text: Option<String>,
    pub detail: Option<String>,
    pub artifact_path: Option<String>,
    pub tool_layer: Option<String>,
    pub is_error: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatTurnSnapshot {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub status: String,
    pub message: String,
    pub assistant_text: String,
    pub thinking_text: String,
    pub tools: Vec<DesktopChatToolSnapshot>,
    pub completed: bool,
    pub succeeded: bool,
    pub started_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_entry_id: Option<String>,
    pub error: Option<String>,
    pub transcript_refresh_required: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatMessageRoute {
    pub model: Option<String>,
    pub auth_provider: Option<String>,
    pub auth_choice: Option<String>,
    pub thinking: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatArtifactPreviewLine {
    pub number: usize,
    pub text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatArtifactPreview {
    pub path: String,
    pub lines: Vec<DesktopChatArtifactPreviewLine>,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopArtifactDirectoryEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub is_directory: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopArtifactDirectory {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<DesktopArtifactDirectoryEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatForkSessionResult {
    pub state: DesktopChatState,
    pub forked_session_id: String,
    pub source_session_id: String,
    pub source_message_id: String,
    pub selected_text: String,
    pub canonical_only: bool,
}
