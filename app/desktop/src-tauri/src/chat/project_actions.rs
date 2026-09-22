use super::*;

#[tauri::command]
pub async fn desktop_chat_new_project_session(
    manager: State<'_, DesktopChatManager>,
    project_root: String,
    title: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let resolved_project_root = resolve_project_root_input(&cwd, &project_root)?;
    kordi_cli::desktop_runtime::register_project(&resolved_project_root, None)
        .map_err(|err| err.to_string())?;

    let mut runtime = DesktopRuntimeSession::create_new(resolved_project_root.clone())
        .await
        .map_err(|err| err.to_string())?;
    attach_cloud_scheduled_task_runtime(&mut runtime);
    runtime
        .materialize_session()
        .map_err(|err| err.to_string())?;
    if let Some(title) = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        runtime
            .set_auto_name(title)
            .map_err(|err| err.to_string())?;
    }
    let session_id = runtime.session_id().to_string();
    kordi_cli::desktop_runtime::move_session_to_project(&session_id, &resolved_project_root)
        .map_err(|err| err.to_string())?;

    {
        let mut sessions = manager.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            Arc::new(tokio::sync::Mutex::new(runtime)),
        );
    }

    build_chat_state(&manager, &cwd, session_id).await
}

#[tauri::command]
pub async fn desktop_project_prepare_remote_session(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
) -> Result<(), String> {
    if session_id.trim().is_empty()
        || session_id.len() > 256
        || agent_builder::is_agent_builder_session_id(&session_id)
    {
        return Err("Invalid project session.".into());
    }
    let cwd = chat_cwd()?;
    let id = ensure_loaded_or_create_explicit_session(&manager, &cwd, session_id).await?;
    let runtime = manager
        .sessions
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or("Session is unavailable")?;
    runtime
        .lock()
        .await
        .materialize_session()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn desktop_chat_move_session_to_project(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    project_root: String,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    if agent_builder::is_agent_builder_session_id(session_id.trim()) {
        return Err("Agent Builder conversations stay with their private draft.".to_string());
    }
    let target = resolve_existing_session_action_target(&session_id)?;
    if session_has_running_turn(&manager, &target.id).await {
        return Err("Stop the running task before moving this session.".to_string());
    }
    if !target.local_exists {
        return Err("Only local chat sessions can be moved to a project.".to_string());
    }

    if project_root.trim().is_empty() {
        kordi_cli::desktop_runtime::remove_session_from_project(&target.id, &cwd)
            .map_err(|err| err.to_string())?;
    } else {
        let resolved_project_root = resolve_project_root_input(&cwd, &project_root)?;
        kordi_cli::desktop_runtime::register_project(&resolved_project_root, None)
            .map_err(|err| err.to_string())?;
        kordi_cli::desktop_runtime::move_session_to_project(&target.id, &resolved_project_root)
            .map_err(|err| err.to_string())?;
    }
    manager.sessions.lock().await.remove(&target.id);
    build_chat_state(&manager, &cwd, target.id).await
}
