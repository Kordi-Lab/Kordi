use anyhow::{anyhow, Result};
use kordi_cli::desktop_runtime::{
    background_session_for_parent_message, delete_session_forever, DesktopRuntimeProfile,
    DesktopRuntimeSession,
};
use kordi_cli::task_operator::{ChildAgentRunner, SpawnRequest};
use kordi_tools::task_operator::models::TaskOperatorBackgroundSession;
use serde::Deserialize;

use super::super::{message_execution, DesktopChatManager, DesktopChatMessageRoute};
use super::ManagedChildAgentRunner;

const SHARED_TASK_ROUTER_SYSTEM_PROMPT: &str = concat!(
    "You route work requested inside a shared human or group chat. Judge the request before any main-session work begins. Return one JSON object and nothing else. ",
    "Choose background when the work is self-contained, likely extended, and does not need immediate negotiation with the user; examples include research, full reviews, web-plus-repository comparisons, multi-file analysis, builds, and test suites. ",
    "Choose inline for brief answers, clarification, permission, immediate user choices, or work whose next step depends on negotiation in the parent chat. Do not solve the request. Do not apply a rigid duration threshold. ",
    "For a background decision, generate a specific taskTitle, a concise taskSummary, a natural acknowledgement in the local agent's voice, and a self-contained delegatedRequest for the child. Preserve the user's intent without adding work. If the request is ambiguous, use read_session on the supplied source session and retrieve only the messages needed to rewrite it clearly. Never put orchestration instructions in delegatedRequest. ",
    "Make every generated field specific to this request; never use canned copy. Schema: {\"mode\":\"inline|background\",\"taskTitle\":\"short title\",\"taskSummary\":\"concise task summary\",\"acknowledgement\":\"natural parent-channel response\",\"delegatedRequest\":\"self-contained child request\",\"estimatedDuration\":\"brief|extended\",\"coordinationNeeded\":true|false,\"writeScope\":[\"relative/path\"],\"reason\":\"short reason\"}. ",
    "Use an empty writeScope unless the user explicitly asks to modify files."
);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::chat) struct SharedTaskRouteDecision {
    pub mode: String,
    pub task_title: String,
    #[serde(default)]
    pub task_summary: String,
    #[serde(default)]
    pub acknowledgement: String,
    #[serde(default)]
    pub delegated_request: String,
    #[serde(default)]
    pub coordination_needed: bool,
    #[serde(default)]
    pub write_scope: Vec<String>,
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
    decision.task_title = decision.task_title.trim().chars().take(80).collect();
    decision.task_summary = decision
        .task_summary
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(280)
        .collect();
    decision.acknowledgement = decision
        .acknowledgement
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(280)
        .collect();
    decision.delegated_request = decision
        .delegated_request
        .trim()
        .chars()
        .take(2_000)
        .collect();
    if decision.should_run_in_background()
        && (decision.task_title.is_empty()
            || decision.task_summary.is_empty()
            || decision.acknowledgement.is_empty()
            || decision.delegated_request.is_empty())
    {
        return None;
    }
    decision.write_scope = decision
        .write_scope
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| {
            !value.is_empty()
                && !std::path::Path::new(value).is_absolute()
                && !std::path::Path::new(value)
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
        })
        .take(8)
        .collect();
    Some(decision)
}

fn shared_task_router_prompt(
    request: &str,
    source_session_id: &str,
    source_message_id: &str,
) -> String {
    [
        "Route this shared-chat request:".to_string(),
        String::new(),
        request.trim().to_string(),
        String::new(),
        format!("Source session ID: {source_session_id}"),
        format!("Source message ID: {source_message_id}"),
    ]
    .join("\n")
}

