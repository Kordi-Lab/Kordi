//! Background message-turn orchestration behind the stable Tauri command facade.

use std::sync::{Arc, Mutex};

use kordi_cli::desktop_runtime::{
    DesktopChatContextMessage, DesktopChatMessage, DesktopChatSessionDetail,
    DesktopVisibleTaskRecord,
};

use super::{
    agent_builder, apply_desktop_chat_message_route, apply_desktop_turn_event,
    attach_cloud_scheduled_task_runtime_for_session, chat_cwd, desktop_task_tools_from_messages,
    ensure_loaded_or_create_explicit_session, ensure_provider_ready_for_send, now_millis,
    prepare_desktop_session_for_send, reserve_turn_if_session_idle, snapshot_turn,
    sync_completed_desktop_session_to_canonical, turn_snapshot_has_model_task_tools, update_turn,
    DesktopChatManager, DesktopChatMessageRoute, DesktopChatTurnHandle, DesktopChatTurnSnapshot,
};

pub(super) struct StartMessageInput {
    pub session_id: String,
    pub text: String,
    pub attachment_paths: Option<Vec<String>>,
    pub route: Option<DesktopChatMessageRoute>,
    pub context_messages: Option<Vec<DesktopChatContextMessage>>,
    pub visible_task_records: Option<Vec<DesktopVisibleTaskRecord>>,
    pub scheduled_task_session_id: Option<String>,
}

pub(super) async fn start_message(
    manager: &DesktopChatManager,
    input: StartMessageInput,
) -> Result<DesktopChatTurnSnapshot, String> {
    let StartMessageInput {
        session_id,
        text,
        attachment_paths,
        route,
        context_messages,
        visible_task_records,
        scheduled_task_session_id,
    } = input;
    let attachment_paths = attachment_paths.unwrap_or_default();
    if text.trim().is_empty() && attachment_paths.is_empty() {
        return Err("Message is empty".to_string());
    }

    let cwd = chat_cwd()?;
    let target_session_id =
        ensure_loaded_or_create_explicit_session(manager, &cwd, session_id).await?;
    let session_handle = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };

    let turn_id = uuid::Uuid::new_v4().to_string();
    let snapshot = Arc::new(Mutex::new(DesktopChatTurnSnapshot {
        id: turn_id.clone(),
        session_id: target_session_id.clone(),
        prompt: text.trim().to_string(),
        status: "starting".to_string(),
        message: "Working…".to_string(),
        assistant_text: String::new(),
        thinking_text: String::new(),
        tools: Vec::new(),
        completed: false,
        succeeded: false,
        started_at_ms: now_millis(),
        completed_at_ms: None,
        transcript_entry_id: None,
        error: None,
        transcript_refresh_required: false,
    }));
    let cancel = tokio_util::sync::CancellationToken::new();

    if !reserve_turn_if_session_idle(
        manager,
        turn_id,
        DesktopChatTurnHandle {
            snapshot: snapshot.clone(),
            cancel: cancel.clone(),
        },
    )
    .await
    {
        return Err(
            "This session already has a running task. Open another session to work concurrently."
                .to_string(),
        );
    }
    let snapshot_for_task = snapshot.clone();
    let is_agent_builder_session = agent_builder::is_agent_builder_session_id(&target_session_id);
    let manager_for_task = manager.clone();

    tokio::spawn(async move {
        let (provider, model) = {
            let mut session = session_handle.lock().await;
            if let Err(error) = apply_desktop_chat_message_route(&mut session, route.as_ref()) {
                fail_turn(&snapshot_for_task, error);
                return;
            }
            if !is_agent_builder_session {
                attach_cloud_scheduled_task_runtime_for_session(
                    &mut session,
                    scheduled_task_session_id.as_deref(),
                );
                if let Err(error) =
                    session.sync_visible_task_records(&visible_task_records.unwrap_or_default())
                {
                    fail_turn(&snapshot_for_task, error.to_string());
                    return;
                }
                if let Err(error) =
                    session.sync_context_messages(&context_messages.unwrap_or_default())
                {
                    fail_turn(&snapshot_for_task, error.to_string());
                    return;
                }
                prepare_desktop_session_for_send(
                    &manager_for_task,
                    &mut session,
                    cwd.clone(),
                    &text,
                    scheduled_task_session_id.as_deref(),
                )
                .await;
            }

            let detail = session.detail().ok();
            (
                detail
                    .as_ref()
                    .map(|detail| detail.provider.clone())
                    .unwrap_or_default(),
                detail
                    .as_ref()
                    .map(|detail| detail.model.clone())
                    .unwrap_or_default(),
            )
        };

        if let Err(error) = ensure_provider_ready_for_send(&provider, &model, &cwd).await {
            fail_turn(&snapshot_for_task, error);
            return;
        }

        let turn = {
            let mut session = session_handle.lock().await;
            match session
                .begin_message_streaming(text, attachment_paths, cancel.clone())
                .await
            {
                Ok(turn) => turn,
                Err(error) => {
                    fail_chat_request(&snapshot_for_task, error.to_string());
                    return;
                }
            }
        };

        let result = match turn
            .run(|event| apply_desktop_turn_event(&snapshot_for_task, event))
            .await
        {
            Ok(turn_result) => {
                let mut session = session_handle.lock().await;
                session
                    .finish_message_streaming(turn_result)
                    .map_err(|error| error.to_string())
            }
            Err(error) => Err(error.to_string()),
        };

        finish_turn(
            &snapshot_for_task,
            &session_handle,
            &cwd,
            &target_session_id,
            is_agent_builder_session,
            &cancel,
            result,
        )
        .await;
    });

    snapshot_turn(&snapshot)
}

