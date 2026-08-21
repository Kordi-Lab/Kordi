//! Managed child-agent sessions started by `task_operator.spawn`.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use kordi_cli::desktop_runtime::{
    background_session_for_parent_message, create_background_session, delete_session_forever,
    DesktopChatContextMessage, DesktopRuntimeProfile, DesktopRuntimeSession,
};
use kordi_cli::task_operator::{
    managed_child_prompt_context, managed_child_tool_names, BackgroundSessionInspection,
    ChildAgentRunner, SpawnRequest, SpawnedTask, WaitOutcome,
};
use kordi_tools::task_operator::models::TaskOperatorBackgroundSession;
use serde::Deserialize;
use tokio::sync::Mutex;

use super::{
    cancel_turn_by_id, message_execution, session_has_running_turn, turn_snapshot_by_id,
    DesktopChatManager, DesktopChatMessageRoute,
};

const SHARED_TASK_ROUTER_SYSTEM_PROMPT: &str =
    "You route work requested inside a shared human or group chat. Judge the request before any main-session work begins. Return one JSON object and nothing else. Choose background when the work is self-contained, likely extended, and does not need immediate negotiation with the user; examples include research, full reviews, web-plus-repository comparisons, multi-file analysis, builds, and test suites. Choose inline for brief answers, clarification, permission, immediate user choices, or work whose next step depends on negotiation in the parent chat. Do not solve the request. Do not use tools. Do not apply a rigid duration threshold. Schema: {\"mode\":\"inline|background\",\"taskTitle\":\"short title\",\"estimatedDuration\":\"brief|extended\",\"coordinationNeeded\":true|false,\"writeScope\":[\"relative/path\"],\"reason\":\"short reason\"}. Use an empty writeScope unless the user explicitly asks to modify files.";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct SharedTaskRouteDecision {
    pub mode: String,
    pub task_title: String,
    #[serde(default)]
    pub coordination_needed: bool,
    #[serde(default)]
    pub write_scope: Vec<String>,
}

