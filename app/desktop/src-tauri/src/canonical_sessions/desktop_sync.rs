use rusqlite::{Connection, OptionalExtension};

use super::core::hash_hex;
use super::message_reconcile;
use super::models::{AppendCanonicalMessageRequest, OpenCanonicalSessionRequest};
use super::sanitization::sanitize_shared_agent_response_text_with_conn;
use super::{
    local_agent_identity_id, local_profile_human_identity_id, open_db,
    open_or_create_session_in_db, select_session, similar_agent_message_exists,
    similar_agent_message_text,
};

fn canonical_desktop_message_source_event_id(
    session_id: &str,
    index: usize,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> String {
    let role = message.role.trim().to_lowercase();
    if role != "user" {
        return format!("desktop-chat:{session_id}:{index}:{role}:turn");
    }

    format!(
        "desktop-chat:{}:{}:{}:{}:{}",
        session_id,
        index,
        message.timestamp_ms,
        role,
        hash_hex(&message.text, 8)
    )
}

fn should_skip_desktop_runtime_status_message(
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> bool {
    let role = message.role.trim().to_lowercase();
    if role != "system" {
        return false;
    }
    let text = message.text.trim();
    text.starts_with("Switched model to ") || text.starts_with("Thinking set to ")
}

pub(super) fn should_skip_shared_local_agent_runtime_prompt(
    session_id: &str,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> bool {
    if !session_id.starts_with("session:bridge:") {
        return false;
    }
    if !message.role.trim().eq_ignore_ascii_case("user") {
        return false;
    }
    message.text.trim_start().starts_with("@Kordi")
}

fn content_with_desktop_runtime(
    content_json: Option<&str>,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<serde_json::Value, String> {
    let mut content = content_json
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));

    if let Some(object) = content.as_object_mut() {
        object.remove("deliveryState");
        object.remove("error");
    }

    if let Some(thinking_text) = message.thinking_text.as_deref() {
        if !thinking_text.trim().is_empty() {
            content["thinkingText"] = serde_json::Value::String(thinking_text.to_string());
        }
    }
    if !message.tools.is_empty() {
        content["tools"] = serde_json::to_value(&message.tools).map_err(|err| err.to_string())?;
    }
    content["role"] = serde_json::Value::String(message.role.clone());
    if let Some(sender) = message.sender.as_deref() {
        content["sender"] = serde_json::Value::String(sender.to_string());
    }
    if let Some(detail) = message.detail.as_deref() {
        content["detail"] = serde_json::Value::String(detail.to_string());
    }
    content["timeLabel"] = serde_json::Value::String(message.time_label.clone());
    content["timestampMs"] = serde_json::Value::Number(message.timestamp_ms.into());
    if !message.attachments.is_empty() {
        content["attachments"] =
            serde_json::to_value(&message.attachments).map_err(|err| err.to_string())?;
    }

    Ok(content)
}

fn update_message_with_desktop_runtime(
    conn: &Connection,
    message_id: &str,
    content_text: &str,
    content_json: Option<&str>,
    status: &str,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<(), String> {
    let content = content_with_desktop_runtime(content_json, message)?;
    let content_string = content.to_string();
    let content_hash = hash_hex(&format!("{}|{}", content_text, content_string), 16);
    conn.execute(
        "UPDATE session_messages
         SET content_text = ?2,
             content_json = ?3,
             status = ?4,
             created_at_ms = ?5,
             updated_at_ms = MAX(updated_at_ms, ?5),
             content_hash = ?6
         WHERE id = ?1",
        rusqlite::params![
            message_id,
            content_text,
            content_string,
            status,
            message.timestamp_ms,
            content_hash,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn enrich_similar_bridge_agent_message_with_desktop_runtime(
    conn: &Connection,
    session_id: &str,
    content_text: &str,
    created_at_ms: i64,
    match_window_ms: i64,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, content_json, content_text
             FROM session_messages
             WHERE session_id = ?1
               AND message_kind = 'agent-turn'
               AND sender_role IN ('owned-agent', 'external-agent')
               AND source_transport = 'desktop-bridge-session-relay'
               AND ABS(created_at_ms - ?2) <= ?3
             ORDER BY ABS(created_at_ms - ?2) ASC, sequence_num DESC",
        )
        .map_err(|err| err.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params![
            session_id,
            created_at_ms,
            match_window_ms
        ])
        .map_err(|err| err.to_string())?;
    let mut match_record: Option<(String, Option<String>)> = None;
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let candidate_text: String = row.get(2).map_err(|err| err.to_string())?;
        if similar_agent_message_text(&candidate_text, content_text) {
            match_record = Some((
                row.get::<_, String>(0).map_err(|err| err.to_string())?,
                row.get::<_, Option<String>>(1)
                    .map_err(|err| err.to_string())?,
            ));
            break;
        }
    }
    let Some((message_id, content_json)) = match_record else {
        return Ok(false);
    };

    update_message_with_desktop_runtime(
        conn,
        &message_id,
        content_text,
        content_json.as_deref(),
        "complete",
        message,
    )?;
    Ok(true)
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn reconcile_processing_bridge_agent_placeholder_with_desktop_runtime(
    conn: &Connection,
    session_id: &str,
    content_text: &str,
    created_at_ms: i64,
    match_window_ms: i64,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<bool, String> {
    let Some((message_id, content_json)) = conn
        .query_row(
            "SELECT id, content_json
             FROM session_messages
             WHERE session_id = ?1
               AND message_kind = 'agent-turn'
               AND sender_role = 'owned-agent'
               AND source_transport = 'desktop-bridge-session-relay'
               AND lower(trim(content_text)) IN ('processing', 'processing.', 'processing..', 'processing...', 'processing…')
               AND ABS(created_at_ms - ?2) <= ?3
             ORDER BY created_at_ms DESC, sequence_num DESC
             LIMIT 1",
            rusqlite::params![session_id, created_at_ms, match_window_ms],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?
    else {
        return Ok(false);
    };

    update_message_with_desktop_runtime(
        conn,
        &message_id,
        content_text,
        content_json.as_deref(),
        "complete",
        message,
    )?;
    Ok(true)
}

fn sync_desktop_chat_message(
    conn: &Connection,
    session_id: &str,
    human_identity_id: &str,
    agent_identity_id: &str,
    index: usize,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<(), String> {
    if should_skip_desktop_runtime_status_message(message)
        || should_skip_shared_local_agent_runtime_prompt(session_id, message)
    {
        return Ok(());
    }
    let normalized_role = message.role.trim().to_lowercase();
    let is_user = normalized_role == "user";
    let is_system = normalized_role == "system";
    let is_agent = !is_user && !is_system;
    let sender_identity_id = if is_user {
        human_identity_id
    } else {
        agent_identity_id
    };
    let sender_role = if is_user {
        "user"
    } else if is_system {
        "system"
    } else {
        "owned-agent"
    };
    let message_kind = if is_system {
        "system"
    } else if is_agent || message.thinking_text.is_some() || !message.tools.is_empty() {
        "agent-turn"
    } else {
        "text"
    };

    let content_text = if is_agent {
        sanitize_shared_agent_response_text_with_conn(conn, Some(session_id), &message.text, &[])?
    } else {
        message.text.clone()
    };

    if is_agent {
        if reconcile_processing_bridge_agent_placeholder_with_desktop_runtime(
            conn,
            session_id,
            &content_text,
            message.timestamp_ms,
            30_000,
            message,
        )? {
            return Ok(());
        }

        if similar_agent_message_exists(
            conn,
            session_id,
            &content_text,
            "desktop-bridge-session-relay",
            message.timestamp_ms,
            30_000,
        )? {
            let _ = enrich_similar_bridge_agent_message_with_desktop_runtime(
                conn,
                session_id,
                &content_text,
                message.timestamp_ms,
                30_000,
                message,
            )?;
            return Ok(());
        }
    }

    let request = AppendCanonicalMessageRequest {
        id: None,
        session_id: session_id.to_string(),
        sender_identity_id: sender_identity_id.to_string(),
        sender_role: sender_role.to_string(),
        message_kind: message_kind.to_string(),
        content_text: content_text.clone(),
        content: Some(serde_json::json!({
            "role": message.role,
            "sender": message.sender,
            "detail": message.detail,
            "timeLabel": message.time_label,
            "timestampMs": message.timestamp_ms,
            "attachments": message.attachments,
            "thinkingText": message.thinking_text.as_deref(),
            "tools": message.tools,
        })),
        created_at_ms: Some(message.timestamp_ms),
        parent_message_id: None,
        delegated_exchange_id: None,
        status: Some(if is_agent { "complete" } else { "sent" }.to_string()),
        source_transport: Some("desktop-chat".to_string()),
        source_event_id: Some(canonical_desktop_message_source_event_id(
            session_id, index, message,
        )),
    };
    message_reconcile::append_or_reconcile_message_from_sync(
        conn,
        request,
        if is_user {
            "desktop-chat-ui"
        } else {
            "desktop-chat"
        },
        5_000,
    )?;
    Ok(())
}

pub(super) fn should_sync_desktop_chat_summary(
    summary: &kordi_cli::desktop_runtime::DesktopChatSessionSummary,
) -> bool {
    !(summary.draft && summary.message_count == 0)
}

pub(super) fn should_sync_desktop_chat_detail(
    detail: &kordi_cli::desktop_runtime::DesktopChatSessionDetail,
) -> bool {
    !(detail.draft && detail.message_count == 0 && detail.messages.is_empty())
}

pub(super) fn should_update_desktop_session_shell(
    conn: &Connection,
    session_id: &str,
) -> Result<bool, String> {
    let Some(session) = select_session(conn, session_id)? else {
        return Ok(true);
    };
    let source = session
        .metadata
        .as_ref()
        .and_then(|value| value.get("source"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if session.id.starts_with("session:bridge:")
        || source.starts_with("desktop-bridge")
        || source.starts_with("bridge-")
        || matches!(
            session.kind.as_str(),
            "direct-person" | "direct-agent" | "relationship"
        )
    {
        return Ok(false);
    }
    Ok(true)
}

pub(super) fn explicit_desktop_project_membership(
    state: &crate::chat::DesktopChatState,
    session_id: &str,
) -> Option<(String, String, String)> {
    state.projects.iter().find_map(|project| {
        project
            .sessions
            .iter()
            .any(|session| session.id == session_id)
            .then(|| {
                (
                    project.id.clone(),
                    project.name.clone(),
                    project.root.clone(),
                )
            })
    })
}

pub(crate) fn sync_desktop_chat_state(state: &crate::chat::DesktopChatState) -> Result<(), String> {
    let conn = open_db()?;
    let human_identity_id = local_profile_human_identity_id(&conn, "You")?;
    let agent_identity_id = local_agent_identity_id(
        &conn,
        &human_identity_id,
        &state.local_agent.label,
        &state.local_agent.workspace_root,
    )?;

    for summary in state
        .sessions
        .iter()
        .filter(|summary| should_sync_desktop_chat_summary(summary))
    {
        if !should_update_desktop_session_shell(&conn, &summary.id)? {
            continue;
        }
        open_or_create_session_in_db(
            &conn,
            OpenCanonicalSessionRequest {
                id: Some(summary.id.clone()),
                kind: "self-agent".to_string(),
                title: Some(summary.title.clone()),
                status: Some(if summary.draft { "draft" } else { "active" }.to_string()),
                created_by_identity_id: human_identity_id.clone(),
                primary_identity_id: Some(agent_identity_id.clone()),
                project_id: None,
                project_name: None,
                relationship_identity_id: None,
                participant_identity_ids: vec![agent_identity_id.clone()],
                metadata: Some(serde_json::json!({
                    "source": "desktop-chat-summary",
                    "subtitle": summary.subtitle,
                    "updatedAtLabel": summary.updated_at_label,
                    "messageCount": summary.message_count,
                })),
            },
        )?;
    }

    for project in &state.projects {
        for summary in project
            .sessions
            .iter()
            .filter(|summary| should_sync_desktop_chat_summary(summary))
        {
            open_or_create_session_in_db(
                &conn,
                OpenCanonicalSessionRequest {
                    id: Some(summary.id.clone()),
                    kind: "project".to_string(),
                    title: Some(summary.title.clone()),
                    status: Some(if summary.draft { "draft" } else { "active" }.to_string()),
                    created_by_identity_id: human_identity_id.clone(),
                    primary_identity_id: Some(agent_identity_id.clone()),
                    project_id: Some(project.id.clone()),
                    project_name: Some(project.name.clone()),
                    relationship_identity_id: None,
                    participant_identity_ids: vec![agent_identity_id.clone()],
                    metadata: Some(serde_json::json!({
                        "source": "desktop-project-summary",
                        "projectRoot": project.root,
                        "subtitle": summary.subtitle,
                        "updatedAtLabel": summary.updated_at_label,
                        "messageCount": summary.message_count,
                    })),
                },
            )?;
        }
    }

    let active = &state.active_session;
    if should_sync_desktop_chat_detail(active) {
        let explicit_project = explicit_desktop_project_membership(state, &active.id);
        let (project_id, project_name, project_root) = explicit_project
            .as_ref()
            .map(|(project_id, project_name, project_root)| {
                (
                    Some(project_id.clone()),
                    Some(project_name.clone()),
                    Some(project_root.clone()),
                )
            })
            .unwrap_or((None, None, None));
        let workspace_root = active.project.as_ref().map(|project| project.root.clone());
        if should_update_desktop_session_shell(&conn, &active.id)? {
            open_or_create_session_in_db(
                &conn,
                OpenCanonicalSessionRequest {
                    id: Some(active.id.clone()),
                    kind: if explicit_project.is_some() {
                        "project".to_string()
                    } else {
                        "self-agent".to_string()
                    },
                    title: Some(active.title.clone()),
                    status: Some(if active.draft { "draft" } else { "active" }.to_string()),
                    created_by_identity_id: human_identity_id.clone(),
                    primary_identity_id: Some(agent_identity_id.clone()),
                    project_id,
                    project_name,
                    relationship_identity_id: None,
                    participant_identity_ids: vec![agent_identity_id.clone()],
                    metadata: Some(serde_json::json!({
                        "source": "desktop-chat-detail",
                        "provider": active.provider,
                        "providerLabel": active.provider_label,
                        "model": active.model,
                        "modelLabel": active.model_label,
                        "thinking": active.thinking,
                        "thinkingLabel": active.thinking_label,
                        "projectRoot": project_root,
                        "workspaceRoot": workspace_root,
                    })),
                },
            )?;
        }

        for (index, message) in active.messages.iter().enumerate() {
            sync_desktop_chat_message(
                &conn,
                &active.id,
                &human_identity_id,
                &agent_identity_id,
                index,
                message,
            )?;
        }
    }

    Ok(())
}