fn fail_turn(snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>, error: String) {
    update_turn(snapshot, |state| {
        state.status = "failed".to_string();
        state.message = error.clone();
        state.completed = true;
        state.completed_at_ms = Some(now_millis());
        state.succeeded = false;
        state.error = Some(error);
    });
}

fn fail_chat_request(snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>, error: String) {
    update_turn(snapshot, |state| {
        state.status = "failed".to_string();
        state.message = "Chat request failed".to_string();
        state.completed = true;
        state.completed_at_ms = Some(now_millis());
        state.succeeded = false;
        state.error = Some(error);
    });
}

fn latest_turn_assistant_entry_id(messages: &[DesktopChatMessage]) -> Option<String> {
    for message in messages.iter().rev() {
        let role = message.role.trim();
        if role.eq_ignore_ascii_case("user") {
            return None;
        }
        if role.eq_ignore_ascii_case("assistant") {
            return message.entry_id.clone();
        }
    }
    None
}

async fn finish_turn(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    session_handle: &super::DesktopSessionHandle,
    cwd: &std::path::Path,
    session_id: &str,
    is_agent_builder_session: bool,
    cancel: &tokio_util::sync::CancellationToken,
    result: Result<DesktopChatSessionDetail, String>,
) {
    match result {
        Ok(detail) if cancel.is_cancelled() => {
            let transcript_entry_id = latest_turn_assistant_entry_id(&detail.messages);
            sync_completed_session(cwd, session_id, session_handle, is_agent_builder_session).await;
            update_turn(snapshot, |state| {
                state.status = "cancelled".to_string();
                state.message = "Response stopped".to_string();
                state.completed = true;
                state.completed_at_ms = Some(now_millis());
                state.transcript_entry_id = transcript_entry_id;
                state.succeeded = false;
                state.error = None;
            });
        }
        Ok(detail) => {
            let transcript_entry_id = latest_turn_assistant_entry_id(&detail.messages);
            sync_completed_session(cwd, session_id, session_handle, is_agent_builder_session).await;
            let task_tools = {
                let session = session_handle.lock().await;
                session
                    .detail()
                    .map(|detail| desktop_task_tools_from_messages(&detail.messages))
                    .unwrap_or_default()
            };
            update_turn(snapshot, |state| {
                if !task_tools.is_empty() && !turn_snapshot_has_model_task_tools(&state.tools) {
                    state.tools = task_tools;
                }
                state.status = "succeeded".to_string();
                state.message = "Response complete".to_string();
                state.completed = true;
                state.completed_at_ms = Some(now_millis());
                state.transcript_entry_id = transcript_entry_id;
                state.succeeded = true;
                state.error = None;
            });
        }
        Err(_) if cancel.is_cancelled() => update_turn(snapshot, |state| {
            state.status = "cancelled".to_string();
            state.message = "Response stopped".to_string();
            state.completed = true;
            state.completed_at_ms = Some(now_millis());
            state.succeeded = false;
            state.error = None;
        }),
        Err(error) => {
            // Provider failures can still persist a terminal assistant entry.
            // Sync that entry before completing the live turn so Cloud receives
            // the failed response immediately instead of leaving a processing
            // placeholder until fallback timeout.
            sync_completed_session(cwd, session_id, session_handle, is_agent_builder_session).await;
            fail_chat_request(snapshot, error);
        }
    }
}

async fn sync_completed_session(
    cwd: &std::path::Path,
    session_id: &str,
    session_handle: &super::DesktopSessionHandle,
    is_agent_builder_session: bool,
) {
    if !is_agent_builder_session {
        sync_completed_desktop_session_to_canonical(cwd, session_id, session_handle).await;
    }
}

#[cfg(test)]
mod tests {
    use super::latest_turn_assistant_entry_id;
    use kordi_cli::desktop_runtime::DesktopChatMessage;

    fn message(role: &str, entry_id: Option<&str>) -> DesktopChatMessage {
        DesktopChatMessage {
            role: role.to_string(),
            sender: None,
            text: String::new(),
            detail: None,
            time_label: String::new(),
            timestamp_ms: 0,
            failed: false,
            cancelled: false,
            attachments: Vec::new(),
            thinking_text: None,
            tools: Vec::new(),
            entry_id: entry_id.map(str::to_string),
        }
    }

    #[test]
    fn current_turn_assistant_entry_id_stops_at_latest_user_boundary() {
        let messages = vec![
            message("assistant", Some("entry:old")),
            message("user", Some("entry:user")),
        ];

        assert_eq!(latest_turn_assistant_entry_id(&messages), None);
    }

    #[test]
    fn current_turn_assistant_entry_id_returns_the_new_reply() {
        let messages = vec![
            message("assistant", Some("entry:old")),
            message("user", Some("entry:user")),
            message("assistant", Some("entry:new")),
        ];

        assert_eq!(
            latest_turn_assistant_entry_id(&messages).as_deref(),
            Some("entry:new")
        );
    }
}
