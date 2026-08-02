use std::sync::{Arc, Mutex};

use kordi_cli::desktop_runtime::DesktopRuntimeSession;
use serde::Deserialize;

use super::turns::{desktop_task_tools_from_messages, snapshot_turn, update_turn};
use super::{
    agent_session_cwd, now_millis, DesktopChatManager, DesktopChatTurnSnapshot,
    DesktopSessionHandle,
};

async fn ensure_agent_execution_session(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
) -> Result<(String, DesktopSessionHandle), String> {
    let persisted =
        kordi_cli::desktop_runtime::list_session_summaries(cwd).map_err(|err| err.to_string())?;

    if let Some(session_id) = persisted.first().map(|session| session.id.clone()) {
        let mut sessions = manager.sessions.lock().await;
        if let Some(handle) = sessions.get(&session_id).cloned() {
            return Ok((session_id, handle));
        }
        let runtime = DesktopRuntimeSession::resume(cwd.to_path_buf(), &session_id)
            .await
            .map_err(|err| err.to_string())?;
        let handle = Arc::new(tokio::sync::Mutex::new(runtime));
        sessions.insert(session_id.clone(), handle.clone());
        return Ok((session_id, handle));
    }

    let mut runtime = DesktopRuntimeSession::create_new(cwd.to_path_buf())
        .await
        .map_err(|err| err.to_string())?;
    runtime
        .materialize_session()
        .map_err(|err| err.to_string())?;
    let session_id = runtime.session_id().to_string();
    let handle = Arc::new(tokio::sync::Mutex::new(runtime));
    let mut sessions = manager.sessions.lock().await;
    sessions.insert(session_id.clone(), handle.clone());
    Ok((session_id, handle))
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopAgentModelRouting {
    pub default_model: Option<String>,
    pub default_auth_provider: Option<String>,
    pub default_auth_choice: Option<String>,
    pub fallback_model: Option<String>,
    pub fallback_auth_provider: Option<String>,
    pub fallback_auth_choice: Option<String>,
    pub thinking: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct AgentRunRoute {
    model: Option<String>,
    auth_provider: Option<String>,
    auth_choice: Option<String>,
    thinking: Option<String>,
}

fn normalize_agent_routing_value(value: Option<&String>) -> Option<String> {
    value
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default")
        .map(ToString::to_string)
}

fn agent_route_key(route: &AgentRunRoute) -> Option<(&str, Option<&str>, Option<&str>)> {
    route.model.as_deref().map(|model| {
        (
            model,
            route.auth_provider.as_deref(),
            route.auth_choice.as_deref(),
        )
    })
}

fn should_try_agent_fallback(
    primary: &DesktopChatTurnSnapshot,
    default_route: &AgentRunRoute,
    fallback_route: &AgentRunRoute,
) -> bool {
    !primary.succeeded
        && agent_route_key(fallback_route)
            .is_some_and(|fallback| Some(fallback) != agent_route_key(default_route))
}

async fn run_agent_prompt_once(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    prompt: String,
    attachment_paths: Vec<String>,
    route: AgentRunRoute,
) -> Result<DesktopChatTurnSnapshot, String> {
    let (target_session_id, session) = ensure_agent_execution_session(manager, cwd).await?;
    let execution_session_id = target_session_id.clone();

    let started_at_ms = now_millis();
    let snapshot = Arc::new(Mutex::new(DesktopChatTurnSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: target_session_id,
        prompt: prompt.trim().to_string(),
        status: "processing".to_string(),
        message: "Processing…".to_string(),
        assistant_text: String::new(),
        thinking_text: String::new(),
        tools: Vec::new(),
        completed: false,
        succeeded: false,
        started_at_ms,
        completed_at_ms: None,
        transcript_entry_id: None,
        error: None,
        transcript_refresh_required: false,
    }));

    let result = {
        let mut session = session.lock().await;
        let setup_result = (|| -> Result<(), String> {
            if let Some(model) = route.model.as_deref() {
                session
                    .set_model(model)
                    .map_err(|error| error.to_string())?;
            }
            if let (Some(auth_provider), Some(auth_choice)) =
                (route.auth_provider.as_deref(), route.auth_choice.as_deref())
            {
                session
                    .set_auth_choice(auth_provider, auth_choice)
                    .map_err(|error| error.to_string())?;
            }
            if let Some(thinking) = route.thinking.as_deref() {
                session
                    .set_thinking(thinking)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })();

        match setup_result {
            Ok(()) => session
                .send_message(prompt, attachment_paths)
                .await
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        }
    };

    match result {
        Ok(detail) => {
            let assistant = detail
                .messages
                .iter()
                .rev()
                .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
                .cloned();
            let task_tools = desktop_task_tools_from_messages(&detail.messages);
            update_turn(&snapshot, |state| {
                state.status = "complete".to_string();
                state.message = "Response complete".to_string();
                state.completed = true;
                state.completed_at_ms = Some(now_millis());
                state.succeeded = assistant.is_some();
                if let Some(message) = assistant {
                    state.assistant_text = message.text;
                    state.thinking_text = message.thinking_text.unwrap_or_default();
                    state.tools = task_tools;
                } else {
                    state.status = "failed".to_string();
                    state.message = "Agent returned no text response".to_string();
                    state.error = Some("Agent returned no text response".to_string());
                }
            });
        }
        Err(message) => {
            update_turn(&snapshot, |state| {
                state.status = "failed".to_string();
                state.message = message.clone();
                state.completed = true;
                state.completed_at_ms = Some(now_millis());
                state.succeeded = false;
                state.error = Some(message.clone());
            });
        }
    }

    {
        let mut sessions = manager.sessions.lock().await;
        sessions.remove(&execution_session_id);
    }
    drop(session);
    let _ = kordi_cli::desktop_runtime::delete_session_forever(&execution_session_id);

    snapshot_turn(&snapshot)
}

pub(crate) async fn run_agent_prompt(
    manager: &DesktopChatManager,
    local_agent_node_id: &str,
    peer_node_id: &str,
    prompt: String,
    attachment_paths: Vec<String>,
    routing: Option<DesktopAgentModelRouting>,
) -> Result<DesktopChatTurnSnapshot, String> {
    let cwd = agent_session_cwd(local_agent_node_id, peer_node_id)?;
    let routing = routing.unwrap_or_default();
    let default_model = normalize_agent_routing_value(routing.default_model.as_ref());
    let fallback_model = normalize_agent_routing_value(routing.fallback_model.as_ref());
    let thinking = normalize_agent_routing_value(routing.thinking.as_ref());
    let default_route = AgentRunRoute {
        model: default_model.clone(),
        auth_provider: normalize_agent_routing_value(routing.default_auth_provider.as_ref()),
        auth_choice: normalize_agent_routing_value(routing.default_auth_choice.as_ref()),
        thinking: thinking.clone(),
    };
    let fallback_route = AgentRunRoute {
        model: fallback_model.clone(),
        auth_provider: normalize_agent_routing_value(routing.fallback_auth_provider.as_ref()),
        auth_choice: normalize_agent_routing_value(routing.fallback_auth_choice.as_ref()),
        thinking,
    };

    let primary = run_agent_prompt_once(
        manager,
        &cwd,
        prompt.clone(),
        attachment_paths.clone(),
        default_route.clone(),
    )
    .await?;

    if !should_try_agent_fallback(&primary, &default_route, &fallback_route) {
        return Ok(primary);
    }

    run_agent_prompt_once(manager, &cwd, prompt, attachment_paths, fallback_route).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_tool(id: &str, name: &str) -> kordi_cli::desktop_runtime::DesktopChatStoredTool {
        stored_tool_with_arguments(id, name, "{}")
    }

    fn stored_tool_with_arguments(
        id: &str,
        name: &str,
        arguments: &str,
    ) -> kordi_cli::desktop_runtime::DesktopChatStoredTool {
        kordi_cli::desktop_runtime::DesktopChatStoredTool {
            id: id.to_string(),
            name: name.to_string(),
            status: "done".to_string(),
            arguments: arguments.to_string(),
            live_output: String::new(),
            result_text: Some("done".to_string()),
            detail: None,
            artifact_path: None,
            tool_layer: Some("operator".to_string()),
            is_error: false,
        }
    }

    fn chat_message(
        role: &str,
        text: &str,
        tools: Vec<kordi_cli::desktop_runtime::DesktopChatStoredTool>,
    ) -> kordi_cli::desktop_runtime::DesktopChatMessage {
        kordi_cli::desktop_runtime::DesktopChatMessage {
            role: role.to_string(),
            sender: None,
            text: text.to_string(),
            detail: None,
            time_label: "10:00".to_string(),
            timestamp_ms: 1,
            failed: false,
            cancelled: false,
            attachments: Vec::new(),
            thinking_text: None,
            tools,
            entry_id: None,
        }
    }

    #[test]
    fn agent_task_tools_include_tools_from_earlier_assistant_messages() {
        let messages = vec![
            chat_message(
                "assistant",
                "",
                vec![stored_tool("tool-create", "task_operator")],
            ),
            chat_message("assistant", "Created the task.", Vec::new()),
        ];

        let tools = desktop_task_tools_from_messages(&messages);

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "task_operator");
    }

    #[test]
    fn agent_task_tools_only_include_latest_turn_tools() {
        let messages = vec![
            chat_message("user", "create old task", Vec::new()),
            chat_message(
                "assistant",
                "",
                vec![stored_tool_with_arguments(
                    "tool-old",
                    "task_operator",
                    "{\"taskTitle\":\"Old Task\"}",
                )],
            ),
            chat_message("assistant", "Created old task.", Vec::new()),
            chat_message("user", "create new task", Vec::new()),
            chat_message(
                "assistant",
                "",
                vec![stored_tool_with_arguments(
                    "tool-new",
                    "task_operator",
                    "{\"taskTitle\":\"New Task\"}",
                )],
            ),
            chat_message("assistant", "Created new task.", Vec::new()),
        ];

        let tools = desktop_task_tools_from_messages(&messages);

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "tool-new");
        assert!(tools[0].arguments.contains("New Task"));
    }

    #[test]
    fn agent_task_tools_do_not_cross_latest_user_boundary_when_current_turn_has_none() {
        let mut first_failed_tool = stored_tool("tool-old-1", "read");
        first_failed_tool.status = "error".to_string();
        first_failed_tool.is_error = true;
        let mut second_failed_tool = stored_tool("tool-old-2", "bash");
        second_failed_tool.status = "error".to_string();
        second_failed_tool.is_error = true;
        let messages = vec![
            chat_message("user", "run the old request", Vec::new()),
            chat_message(
                "assistant",
                "The old request failed.",
                vec![first_failed_tool, second_failed_tool],
            ),
            chat_message("user", "hihi", Vec::new()),
            chat_message("assistant", "Hi hi! 👋", Vec::new()),
        ];

        let tools = desktop_task_tools_from_messages(&messages);

        assert!(tools.is_empty());
    }

    #[test]
    fn agent_task_tools_retain_failed_tools_from_current_turn() {
        let mut current_failed_tool = stored_tool("tool-current", "read");
        current_failed_tool.status = "error".to_string();
        current_failed_tool.is_error = true;
        let messages = vec![
            chat_message("user", "run the old request", Vec::new()),
            chat_message("assistant", "Old response", Vec::new()),
            chat_message("user", "run the current request", Vec::new()),
            chat_message(
                "assistant",
                "The current request failed.",
                vec![current_failed_tool],
            ),
        ];

        let tools = desktop_task_tools_from_messages(&messages);

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "tool-current");
        assert!(tools[0].is_error);
    }

    #[test]
    fn agent_fallback_route_distinguishes_auth_choice_from_default_route() {
        let primary = DesktopChatTurnSnapshot {
            id: "turn-1".to_string(),
            session_id: "session-1".to_string(),
            prompt: "Run it".to_string(),
            status: "failed".to_string(),
            message: "default auth failed".to_string(),
            assistant_text: String::new(),
            thinking_text: String::new(),
            tools: Vec::new(),
            completed: true,
            succeeded: false,
            started_at_ms: 1,
            completed_at_ms: Some(2),
            transcript_entry_id: None,
            error: Some("default auth failed".to_string()),
            transcript_refresh_required: false,
        };
        let default_route = AgentRunRoute {
            model: Some("gpt-5".to_string()),
            auth_provider: Some("openai".to_string()),
            auth_choice: Some("oauth:primary".to_string()),
            thinking: Some("medium".to_string()),
        };
        let fallback_route = AgentRunRoute {
            model: Some("gpt-5".to_string()),
            auth_provider: Some("openai".to_string()),
            auth_choice: Some("api-key:fallback".to_string()),
            thinking: Some("medium".to_string()),
        };

        assert!(should_try_agent_fallback(
            &primary,
            &default_route,
            &fallback_route
        ));
    }
}
