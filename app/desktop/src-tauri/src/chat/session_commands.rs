use super::*;

#[tauri::command]
pub async fn desktop_chat_new_session(
    manager: State<'_, DesktopChatManager>,
    independent: Option<bool>,
    source_session_id: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let session_id = if independent.unwrap_or(false) {
        let mut runtime =
            kordi_cli::desktop_runtime::DesktopRuntimeSession::create_new(cwd.clone())
                .await
                .map_err(|error| error.to_string())?;
        runtime
            .materialize_session()
            .map_err(|error| error.to_string())?;
        let id = runtime.session_id().to_string();
        crate::canonical_sessions::initialize_private_side_session(
            &id,
            source_session_id.as_deref(),
            &cwd.to_string_lossy(),
        )?;
        attach_cloud_scheduled_task_runtime(&mut runtime);
        manager
            .sessions
            .lock()
            .await
            .insert(id.clone(), Arc::new(tokio::sync::Mutex::new(runtime)));
        id
    } else {
        materialize_transient_draft_runtime(&manager, &cwd).await?
    };
    build_chat_state(&manager, &cwd, session_id).await
}

#[tauri::command]
pub async fn desktop_chat_prepare_draft_session(
    manager: State<'_, DesktopChatManager>,
) -> Result<(), String> {
    let cwd = chat_cwd()?;
    ensure_transient_draft_runtime(&manager, &cwd).await?;
    Ok(())
}