impl SharedTaskRouteDecision {
    pub(super) fn should_run_in_background(&self) -> bool {
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
    if decision.task_title.is_empty() {
        decision.task_title = "Background task".to_string();
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
    context_messages: &[DesktopChatContextMessage],
) -> String {
    let mut lines = vec![
        "Route this shared-chat request:".to_string(),
        String::new(),
        request.trim().to_string(),
    ];
    if !context_messages.is_empty() {
        lines.push(String::new());
        lines.push("Recent conversation context:".to_string());
        lines.extend(
            context_messages.iter().rev().take(8).rev().map(|message| {
                format!("- {}: {}", message.author_name.trim(), message.text.trim())
            }),
        );
    }
    lines.join("\n")
}

pub(super) async fn classify_shared_task(
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
        super::apply_desktop_chat_message_route(&mut runtime, route).map_err(anyhow::Error::msg)?;
        let detail = runtime.detail()?;
        super::ensure_provider_ready_for_send(&detail.provider, &detail.model, cwd)
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

fn delegated_message(request: &str, context_messages: &[DesktopChatContextMessage]) -> String {
    let mut lines = vec![
        "Complete this work in the linked background session. Keep progress and the final result here; do not wait on or duplicate work in the parent chat.".to_string(),
        String::new(),
        "Original request:".to_string(),
        request.trim().to_string(),
    ];
    if !context_messages.is_empty() {
        lines.push(String::new());
        lines.push("Relevant shared-chat context:".to_string());
        lines.extend(
            context_messages.iter().rev().take(8).rev().map(|message| {
                format!("- {}: {}", message.author_name.trim(), message.text.trim())
            }),
        );
    }
    lines.join("\n")
}

pub(super) async fn existing_or_spawn_background_session(
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
        ManagedChildAgentRunner::new(manager.clone(), parent_session_id.to_string(), base_profile);
    let spawned = runner
        .spawn(SpawnRequest {
            task_path: format!("/root/{name}"),
            task_name: name,
            task_title: decision.task_title.clone(),
            message: delegated_message(
                &input.text,
                input.context_messages.as_deref().unwrap_or_default(),
            ),
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

#[derive(Clone, Debug)]
struct ManagedTask {
    session_id: String,
    turn_id: String,
}

#[derive(Clone)]
pub(super) struct ManagedChildAgentRunner {
    manager: DesktopChatManager,
    parent_session_id: String,
    base_profile: DesktopRuntimeProfile,
    jobs: Arc<Mutex<BTreeMap<String, ManagedTask>>>,
}

impl ManagedChildAgentRunner {
    pub(super) fn new(
        manager: DesktopChatManager,
        parent_session_id: String,
        base_profile: DesktopRuntimeProfile,
    ) -> Self {
        Self {
            manager,
            parent_session_id,
            base_profile,
            jobs: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    fn profile_for(&self, request: &SpawnRequest) -> Result<DesktopRuntimeProfile> {
        if request
            .fork_turns
            .as_deref()
            .map(str::trim)
            .is_some_and(|mode| !mode.is_empty() && mode != "none")
        {
            bail!("Desktop background sessions currently require forkTurns='none'")
        }

        let mut profile = self.base_profile.clone();
        profile.tool_names = Some(managed_child_tool_names(!request.write_scope.is_empty()));
        let child_context = managed_child_prompt_context(
            &request.task_path,
            &request.task_name,
            &request.write_scope,
        );
        profile.system_prompt = Some(match profile.system_prompt.take() {
            Some(base) if !base.trim().is_empty() => format!("{base}\n\n{child_context}"),
            _ => child_context,
        });
        Ok(profile)
    }

    async fn start_turn(
        &self,
        session_id: String,
        message: String,
        attachment_paths: Vec<String>,
    ) -> Result<super::DesktopChatTurnSnapshot> {
        message_execution::start_message(
            &self.manager,
            message_execution::StartMessageInput {
                session_id,
                text: message,
                attachment_paths: Some(attachment_paths),
                route: None,
                context_messages: None,
                visible_task_records: None,
                scheduled_task_session_id: None,
            },
        )
        .await
        .map_err(anyhow::Error::msg)
    }
}

#[async_trait]
impl ChildAgentRunner for ManagedChildAgentRunner {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedTask> {
        let profile = self.profile_for(&request)?;
        let session_id = create_background_session(
            &request.cwd,
            &self.parent_session_id,
            request.parent_message_id.as_deref(),
            &request.task_title,
        )?;
        let runtime =
            match DesktopRuntimeSession::resume_profiled(request.cwd.clone(), &session_id, profile)
                .await
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = delete_session_forever(&session_id);
                    return Err(error);
                }
            };
        self.manager.sessions.lock().await.insert(
            session_id.clone(),
            Arc::new(tokio::sync::Mutex::new(runtime)),
        );

        let turn = match self
            .start_turn(
                session_id.clone(),
                request.message,
                request.attachment_paths,
            )
            .await
        {
            Ok(turn) => turn,
            Err(error) => {
                self.manager.sessions.lock().await.remove(&session_id);
                let _ = delete_session_forever(&session_id);
                return Err(error);
            }
        };
        self.manager
            .background_turn_ids
            .lock()
            .await
            .insert(turn.id.clone());
        self.jobs.lock().await.insert(
            request.task_path.clone(),
            ManagedTask {
                session_id: session_id.clone(),
                turn_id: turn.id.clone(),
            },
        );

        Ok(SpawnedTask::running_in_background_session(
            request.task_path,
            session_id,
            turn.id,
            request.task_title,
        ))
    }

    async fn send(&self, target: &str, message: String) -> Result<()> {
        let task = self
            .jobs
            .lock()
            .await
            .get(target)
            .cloned()
            .ok_or_else(|| anyhow!("background task `{target}` was not found"))?;
        let turn = self
            .start_turn(task.session_id.clone(), message, Vec::new())
            .await?;
        self.manager
            .background_turn_ids
            .lock()
            .await
            .insert(turn.id.clone());
        self.jobs.lock().await.insert(
            target.to_string(),
            ManagedTask {
                session_id: task.session_id,
                turn_id: turn.id,
            },
        );
        Ok(())
    }

    async fn wait(&self, timeout_ms: u64) -> Result<WaitOutcome> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let jobs = self.jobs.lock().await.clone();
            for (target, task) in jobs {
                let Ok(turn) = turn_snapshot_by_id(&self.manager, &task.turn_id).await else {
                    continue;
                };
                if !turn.completed {
                    continue;
                }
                let summary = turn.assistant_text.trim().to_string();
                if turn.succeeded {
                    return Ok(WaitOutcome::Completed { target, summary });
                }
                return Ok(WaitOutcome::Failed {
                    target,
                    summary: turn
                        .error
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(turn.message),
                });
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(WaitOutcome::TimedOut);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn close(&self, target: &str) -> Result<()> {
        let Some(task) = self.jobs.lock().await.remove(target) else {
            bail!("background task `{target}` was not found")
        };
        cancel_turn_by_id(&self.manager, &task.turn_id)
            .await
            .map_err(anyhow::Error::msg)?;
        Ok(())
    }

    async fn inspect(&self, session_id: &str) -> Result<Option<BackgroundSessionInspection>> {
        Ok(session_has_running_turn(&self.manager, session_id)
            .await
            .then(|| BackgroundSessionInspection {
                status: "running".to_string(),
                summary: None,
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_task_router_parses_background_judgment_and_sanitizes_write_scope() {
        let decision = parse_shared_task_route(
            r#"```json
            {"mode":"background","taskTitle":"Review runtime","estimatedDuration":"extended","coordinationNeeded":false,"writeScope":["agent/crates","../outside","/absolute"],"reason":"Multi-phase review"}
            ```"#,
        )
        .expect("route decision");

        assert!(decision.should_run_in_background());
        assert_eq!(decision.task_title, "Review runtime");
        assert_eq!(decision.write_scope, vec!["agent/crates"]);
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

    fn request(fork_turns: Option<&str>, write_scope: Vec<String>) -> SpawnRequest {
        SpawnRequest {
            task_path: "/root/research".to_string(),
            task_name: "research".to_string(),
            task_title: "Research the sources".to_string(),
            message: "Research the sources.".to_string(),
            fork_turns: fork_turns.map(ToString::to_string),
            write_scope,
            cwd: std::path::PathBuf::from("/tmp"),
            parent_message_id: None,
            attachment_paths: Vec::new(),
        }
    }

    #[test]
    fn managed_background_profile_is_isolated_and_scope_aware() {
        let runner = ManagedChildAgentRunner::new(
            DesktopChatManager::default(),
            "parent".to_string(),
            DesktopRuntimeProfile::default(),
        );
        let read_only = runner
            .profile_for(&request(Some("none"), Vec::new()))
            .unwrap();
        let writer = runner
            .profile_for(&request(Some("none"), vec!["src".to_string()]))
            .unwrap();

        assert!(!read_only
            .tool_names
            .unwrap()
            .iter()
            .any(|name| name == "bash"));
        assert!(writer.tool_names.unwrap().iter().any(|name| name == "bash"));
        assert!(runner
            .profile_for(&request(Some("all"), Vec::new()))
            .is_err());
    }
}
