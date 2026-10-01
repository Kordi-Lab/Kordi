use rusqlite::{params, Connection, OptionalExtension};

use super::core::hash_hex;
use super::desktop_runtime_status;
use super::message_reconcile;
use super::models::{AppendCanonicalMessageRequest, OpenCanonicalSessionRequest};
use super::sanitization::sanitize_shared_agent_response_text_with_conn;
use super::{
    canonical_message_exists, local_agent_identity_id, local_profile_human_identity_id, open_db,
    open_or_create_session_in_db, select_session, similar_agent_message_exists,
    similar_agent_message_text,
};

mod cloud_reconcile;
mod message_enrichment;
mod session_metadata;

pub(crate) use message_enrichment::*;
pub(crate) use session_metadata::*;
mod message_role;
mod user_identity;

pub(crate) fn sync_desktop_chat_message(
    conn: &Connection,
    session_id: &str,
    human_identity_id: &str,
    agent_identity_id: &str,
    index: usize,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
    reply_to_message_id: Option<&str>,
) -> Result<Option<String>, String> {
    if message_role::should_skip_status_message(message)
        || should_skip_shared_local_agent_runtime_prompt(session_id, message)
    {
        return Ok(None);
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
    let message_kind = if is_system && message.text.trim().starts_with("Switched model to ") {
        "agent-model-change"
    } else if is_system {
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

    let canonical_reply_to_message_id = is_agent
        .then(|| {
            reply_to_message_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .flatten();

    // Enrich the durable Cloud reply before suppressing a second outbound turn.
    if is_agent {
        if let Some(cloud_message_id) =
            cloud_reconcile::reconcile_cloud_self_agent_message_with_desktop_runtime(
                conn,
                session_id,
                canonical_reply_to_message_id.as_deref(),
                &content_text,
                message,
            )?
        {
            return Ok(Some(cloud_message_id));
        }
    }

    if is_user {
        if let Some(entry_id) = message.entry_id.as_deref() {
            let existing: Option<(String, Option<String>)> = conn.query_row(
                "SELECT id, source_transport FROM session_messages WHERE session_id = ?1 AND sender_role = 'user'
                 AND (id = ?2 OR (source_transport = 'cloud-self-agent' AND source_event_id = ?2))
                 ORDER BY (source_transport = 'cloud-self-agent' AND source_event_id = ?2) DESC LIMIT 1",
                params![session_id, entry_id], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional().map_err(|error| error.to_string())?;
            if let Some((id, source_transport)) = existing {
                if source_transport.as_deref() == Some("cloud-self-agent") {
                    user_identity::reconcile_native_user_mirrors(conn, session_id, &id, entry_id)?;
                }
                user_identity::enrich_runtime_entry_id(conn, &id, entry_id)?;
                return Ok(Some(id));
            }
        }
    }
    if is_agent {
        if let Some(parent_id) = canonical_reply_to_message_id.as_deref() {
            let cloud_owned =
                cloud_reconcile::request_uses_cloud_executor(conn, session_id, parent_id)?;
            // The owner executor publishes this exact request's terminal reply.
            // Importing the native transcript as a second outbound turn would
            // duplicate both the cloud reply and its request.
            if cloud_owned {
                return Ok(None);
            }
        }
    }

    if let Some(snapshot_message_id) = matching_fork_snapshot_message_id(
        conn,
        session_id,
        sender_identity_id,
        sender_role,
        message_kind,
        &content_text,
        message.timestamp_ms,
    )? {
        return Ok(Some(snapshot_message_id));
    }

    if is_agent {
        if reconcile_processing_bridge_agent_placeholder_with_desktop_runtime(
            conn,
            session_id,
            &content_text,
            message.timestamp_ms,
            30_000,
            message,
        )? {
            return Ok(None);
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
            return Ok(None);
        }
    }

    let request = AppendCanonicalMessageRequest {
        id: None,
        session_id: session_id.to_string(),
        sender_identity_id: sender_identity_id.to_string(),
        sender_role: sender_role.to_string(),
        message_kind: message_kind.to_string(),
        content_text: content_text.clone(),
        content: Some(content_with_desktop_runtime(
            None,
            message,
            canonical_reply_to_message_id.as_deref(),
        )?),
        created_at_ms: Some(message.timestamp_ms),
        parent_message_id: canonical_reply_to_message_id,
        delegated_exchange_id: None,
        status: Some(
            if is_agent {
                desktop_runtime_status::status(message)
            } else {
                "sent"
            }
            .to_string(),
        ),
        source_transport: Some("desktop-chat".to_string()),
        source_event_id: Some(canonical_desktop_message_source_event_id(
            session_id, index, message,
        )),
    };
    let synced = message_reconcile::append_or_reconcile_message_from_sync(
        conn,
        request,
        if is_user {
            "desktop-chat-ui"
        } else {
            "desktop-chat"
        },
        5_000,
    )?;
    Ok(Some(synced.id))
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
    let runtime_settings = kordi_core::settings::Settings::load_global();
    let runtime_conn = kordi_session::store::open_db(&kordi_core::config::session_db_path(
        &runtime_settings.storage,
    ))
    .ok();

    for summary in state
        .sessions
        .iter()
        .filter(|summary| should_sync_desktop_chat_summary(summary))
    {
        if !should_update_desktop_session_shell(&conn, &summary.id)? {
            continue;
        }
        let metadata = metadata_with_fork(
            &conn,
            Some(&summary.id),
            metadata_with_runtime_title(
                serde_json::json!({
                    "source": "desktop-chat-summary",
                    "subtitle": summary.subtitle,
                    "updatedAtLabel": summary.updated_at_label,
                    "messageCount": summary.message_count,
                }),
                runtime_conn.as_ref(),
                &summary.id,
            ),
            summary.forked_from_session_id.as_deref(),
            summary.forked_from_message_id.as_deref(),
        )?;
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
                metadata: Some(metadata),
            },
        )?;
    }

    for project in &state.projects {
        for summary in project.sessions.iter().filter(|summary| !summary.draft) {
            let metadata = metadata_with_fork(
                &conn,
                Some(&summary.id),
                metadata_with_runtime_title(
                    serde_json::json!({
                        "source": "desktop-project-summary",
                        "projectRoot": project.root,
                        "subtitle": summary.subtitle,
                        "updatedAtLabel": summary.updated_at_label,
                        "messageCount": summary.message_count,
                    }),
                    runtime_conn.as_ref(),
                    &summary.id,
                ),
                summary.forked_from_session_id.as_deref(),
                summary.forked_from_message_id.as_deref(),
            )?;
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
                    metadata: Some(metadata),
                },
            )?;
        }
    }

    let active = &state.active_session;
    // Retain existing explicit sessions when their project membership changes
    // before the first message (including moving back to an unassigned chat).
    if should_sync_desktop_chat_detail(active)
        || (!active.draft && select_session(&conn, &active.id)?.is_some())
    {
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
            let metadata = metadata_with_fork(
                &conn,
                Some(&active.id),
                metadata_with_runtime_title(
                    serde_json::json!({
                        "source": "desktop-chat-detail",
                        "provider": active.provider,
                        "providerLabel": active.provider_label,
                        "model": active.model,
                        "modelLabel": active.model_label,
                        "thinking": active.thinking,
                        "thinkingLabel": active.thinking_label,
                        "projectRoot": project_root,
                        "workspaceRoot": workspace_root,
                    }),
                    runtime_conn.as_ref(),
                    &active.id,
                ),
                active.forked_from_session_id.as_deref(),
                active.forked_from_message_id.as_deref(),
            )?;
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
                    metadata: Some(metadata),
                },
            )?;
        }

        let active_agent_identity_id =
            desktop_session_agent_identity(&conn, &active.id, &agent_identity_id)?;
        let mut latest_user_message_id: Option<String> = None;
        for (index, message) in active.messages.iter().enumerate() {
            let is_agent_message = message_role::is_agent(message);
            let synced_message_id = sync_desktop_chat_message(
                &conn,
                &active.id,
                &human_identity_id,
                &active_agent_identity_id,
                index,
                message,
                is_agent_message
                    .then_some(latest_user_message_id.as_deref())
                    .flatten(),
            )?;
            if message.role.trim().eq_ignore_ascii_case("user") {
                if let Some(message_id) = synced_message_id {
                    latest_user_message_id = Some(message_id);
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod fork_metadata_tests;