#[tauri::command]
pub async fn desktop_chat_update_session_config(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    model: Option<String>,
    thinking: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target_session_id =
        ensure_loaded_or_create_explicit_session(&manager, &cwd, session_id).await?;
    if agent_builder::is_agent_builder_session_id(&target_session_id) {
        return Err(
            "Agent Builder uses the authenticated runtime default and a fixed safety profile."
                .to_string(),
        );
    }
    if target_session_id != TRANSIENT_LOCAL_DRAFT_SESSION_ID
        && session_has_running_turn(&manager, &target_session_id).await
    {
        return Err(
            "Stop the running task before changing this session's model or thinking level."
                .to_string(),
        );
    }
    let session = if target_session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        ensure_transient_draft_runtime(&manager, &cwd).await?
    } else {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let mut session = session.lock().await;
    if target_session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        if let Some(model) = model.as_deref() {
            session.set_model(model).map_err(|err| err.to_string())?;
        }
        if let Some(thinking) = thinking.as_deref() {
            session
                .set_thinking(thinking)
                .map_err(|err| err.to_string())?;
        }
    } else {
        session
            .set_explicit_config(model.as_deref(), thinking.as_deref())
            .map_err(|err| err.to_string())?;
    }
    drop(session);

    build_chat_state(&manager, &cwd, target_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_rename_session(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    name: String,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target_session_id = ensure_loaded_session(&manager, &cwd, Some(session_id)).await?;
    let session = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let mut session = session.lock().await;
    session.set_name(&name).map_err(|err| err.to_string())?;
    drop(session);

    build_chat_state(&manager, &cwd, target_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_archive_session(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    active_session_id: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    if agent_builder::is_agent_builder_session_id(session_id.trim()) {
        return Err("Discard Agent Builder drafts from Agent Studio.".to_string());
    }
    let target = resolve_existing_session_action_target(&session_id)?;
    if session_has_running_turn(&manager, &target.id).await {
        return Err("Stop the running task before hiding this session.".to_string());
    }

    if target.local_exists {
        kordi_cli::desktop_runtime::hide_session(&target.id).map_err(|err| err.to_string())?;
    }
    manager.sessions.lock().await.remove(&target.id);
    if target.canonical_exists {
        crate::canonical_sessions::archive_session(&target.id)?;
    }

    let fallback_active_session_id = if active_session_id.as_deref() == Some(target.id.as_str()) {
        None
    } else {
        active_session_id
    };
    let next_active_session_id =
        resolve_session_action_fallback_target(&cwd, fallback_active_session_id)?;
    build_chat_state(&manager, &cwd, next_active_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_delete_session_forever(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    active_session_id: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    if agent_builder::is_agent_builder_session_id(session_id.trim()) {
        return Err("Discard Agent Builder drafts from Agent Studio.".to_string());
    }
    let target = resolve_existing_session_action_target(&session_id)?;
    if session_has_running_turn(&manager, &target.id).await {
        return Err("Stop the running task before deleting this session.".to_string());
    }

    {
        let mut turns = manager.turns.lock().await;
        turns.retain(|_, turn| {
            turn.snapshot
                .lock()
                .map(|snapshot| snapshot.session_id != target.id)
                .unwrap_or(true)
        });
    }
    manager.sessions.lock().await.remove(&target.id);

    if target.local_exists {
        kordi_cli::desktop_runtime::delete_session_forever(&target.id)
            .map_err(|err| err.to_string())?;
    }
    if target.canonical_exists {
        crate::canonical_sessions::delete_session(&target.id)?;
    }

    let fallback_active_session_id = if active_session_id.as_deref() == Some(target.id.as_str()) {
        None
    } else {
        active_session_id
    };
    let next_active_session_id =
        resolve_session_action_fallback_target(&cwd, fallback_active_session_id)?;
    build_chat_state(&manager, &cwd, next_active_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_fork_session_from_message(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    message_entry_id: String,
) -> Result<DesktopChatForkSessionResult, String> {
    let trimmed_session_id = session_id.trim();
    let trimmed_entry_id = message_entry_id.trim();
    if trimmed_session_id.is_empty() {
        return Err("Source session id is required".to_string());
    }
    if trimmed_entry_id.is_empty() {
        return Err("Source message id is required".to_string());
    }
    if trimmed_session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        return Err("Save the draft session before forking from it.".to_string());
    }
    if agent_builder::is_agent_builder_session_id(trimmed_session_id) {
        return Err("Agent Builder conversations cannot be forked.".to_string());
    }

    let cwd = chat_cwd()?;
    // Route by where the clicked entry actually lives. We can't infer
    // this from the session id alone: for hosted sessions the local
    // kordi_session store mirrors self-agent chats into the canonical
    // `session_messages` table for sync, so a plain-uuid session id
    // can still surface canonical-format message ids in the
    // transcript. The old `starts_with("session:")` heuristic only
    // matched canonical group/bridge ids and silently routed those
    // mirrored sessions through the local fork path, where the
    // canonical `msg:*` entry id is never present and the operation
    // failed with "Entry not found".
    let canonical_message_id = crate::canonical_sessions::canonical_session_message_id_for_entry(
        trimmed_session_id,
        trimmed_entry_id,
    )?;
    let canonical_entry_match = canonical_message_id.is_some();
    let local_session_exists =
        !canonical_entry_match && session_exists_globally(trimmed_session_id)?;
    if !canonical_entry_match && !local_session_exists {
        return Err(format!("Session not found: {trimmed_session_id}"));
    }

    // Canonical Agent entries snapshot through the canonical
    // path. Purely-local sessions without canonical mirroring use the
    // kordi_session fork-from-entry path. Both produce a local fork
    // the user continues from.
    let outcome = if canonical_entry_match {
        crate::canonical_sessions::fork_canonical_session_into_local_chat(
            trimmed_session_id,
            canonical_message_id
                .as_deref()
                .expect("canonical entry match always has a canonical message id"),
            Some(trimmed_entry_id),
            &cwd.display().to_string(),
        )?
    } else {
        kordi_cli::desktop_runtime::fork_session_from_message(trimmed_session_id, trimmed_entry_id)
            .map_err(|err| err.to_string())?
    };

    let mut runtime = kordi_cli::desktop_runtime::DesktopRuntimeSession::resume(
        std::path::PathBuf::from(&outcome.cwd),
        &outcome.session_id,
    )
    .await
    .map_err(|err| err.to_string())?;
    attach_cloud_scheduled_task_runtime(&mut runtime);

    {
        let mut sessions = manager.sessions.lock().await;
        sessions.insert(
            outcome.session_id.clone(),
            Arc::new(tokio::sync::Mutex::new(runtime)),
        );
    }

    let state = build_chat_state(&manager, &cwd, outcome.session_id.clone()).await?;
    Ok(DesktopChatForkSessionResult {
        state,
        forked_session_id: outcome.session_id,
        source_session_id: outcome.source_session_id,
        source_message_id: outcome.source_entry_id,
        selected_text: outcome.selected_text,
        canonical_only: false,
    })
}
