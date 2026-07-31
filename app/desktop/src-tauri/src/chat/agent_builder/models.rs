//! Serialized command DTOs and internal Agent Builder records.

use kordi_cli::desktop_runtime::DesktopChatSessionDetail;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentBuilderSkillSeed {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentBuilderSeed {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub source_summary: String,
    #[serde(default)]
    pub boundaries: Vec<String>,
    #[serde(default)]
    pub access: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub plugins: Vec<String>,
    #[serde(default)]
    pub skills: Vec<DesktopAgentBuilderSkillSeed>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DesktopAgentBuilderMetadata {
    pub(super) draft_id: String,
    pub(super) target_key: String,
    pub(super) session_id: String,
    pub(super) status: String,
    pub(super) created_at_ms: i64,
    pub(super) updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct DesktopAgentBuilderModelFile {
    #[serde(default)]
    pub(super) provider: Option<String>,
    #[serde(default)]
    pub(super) model: Option<String>,
    #[serde(default)]
    pub(super) thinking: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct DesktopAgentBuilderSkillFile {
    pub(super) name: String,
    #[serde(default)]
    pub(super) description: String,
    #[serde(default)]
    pub(super) path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct DesktopAgentBuilderAgentFile {
    pub(super) name: String,
    #[serde(default)]
    pub(super) role: String,
    #[serde(default)]
    pub(super) description: String,
    #[serde(default)]
    pub(super) source_summary: String,
    #[serde(default)]
    pub(super) boundaries: Vec<String>,
    #[serde(default)]
    pub(super) model: DesktopAgentBuilderModelFile,
    #[serde(default)]
    pub(super) access: String,
    #[serde(default)]
    pub(super) tools: Vec<String>,
    #[serde(default)]
    pub(super) plugins: Vec<String>,
    #[serde(default)]
    pub(super) skills: Vec<DesktopAgentBuilderSkillFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentBuilderSkillDraft {
    pub name: String,
    pub description: String,
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentBuilderDraft {
    pub name: String,
    pub role: String,
    pub description: String,
    pub system_prompt: String,
    pub source_summary: String,
    pub boundaries: Vec<String>,
    pub access: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub tools: Vec<String>,
    pub plugins: Vec<String>,
    pub skills: Vec<DesktopAgentBuilderSkillDraft>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentBuilderFileStatus {
    pub path: String,
    pub kind: String,
    pub valid: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentBuilderValidation {
    pub valid: bool,
    pub fingerprint: String,
    pub errors: Vec<String>,
    pub files: Vec<DesktopAgentBuilderFileStatus>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentBuilderTestReport {
    pub passed: bool,
    pub fingerprint: String,
    pub summary: String,
    pub tested_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentBuilderStatus {
    pub draft_id: String,
    pub target_key: String,
    pub session_id: String,
    pub workspace_path: String,
    pub lifecycle: String,
    pub draft: Option<DesktopAgentBuilderDraft>,
    pub validation: DesktopAgentBuilderValidation,
    pub test_report: Option<DesktopAgentBuilderTestReport>,
    pub publish_ready: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAgentBuilderOpenResult {
    pub status: DesktopAgentBuilderStatus,
    pub session: DesktopChatSessionDetail,
}
