use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use kordi_core::settings::Settings;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::support::{emit_progress_line, text_result};
use crate::{ReachOutRequest, Tool, ToolContext, ToolMetadata, ToolResult, ToolRiskLevel};

fn default_true() -> bool {
    true
}

fn default_context_policy() -> String {
    "recent-window".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReachOutInput {
    /// Bridge person/agent display name, owner name, node id, human id, or agent id.
    pub target: String,
    /// Optional target kind: bridge-agent or bridge-person.
    pub target_kind: Option<String>,
    /// The question or request to send.
    pub message: String,
    /// Optional extra context to include with the request.
    pub context: Option<String>,
    /// Context-sharing policy for the remote participant.
    #[serde(default = "default_context_policy")]
    pub context_policy: String,
    /// Include concise project context automatically unless explicitly disabled.
    #[serde(default = "default_true")]
    pub include_project_context: bool,
    /// Wait for the remote reply and return it as this tool result.
    #[serde(default = "default_true")]
    pub wait_for_response: bool,
    /// Maximum time to wait for a response. Defaults to the desktop runtime policy.
    pub timeout_seconds: Option<u64>,
}

pub struct ReachOutTool;

#[async_trait]
impl Tool for ReachOutTool {
    fn name(&self) -> &str {
        "reach_out"
    }

    fn description(&self) -> &str {
        "Internal executor for @Person/@Agent participation. Use this when a mentioned or visible connected person/agent may have relevant information. The outreach is always allowed, creates a visible join event in the current session when possible, includes policy-scoped context by default, and can return the remote reply as the tool result."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": "Visible person/agent to contact. May be a display name, owner name, node id, human id, or agent id."
                },
                "targetKind": {
                    "type": "string",
                    "enum": ["bridge-agent", "bridge-person"],
                    "description": "Optional target kind. Use bridge-agent for agent expertise and bridge-person for a human/person."
                },
                "message": {
                    "type": "string",
                    "description": "The question or request to send to the remote target."
                },
                "context": {
                    "type": "string",
                    "description": "Optional extra context to send with the request. Runtime context is included according to session policy unless disabled."
                },
                "contextPolicy": {
                    "type": "string",
                    "enum": ["last-message", "recent-window", "summary", "full-session"],
                    "description": "How much session context to share with the remote participant. Defaults to recent-window."
                },
                "includeProjectContext": {
                    "type": "boolean",
                    "description": "Include concise project context by default. Set false only if the request is unrelated to the current project."
                },
                "waitForResponse": {
                    "type": "boolean",
                    "description": "Wait for the remote response and return it as this tool result. Defaults to true."
                },
                "timeoutSeconds": {
                    "type": "number",
                    "description": "Optional maximum seconds to wait for a response."
                }
            },
            "required": ["target", "message"]
        })
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::operator(ToolRiskLevel::Medium)
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let input: ReachOutInput = serde_json::from_value(params)
            .map_err(|err| KordiError::Tool(format!("Invalid reach_out parameters: {err}")))?;
        validate_input(&input)?;

        let Some(runtime) = ctx.reach_out.clone() else {
            return Err(KordiError::Tool(
                "reach_out is only available in the desktop app when bridge outreach is configured"
                    .to_string(),
            ));
        };

        let context = build_context(&input, ctx);
        let request = ReachOutRequest {
            target: input.target.trim().to_string(),
            target_kind: input
                .target_kind
                .as_ref()
                .map(|value| value.trim().to_ascii_lowercase()),
            message: input.message.trim().to_string(),
            context,
            context_policy: normalize_context_policy(&input.context_policy)?,
            include_project_context: input.include_project_context,
            wait_for_response: input.wait_for_response,
            timeout_seconds: input.timeout_seconds,
            parent_session_id: None,
            parent_turn_id: None,
            parent_message_id: None,
            project_id: None,
            project_name: None,
        };

        emit_progress_line(ctx, format!("Reaching out to {}…", request.target));

        let response = tokio::select! {
            result = (runtime.reach_out)(request) => result?,
            _ = cancel.cancelled() => {
                return Err(KordiError::Tool("reach_out cancelled".to_string()));
            }
        };

        let mut lines = Vec::new();
        lines.push(format!(
            "Outreach conversation: {} ({})",
            response.conversation_id, response.target_display_name
        ));
        lines.push(format!("Status: {}", response.status));
        if let Some(owner) = response
            .target_owner_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            lines.push(format!("Owner: {owner}"));
        }
        if response.timed_out {
            lines.push(
                "Timed out while waiting; the outreach session remains visible and resumable."
                    .to_string(),
            );
        }
        if let Some(text) = response
            .response_text
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            lines.push(String::new());
            lines.push("Remote response:".to_string());
            lines.push(text.to_string());
        } else if !response.timed_out {
            lines.push("No response text was returned yet.".to_string());
        }

        Ok(text_result(lines.join("\n"), Some(json!(response))))
    }
}

fn validate_input(input: &ReachOutInput) -> KordiResult<()> {
    if input.target.trim().is_empty() {
        return Err(KordiError::Tool("reach_out target is required".to_string()));
    }
    if input.message.trim().is_empty() {
        return Err(KordiError::Tool(
            "reach_out message is required".to_string(),
        ));
    }
    let _ = normalize_context_policy(&input.context_policy)?;
    if let Some(kind) = input.target_kind.as_deref() {
        let normalized = kind.trim().to_ascii_lowercase();
        if normalized != "bridge-agent" && normalized != "bridge-person" {
            return Err(KordiError::Tool(
                "reach_out targetKind must be bridge-agent or bridge-person".to_string(),
            ));
        }
    }
    Ok(())
}

fn normalize_context_policy(value: &str) -> KordiResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" => Ok(default_context_policy()),
        "last-message" | "recent-window" | "summary" | "full-session" => Ok(normalized),
        _ => Err(KordiError::Tool(
            "reach_out contextPolicy must be last-message, recent-window, summary, or full-session"
                .to_string(),
        )),
    }
}

fn build_context(input: &ReachOutInput, ctx: &ToolContext) -> Option<String> {
    let mut sections = Vec::new();
    if input.include_project_context
        && let Some(project_context) = build_project_context(ctx)
    {
        sections.push(project_context);
    }
    if let Some(extra) = input
        .context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("Additional context:\n{extra}"));
    }
    (!sections.is_empty()).then(|| sections.join("\n\n"))
}

fn build_project_context(ctx: &ToolContext) -> Option<String> {
    let settings = Settings::load_project(&ctx.cwd);
    let mut lines = Vec::new();
    if let Some(name) = settings
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("Project: {name}"));
    } else if let Some(name) = ctx.cwd.file_name().and_then(|value| value.to_str()) {
        lines.push(format!("Project: {name}"));
    }
    if let Some(context) = settings
        .project_context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("Context: {context}"));
    }
    if let Some(system) = settings
        .project_system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("Standing instruction: {system}"));
    }
    if !settings.project_shared_sources.is_empty() {
        let sources = settings
            .project_shared_sources
            .iter()
            .map(|source| {
                [
                    source.label.as_str(),
                    source.detail.as_deref().unwrap_or(""),
                ]
                .into_iter()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(" — ")
            })
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if !sources.is_empty() {
            lines.push(format!("Shared sources: {}", sources.join("; ")));
        }
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}