pub(in crate::chat) async fn classify_shared_task(
    cwd: &std::path::Path,
    request: &str,
    route: Option<&DesktopChatMessageRoute>,
    source_session_id: &str,
    source_message_id: &str,
) -> Result<SharedTaskRouteDecision> {
    let session_id = format!("shared-task-router:{}", uuid::Uuid::new_v4());
    let profile = DesktopRuntimeProfile {
        system_prompt: Some(SHARED_TASK_ROUTER_SYSTEM_PROMPT.to_string()),
        tool_names: Some(vec![
            "search_sessions".to_string(),
            "read_session".to_string(),
        ]),
        skill_names: Some(Vec::new()),
        ..DesktopRuntimeProfile::default()
    };
    let mut runtime =
        DesktopRuntimeSession::create_profiled_with_id(cwd.to_path_buf(), &session_id, profile)
            .await?;
    runtime.set_session_observation_runtime(Some(
        super::super::session_observation::build_session_observation_runtime(
            Some(source_session_id.to_string()),
            None,
        ),
    ));
    let result = async {
        super::super::apply_desktop_chat_message_route(&mut runtime, route)
            .map_err(anyhow::Error::msg)?;
        let detail = runtime.detail()?;
        super::super::ensure_provider_ready_for_send(&detail.provider, &detail.model, cwd)
            .await
            .map_err(anyhow::Error::msg)?;
        runtime
            .send_message(
                shared_task_router_prompt(request, source_session_id, source_message_id),
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

fn task_name(title: &str, request_id: &str) -> String {
    let mut value = title
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>();
    while value.contains("__") {
        value = value.replace("__", "_");
    }
    value = value.trim_matches('_').chars().take(40).collect();
    let suffix = request_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>();
    format!(
        "{}_{}",
        if value.is_empty() {
            "background_task"
        } else {
            &value
        },
        suffix
    )
}

fn delegated_message(
    decision: &SharedTaskRouteDecision,
    parent_session_id: &str,
    parent_message_id: &str,
) -> String {
    [
        decision.delegated_request.trim().to_string(),
        String::new(),
        format!("Source session ID: {parent_session_id}"),
        format!("Source message ID: {parent_message_id}"),
    ]
    .join("\n")
}

pub(in crate::chat) async fn existing_or_spawn_background_session(
    manager: &DesktopChatManager,
    parent_session_id: &str,
    request_id: &str,
    cwd: &std::path::Path,
    base_profile: DesktopRuntimeProfile,
    decision: &SharedTaskRouteDecision,
    input: &message_execution::StartMessageInput,
) -> Result<TaskOperatorBackgroundSession> {
    if let Some(existing) = background_session_for_parent_message(parent_session_id, request_id)? {
        return Ok(existing);
    }
    let name = task_name(&decision.task_title, request_id);
    let runner =
        ManagedChildAgentRunner::new(manager.clone(), parent_session_id.to_string(), base_profile)
            .with_shared_context(
                true,
                input
                    .context_messages
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .find(|message| message.context_role.as_deref() == Some("resource"))
                    .map(|message| message.text.clone()),
            );
    let spawned = runner
        .spawn(SpawnRequest {
            task_path: format!("/root/{name}"),
            task_name: name,
            task_title: decision.task_title.clone(),
            message: delegated_message(decision, parent_session_id, request_id),
            fork_turns: Some("none".to_string()),
            write_scope: decision.write_scope.clone(),
            cwd: cwd.to_path_buf(),
            parent_message_id: Some(request_id.to_string()),
            attachment_paths: input.attachment_paths.clone().unwrap_or_default(),
        })
        .await?;
    spawned
        .background_session()
        .cloned()
        .ok_or_else(|| anyhow!("Background runner returned no linked session"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_task_router_parses_background_judgment_and_sanitizes_write_scope() {
        let decision = parse_shared_task_route(
            r#"```json
            {"mode":"background","taskTitle":"Review runtime","taskSummary":"Inspect runtime behavior and report the findings.","acknowledgement":"I moved the runtime review into a linked background session and will keep its findings there.","delegatedRequest":"Inspect the runtime behavior and report the findings with evidence.","estimatedDuration":"extended","coordinationNeeded":false,"writeScope":["agent/crates","../outside","/absolute"],"reason":"Multi-phase review"}
            ```"#,
        )
        .expect("route decision");

        assert!(decision.should_run_in_background());
        assert_eq!(decision.task_title, "Review runtime");
        assert_eq!(
            decision.task_summary,
            "Inspect runtime behavior and report the findings."
        );
        assert_eq!(
            decision.acknowledgement,
            "I moved the runtime review into a linked background session and will keep its findings there."
        );
        assert_eq!(
            decision.delegated_request,
            "Inspect the runtime behavior and report the findings with evidence."
        );
        assert_eq!(decision.write_scope, vec!["agent/crates"]);
    }

    #[test]
    fn shared_task_router_rejects_background_routes_without_generated_copy() {
        assert!(parse_shared_task_route(
            r#"{"mode":"background","taskTitle":"Review runtime","coordinationNeeded":false}"#,
        )
        .is_none());
    }

    #[test]
    fn shared_task_router_rejects_unknown_modes() {
        assert!(parse_shared_task_route(r#"{"mode":"later","taskTitle":"Review"}"#).is_none());
    }

    #[test]
    fn delegated_message_uses_session_tools_instead_of_copying_chat_history() {
        let message = delegated_message(
            &SharedTaskRouteDecision {
                mode: "background".to_string(),
                task_title: "Review report".to_string(),
                task_summary: "Review the latest report.".to_string(),
                acknowledgement: "I moved the report review to a linked session.".to_string(),
                delegated_request: "Review the latest report and identify actionable findings."
                    .to_string(),
                coordination_needed: false,
                write_scope: Vec::new(),
            },
            "session:group:one",
            "message:request",
        );

        assert!(message.starts_with("Review the latest report"));
        assert!(message.contains("Source session ID: session:group:one"));
        assert!(message.contains("Source message ID: message:request"));
        assert!(!message.contains("Complete this work"));
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

#[cfg(test)]
mod generated_copy_tests {
    use super::parse_shared_task_route;

    #[test]
    fn every_background_copy_field_is_required_without_a_canned_fallback() {
        let complete = serde_json::json!({"mode": "background", "taskTitle": "Review rollout",
            "taskSummary": "Check the rollout for regressions.", "acknowledgement": "I will check the rollout in a linked task.",
            "delegatedRequest": "Check the rollout for regressions and report evidence."});
        assert!(parse_shared_task_route(&complete.to_string()).is_some());
        for field in [
            "taskTitle",
            "taskSummary",
            "acknowledgement",
            "delegatedRequest",
        ] {
            let mut incomplete = complete.clone();
            incomplete[field] = serde_json::json!("   ");
            assert!(
                parse_shared_task_route(&incomplete.to_string()).is_none(),
                "missing {field}"
            );
        }
    }
}
