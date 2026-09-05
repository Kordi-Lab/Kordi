use super::super::DesktopChatMessageRoute;
use anyhow::{anyhow, Result};
use kordi_cli::desktop_runtime::{
    delete_session_forever, DesktopChatContextMessage, DesktopRuntimeProfile, DesktopRuntimeSession,
};
use serde::Deserialize;

const SHARED_TASK_ROUTER_SYSTEM_PROMPT: &str =
    "You route work requested inside a shared human or group chat. Return one JSON object and nothing else. Choose background for self-contained extended research, reviews, builds, or test suites: progress and the final result stay in a linked message thread, not in the main conversation. Choose inline for brief answers, clarification, permission, immediate user choices, or when the user explicitly asks to keep the reply in the main conversation. Do not solve the request or use tools. Schema: {\"mode\":\"inline|background\",\"coordinationNeeded\":true|false}.";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::chat) struct SharedTaskRouteDecision {
    pub mode: String,
    #[serde(default)]
    pub coordination_needed: bool,
}

impl SharedTaskRouteDecision {
    pub(in crate::chat) fn should_run_in_background(&self) -> bool {
        self.mode.trim().eq_ignore_ascii_case("background") && !self.coordination_needed
    }
}

fn parse_shared_task_route(text: &str) -> Option<SharedTaskRouteDecision> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end < start {
        return None;
    }
    let mut decision = serde_json::from_str::<SharedTaskRouteDecision>(&text[start..=end]).ok()?;
    decision.mode = decision.mode.trim().to_ascii_lowercase();
    if !matches!(decision.mode.as_str(), "inline" | "background") {
        return None;
    }
    Some(decision)
}

fn shared_task_router_prompt(
    request: &str,
    context_messages: &[DesktopChatContextMessage],
) -> String {
    let mut lines = vec![
        "Route this shared-chat request:".to_string(),
        String::new(),
        request.trim().to_string(),
    ];
    let history = context_messages
        .iter()
        .filter(|message| message.context_role.as_deref() != Some("system"))
        .collect::<Vec<_>>();
    if !history.is_empty() {
        lines.push(String::new());
        lines.push("Recent conversation context:".to_string());
        lines.extend(
            history.into_iter().rev().take(8).rev().map(|message| {
                format!("- {}: {}", message.author_name.trim(), message.text.trim())
            }),
        );
    }
    lines.join("\n")
}

pub(in crate::chat) async fn classify_shared_task(
    cwd: &std::path::Path,
    request: &str,
    route: Option<&DesktopChatMessageRoute>,
    context_messages: &[DesktopChatContextMessage],
) -> Result<SharedTaskRouteDecision> {
    let session_id = format!("shared-task-router:{}", uuid::Uuid::new_v4());
    let profile = DesktopRuntimeProfile {
        system_prompt: Some(SHARED_TASK_ROUTER_SYSTEM_PROMPT.to_string()),
        tool_names: Some(Vec::new()),
        skill_names: Some(Vec::new()),
        ..DesktopRuntimeProfile::default()
    };
    let mut runtime =
        DesktopRuntimeSession::create_profiled_with_id(cwd.to_path_buf(), &session_id, profile)
            .await?;
    let result = async {
        super::super::apply_desktop_chat_message_route(&mut runtime, route)
            .map_err(anyhow::Error::msg)?;
        let detail = runtime.detail()?;
        super::super::ensure_provider_ready_for_send(&detail.provider, &detail.model, cwd)
            .await
            .map_err(anyhow::Error::msg)?;
        runtime
            .send_message(
                shared_task_router_prompt(request, context_messages),
                Vec::new(),
            )
            .await
    }
    .await;
    let _ = delete_session_forever(&session_id);
    let detail = result?;
    let response = detail
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
        .map(|message| message.text.as_str())
        .ok_or_else(|| anyhow!("Shared-task router returned no decision"))?;
    parse_shared_task_route(response)
        .ok_or_else(|| anyhow!("Shared-task router returned an invalid decision"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_task_router_parses_background_judgment() {
        let decision = parse_shared_task_route(
            r#"```json
            {"mode":"background","taskTitle":"Review runtime","estimatedDuration":"extended","coordinationNeeded":false,"writeScope":["agent/crates","../outside","/absolute"],"reason":"Multi-phase review"}
            ```"#,
        )
        .expect("route decision");

        assert!(decision.should_run_in_background());
    }

    #[test]
    fn shared_task_router_rejects_unknown_modes() {
        assert!(parse_shared_task_route(r#"{"mode":"later","taskTitle":"Review"}"#).is_none());
    }

    #[test]
    fn shared_task_router_keeps_negotiation_dependent_work_inline() {
        let decision = parse_shared_task_route(
            r#"{"mode":"background","taskTitle":"Choose migration","coordinationNeeded":true}"#,
        )
        .expect("route decision");

        assert!(!decision.should_run_in_background());
    }
}
