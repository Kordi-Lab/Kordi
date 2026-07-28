use std::path::Path;

use kordi_cli::desktop_runtime::{DesktopChatAgentProfile, DesktopChatSessionDetail};

use super::{DesktopChatState, DesktopSessionHandle};

pub(super) const CLOUD_AGENT_RUNTIME_SESSION_PREFIX: &str = "cloud-agent:";

pub(super) fn is_cloud_agent_runtime_session_id(session_id: &str) -> bool {
    session_id.starts_with(CLOUD_AGENT_RUNTIME_SESSION_PREFIX)
}

pub(super) fn desktop_chat_message_is_agent(
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> bool {
    let role = message.role.trim().to_lowercase();
    role != "user" && role != "system"
}

fn completed_desktop_session_state_for_canonical_sync(
    cwd: &Path,
    active_session_id: &str,
    active_session: DesktopChatSessionDetail,
    local_agent: DesktopChatAgentProfile,
) -> DesktopChatState {
    DesktopChatState {
        cwd: cwd.display().to_string(),
        active_session_id: active_session_id.to_string(),
        sessions: Vec::new(),
        projects: Vec::new(),
        active_session,
        local_agent,
        model_options: Vec::new(),
        slash_commands: Vec::new(),
    }
}

pub(super) async fn sync_completed_desktop_session_to_canonical(
    cwd: &Path,
    active_session_id: &str,
    session: &DesktopSessionHandle,
) {
    if is_cloud_agent_runtime_session_id(active_session_id) {
        return;
    }

    let snapshot = {
        let session = session.lock().await;
        match session.detail() {
            Ok(detail) => Some((detail, session.agent_profile())),
            Err(error) => {
                eprintln!(
                    "Unable to load completed desktop chat detail for canonical sync: {error}"
                );
                None
            }
        }
    };

    let Some((active_session, local_agent)) = snapshot else {
        return;
    };
    let state = completed_desktop_session_state_for_canonical_sync(
        cwd,
        active_session_id,
        active_session,
        local_agent,
    );
    if let Err(error) = crate::canonical_sessions::sync_desktop_chat_state(&state) {
        eprintln!("Unable to sync completed desktop chat into canonical sessions: {error}");
    }
}

pub(super) fn desktop_state_for_canonical_sync(
    state: &DesktopChatState,
    active_turn_running: bool,
) -> DesktopChatState {
    let mut next = state.clone();
    next.sessions
        .retain(|session| !is_cloud_agent_runtime_session_id(&session.id));

    if is_cloud_agent_runtime_session_id(&next.active_session_id) || !active_turn_running {
        return next;
    }

    let Some(last_user_index) = state
        .active_session
        .messages
        .iter()
        .rposition(|message| message.role.trim().eq_ignore_ascii_case("user"))
    else {
        return next;
    };

    next.active_session.messages = state
        .active_session
        .messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            (!(index > last_user_index && desktop_chat_message_is_agent(message)))
                .then(|| message.clone())
        })
        .collect();
    next.active_session.message_count = next.active_session.messages.len();
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_cli::desktop_runtime::{
        DesktopChatContextWindowStatus, DesktopChatMessage, DesktopChatSessionSummary,
    };

    #[test]
    fn desktop_canonical_sync_state_omits_active_agent_tail_while_live_turn_runs() {
        let mut state = DesktopChatState {
            cwd: "/tmp/workspace".to_string(),
            active_session_id: "session:local".to_string(),
            sessions: vec![DesktopChatSessionSummary {
                id: "session:local".to_string(),
                title: "Check disk".to_string(),
                subtitle: "Check disk".to_string(),
                updated_at_label: "Now".to_string(),
                updated_at_ms: 2,
                message_count: 2,
                draft: false,
                forked_from_session_id: None,
                forked_from_message_id: None,
            }],
            projects: Vec::new(),
            active_session: DesktopChatSessionDetail {
                id: "session:local".to_string(),
                cwd: "/tmp/workspace".to_string(),
                title: "Check disk".to_string(),
                subtitle: "Check disk".to_string(),
                provider: "openai".to_string(),
                provider_label: "OpenAI".to_string(),
                model: "gpt-5".to_string(),
                model_label: "gpt-5".to_string(),
                thinking: "medium".to_string(),
                thinking_label: "Medium".to_string(),
                thinking_levels: Vec::new(),
                updated_at_label: "Now".to_string(),
                updated_at_ms: 2,
                message_count: 2,
                draft: false,
                cache_monitor_text: None,
                context_window_text: "0 / 0".to_string(),
                context_window_status: DesktopChatContextWindowStatus {
                    context_window: 0,
                    used_tokens: None,
                    used_percent: None,
                    auto_compaction: false,
                    compaction_threshold_percent: 90,
                },
                project: None,
                reflection_lesson_artifacts: Vec::new(),
                forked_from_session_id: None,
                forked_from_message_id: None,
                messages: vec![
                    DesktopChatMessage {
                        role: "user".to_string(),
                        sender: Some("You".to_string()),
                        text: "check disk".to_string(),
                        detail: None,
                        time_label: "Now".to_string(),
                        timestamp_ms: 1,
                        failed: false,
                        cancelled: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                        entry_id: None,
                    },
                    DesktopChatMessage {
                        role: "assistant".to_string(),
                        sender: Some("Kordi".to_string()),
                        text: "I’ll check disk usage.".to_string(),
                        detail: Some("openai/gpt-5 • tool use".to_string()),
                        time_label: "Now".to_string(),
                        timestamp_ms: 2,
                        failed: false,
                        cancelled: false,
                        attachments: Vec::new(),
                        thinking_text: Some("Checking disk usage".to_string()),
                        tools: Vec::new(),
                        entry_id: None,
                    },
                ],
            },
            local_agent: DesktopChatAgentProfile {
                label: "Kordi".to_string(),
                system_prompt: String::new(),
                loaded_skills: Vec::new(),
                loaded_tools: Vec::new(),
                loaded_plugins: Vec::new(),
                identity_files: Vec::new(),
                default_provider: "openai".to_string(),
                default_model: "gpt-5".to_string(),
                workspace_root: "/tmp/workspace".to_string(),
                last_activities: Vec::new(),
            },
            model_options: Vec::new(),
            slash_commands: Vec::new(),
        };

        let sync_state = desktop_state_for_canonical_sync(&state, true);
        assert_eq!(sync_state.active_session.messages.len(), 1);
        assert_eq!(sync_state.active_session.messages[0].role, "user");

        state.active_session.messages.push(DesktopChatMessage {
            role: "system".to_string(),
            sender: None,
            text: "Session note".to_string(),
            detail: None,
            time_label: "Now".to_string(),
            timestamp_ms: 3,
            failed: false,
            cancelled: false,
            attachments: Vec::new(),
            thinking_text: None,
            tools: Vec::new(),
            entry_id: None,
        });
        let completed_sync_state = desktop_state_for_canonical_sync(&state, false);
        assert_eq!(completed_sync_state.active_session.messages.len(), 3);
    }

    #[test]
    fn completed_desktop_session_sync_state_preserves_agent_runtime_details() {
        let detail = DesktopChatSessionDetail {
            id: "session:bridge:humans:test".to_string(),
            cwd: "/tmp/workspace".to_string(),
            title: "Check repo".to_string(),
            subtitle: "Check repo".to_string(),
            provider: "openai".to_string(),
            provider_label: "OpenAI".to_string(),
            model: "gpt-5.5".to_string(),
            model_label: "gpt-5.5".to_string(),
            thinking: "medium".to_string(),
            thinking_label: "Medium".to_string(),
            thinking_levels: Vec::new(),
            updated_at_label: "Now".to_string(),
            updated_at_ms: 2,
            message_count: 2,
            draft: false,
            cache_monitor_text: None,
            context_window_text: "0 / 0".to_string(),
            context_window_status: DesktopChatContextWindowStatus {
                context_window: 0,
                used_tokens: None,
                used_percent: None,
                auto_compaction: false,
                compaction_threshold_percent: 90,
            },
            project: None,
            reflection_lesson_artifacts: Vec::new(),
            forked_from_session_id: None,
            forked_from_message_id: None,
            messages: vec![
                DesktopChatMessage {
                    role: "user".to_string(),
                    sender: Some("You".to_string()),
                    text: "@Kordi check again".to_string(),
                    detail: None,
                    time_label: "Now".to_string(),
                    timestamp_ms: 1,
                    failed: false,
                    cancelled: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                    entry_id: None,
                },
                DesktopChatMessage {
                    role: "assistant".to_string(),
                    sender: Some("Kordi".to_string()),
                    text: "Checked again.".to_string(),
                    detail: Some("openai/gpt-5.5 • tool use".to_string()),
                    time_label: "Now".to_string(),
                    timestamp_ms: 2,
                    failed: false,
                    cancelled: false,
                    attachments: Vec::new(),
                    thinking_text: Some("Need to re-check the repo".to_string()),
                    tools: vec![kordi_cli::desktop_runtime::DesktopChatStoredTool {
                        id: "tool-1".to_string(),
                        name: "web_fetch".to_string(),
                        status: "complete".to_string(),
                        arguments: "{}".to_string(),
                        live_output: String::new(),
                        result_text: Some("repo page".to_string()),
                        detail: None,
                        artifact_path: None,
                        tool_layer: Some("observation".to_string()),
                        is_error: false,
                    }],
                    entry_id: None,
                },
            ],
        };
        let local_agent = DesktopChatAgentProfile {
            label: "Kordi".to_string(),
            system_prompt: String::new(),
            loaded_skills: Vec::new(),
            loaded_tools: Vec::new(),
            loaded_plugins: Vec::new(),
            identity_files: Vec::new(),
            default_provider: "openai".to_string(),
            default_model: "gpt-5".to_string(),
            workspace_root: "/tmp/workspace".to_string(),
            last_activities: Vec::new(),
        };

        let sync_state = completed_desktop_session_state_for_canonical_sync(
            Path::new("/tmp/workspace"),
            "session:bridge:humans:test",
            detail,
            local_agent,
        );

        let assistant = sync_state
            .active_session
            .messages
            .iter()
            .find(|message| message.role == "assistant")
            .expect("assistant message is retained after completion");
        assert_eq!(
            assistant.thinking_text.as_deref(),
            Some("Need to re-check the repo")
        );
        assert_eq!(assistant.tools.len(), 1);
    }
}
