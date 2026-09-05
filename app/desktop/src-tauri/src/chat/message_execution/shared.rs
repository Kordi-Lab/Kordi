use super::*;
use crate::chat::DesktopChatToolSnapshot;

pub(in crate::chat) async fn start_shared_message(
    manager: &DesktopChatManager,
    request_id: String,
    mut input: StartMessageInput,
) -> Result<DesktopChatTurnSnapshot, String> {
    input.shared_context = true;
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() {
        return start_message(manager, input).await;
    }
    let cwd = chat_cwd()?;
    let source_session_id = input
        .scheduled_task_session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(&input.session_id)
        .to_string();
    let decision = match crate::chat::background_tasks::classify_shared_task(
        &cwd,
        &input.text,
        input.route.as_ref(),
        &source_session_id,
        &request_id,
    )
    .await
    {
        Ok(decision) => decision,
        Err(error) => {
            eprintln!("Shared-task routing assessment failed; continuing inline: {error}");
            return start_message(manager, input).await;
        }
    };
    if !decision.should_run_in_background() {
        return start_message(manager, input).await;
    }

    let target_session_id =
        ensure_loaded_or_create_explicit_session(manager, &cwd, input.session_id.clone()).await?;
    let session_handle = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let base_profile = {
        let mut session = session_handle.lock().await;
        apply_desktop_chat_message_route(&mut session, input.route.as_ref())?;
        session
            .sync_visible_task_records(&input.visible_task_records.clone().unwrap_or_default())
            .map_err(|error| error.to_string())?;
        let system_context = input
            .context_messages
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter(|message| message.context_role.as_deref() == Some("system"))
            .cloned()
            .collect::<Vec<_>>();
        session
            .sync_context_messages(&system_context)
            .map_err(|error| error.to_string())?;
        let detail = session.detail().map_err(|error| error.to_string())?;
        let agent = session.agent_profile();
        DesktopRuntimeProfile {
            provider: Some(detail.provider),
            model: Some(detail.model),
            thinking: Some(detail.thinking),
            system_prompt: Some(agent.system_prompt),
            skill_names: Some(agent.loaded_skills),
            ..DesktopRuntimeProfile::default()
        }
    };
    let background_session = crate::chat::background_tasks::existing_or_spawn_background_session(
        manager,
        &source_session_id,
        &request_id,
        &cwd,
        base_profile,
        &decision,
        &input,
    )
    .await
    .map_err(|error| error.to_string())?;
    let background_session_payload = serde_json::json!({
        "sessionId": &background_session.session_id, "turnId": &background_session.turn_id,
        "title": &background_session.title, "summary": &decision.task_summary,
        "status": &background_session.status,
    });
    let result_text = format!(
        "{}\n\nBackground session: {}",
        decision.task_summary,
        serde_json::to_string(&background_session_payload).map_err(|error| error.to_string())?,
    );
    let arguments = serde_json::json!({
        "action": "spawn",
        "task_name": background_session.title,
        "taskTitle": background_session.title,
        "summary": decision.task_summary,
        "message": input.text,
        "forkTurns": "none",
        "writeScope": decision.write_scope,
    })
    .to_string();
    let now = now_millis();
    Ok(DesktopChatTurnSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: target_session_id,
        prompt: input.text.trim().to_string(),
        status: "succeeded".to_string(),
        message: decision.task_summary.clone(),
        assistant_text: decision.acknowledgement.clone(),
        thinking_text: String::new(),
        tools: vec![DesktopChatToolSnapshot {
            id: format!("shared-task-route:{request_id}"),
            name: "task_operator".to_string(),
            status: "completed".to_string(),
            arguments,
            live_output: String::new(),
            result_text: Some(result_text),
            detail: Some(decision.task_summary),
            artifact_path: None,
            tool_layer: Some("operator".to_string()),
            is_error: false,
        }],
        completed: true,
        succeeded: true,
        started_at_ms: now,
        completed_at_ms: Some(now),
        transcript_entry_id: None,
        error: None,
        transcript_refresh_required: false,
    })
}
