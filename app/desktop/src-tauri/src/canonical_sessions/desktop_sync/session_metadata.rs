use super::*;

pub(crate) fn is_placeholder_or_default_agent_session_title(title: &str) -> bool {
    let normalized = title.trim().to_lowercase();
    let placeholders = "new chat\nnew session\nuntitled session\nsession\nkordi\nmy kordi\nmy agent\nmy kordi session\nmy agent session";
    normalized.is_empty()
        || placeholders
            .lines()
            .any(|candidate| candidate == normalized)
}

pub(crate) fn should_sync_desktop_chat_summary(
    summary: &kordi_cli::desktop_runtime::DesktopChatSessionSummary,
) -> bool {
    !(summary.message_count == 0
        && (summary.draft || is_placeholder_or_default_agent_session_title(&summary.title)))
}

pub(crate) fn should_sync_desktop_chat_detail(
    detail: &kordi_cli::desktop_runtime::DesktopChatSessionDetail,
) -> bool {
    !(detail.message_count == 0
        && detail.messages.is_empty()
        && (detail.draft || is_placeholder_or_default_agent_session_title(&detail.title)))
}

pub(crate) fn should_update_desktop_session_shell(
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
    let created_from = session
        .metadata
        .as_ref()
        .and_then(|value| value.get("createdFrom"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if session.id.starts_with("session:bridge:")
        || created_from == "chat-create-flow"
        || source == "canonical-fork-snapshot"
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

pub(crate) fn desktop_session_agent_identity(
    conn: &Connection,
    session_id: &str,
    fallback: &str,
) -> Result<String, String> {
    let identity: Option<String> = conn.query_row(
        "SELECT identity.id FROM sessions session JOIN identities identity ON identity.id=session.primary_identity_id WHERE session.id=?1 AND identity.kind='agent'",
        [session_id], |row| row.get(0),
    ).optional().map_err(|error| error.to_string())?;
    Ok(identity.unwrap_or_else(|| fallback.to_string()))
}

pub(crate) fn explicit_desktop_project_membership(
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

pub(crate) fn resolve_desktop_entry_to_canonical_message_id(
    conn: &Connection,
    session_id: &str,
    entry_id: &str,
) -> Result<Option<String>, String> {
    let session_id = session_id.trim();
    let entry_id = entry_id.trim();
    if session_id.is_empty() || entry_id.is_empty() {
        return Ok(None);
    }
    if canonical_message_exists(conn, session_id, entry_id)? {
        return Ok(Some(entry_id.to_string()));
    }

    let alias_message_id = conn
        .query_row(
            "SELECT id
             FROM session_messages
             WHERE session_id = ?1
               AND CASE
                     WHEN json_valid(content_json)
                     THEN json_extract(content_json, '$.desktopEntryId')
                     ELSE NULL
                   END = ?2
             ORDER BY sequence_num DESC
             LIMIT 1",
            params![session_id, entry_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if alias_message_id.is_some() {
        return Ok(alias_message_id);
    }
    if entry_id.starts_with("msg:") {
        return Ok(None);
    }

    let settings = kordi_core::settings::Settings::load_global();
    let local_conn =
        kordi_session::store::open_db(&kordi_core::config::session_db_path(&settings.storage))
            .map_err(|err| err.to_string())?;
    let local_entries = kordi_session::store::get_entries(&local_conn, session_id)
        .map_err(|err| err.to_string())?;
    let Some(entry_index) = local_entries
        .iter()
        .filter(|entry| entry.entry_type == "message")
        .position(|entry| entry.entry_id == entry_id)
    else {
        return Ok(None);
    };

    let mut stmt = conn
        .prepare(
            "SELECT id FROM session_messages \
             WHERE session_id = ?1 AND source_transport = 'desktop-chat' \
             ORDER BY sequence_num ASC",
        )
        .map_err(|err| err.to_string())?;
    let canonical_ids = stmt
        .query_map(params![session_id], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(canonical_ids.get(entry_index).cloned())
}

pub(crate) fn canonical_session_message_id_for_entry(
    session_id: &str,
    entry_id: &str,
) -> Result<Option<String>, String> {
    let conn = open_db()?;
    resolve_desktop_entry_to_canonical_message_id(&conn, session_id, entry_id)
}

pub(crate) fn canonical_fork_message_id(
    conn: &Connection,
    forked_from_session_id: Option<&str>,
    forked_from_message_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(message_id) = forked_from_message_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    if message_id.starts_with("msg:") {
        return Ok(Some(message_id.to_string()));
    }
    let resolved = forked_from_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|session_id| {
            resolve_desktop_entry_to_canonical_message_id(conn, session_id, message_id)
        })
        .transpose()?
        .flatten();
    Ok(resolved.or_else(|| Some(message_id.to_string())))
}

pub(crate) fn fork_metadata_value(
    conn: &Connection,
    forked_from_session_id: Option<&str>,
    forked_from_message_id: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let Some(session) = forked_from_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let mut value = serde_json::json!({
        "forkedFromSessionId": session,
        "forkMode": "private-local",
        "contextPolicy": "prefix-through-message",
        "boundary": "inherited-history-reference-only",
    });
    if let Some(message_id) =
        canonical_fork_message_id(conn, forked_from_session_id, forked_from_message_id)?
    {
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "forkedFromMessageId".to_string(),
                serde_json::Value::String(message_id.clone()),
            );
            let mut aliases = vec![message_id];
            if let Some(runtime_entry_id) = forked_from_message_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if !aliases.iter().any(|alias| alias == runtime_entry_id) {
                    aliases.push(runtime_entry_id.to_string());
                }
            }
            object.insert(
                "forkedFromMessageAliases".to_string(),
                serde_json::Value::Array(
                    aliases.into_iter().map(serde_json::Value::String).collect(),
                ),
            );
        }
    }
    Ok(Some(value))
}

pub(crate) fn metadata_with_fork(
    conn: &Connection,
    session_id: Option<&str>,
    base: serde_json::Value,
    forked_from_session_id: Option<&str>,
    forked_from_message_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let Some(mut fork) = fork_metadata_value(conn, forked_from_session_id, forked_from_message_id)?
    else {
        return Ok(base);
    };
    let existing_fork = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|session_id| select_session(conn, session_id))
        .transpose()?
        .flatten()
        .and_then(|session| session.metadata)
        .and_then(|metadata| metadata.get("fork").cloned())
        .filter(|value| value.is_object());
    if let (Some(next), Some(existing)) = (
        fork.as_object_mut(),
        existing_fork.as_ref().and_then(|value| value.as_object()),
    ) {
        for (key, value) in existing {
            next.entry(key.clone()).or_insert_with(|| value.clone());
        }
        let mut aliases = Vec::<String>::new();
        for value in next
            .get("forkedFromMessageAliases")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
            .chain(
                existing
                    .get("forkedFromMessageAliases")
                    .and_then(|value| value.as_array())
                    .into_iter()
                    .flatten(),
            )
        {
            let Some(alias) = value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if !aliases.iter().any(|candidate| candidate == alias) {
                aliases.push(alias.to_string());
            }
        }
        if !aliases.is_empty() {
            next.insert(
                "forkedFromMessageAliases".to_string(),
                serde_json::Value::Array(
                    aliases.into_iter().map(serde_json::Value::String).collect(),
                ),
            );
        }
    }
    let mut combined = base;
    if let Some(object) = combined.as_object_mut() {
        object.insert("fork".to_string(), fork);
    }
    Ok(combined)
}

pub(crate) fn metadata_with_runtime_title(
    mut base: serde_json::Value,
    runtime_conn: Option<&rusqlite::Connection>,
    session_id: &str,
) -> serde_json::Value {
    let Some(row) = runtime_conn.and_then(|conn| {
        kordi_session::store::get_session(conn, session_id)
            .ok()
            .flatten()
    }) else {
        return base;
    };
    let Some(object) = base.as_object_mut() else {
        return base;
    };
    object.insert(
        "sessionTitleSource".to_string(),
        serde_json::Value::String(row.title_source.as_str().to_string()),
    );
    object.insert(
        "titleSource".to_string(),
        serde_json::Value::String(row.title_source.as_str().to_string()),
    );
    object.insert(
        "sessionTitleRevision".to_string(),
        serde_json::Value::from(row.title_revision),
    );
    object.insert(
        "sessionTitlePolicyVersion".to_string(),
        serde_json::Value::from(row.title_policy_version),
    );
    if let Some(entry_id) = row.title_generated_from_entry_id {
        object.insert(
            "sessionTitleGeneratedFromMessageId".to_string(),
            serde_json::Value::String(entry_id),
        );
    }
    if let Some(updated_at_ms) = row
        .title_updated_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
    {
        object.insert(
            "sessionTitleUpdatedAtMs".to_string(),
            serde_json::Value::from(updated_at_ms),
        );
    }
    base
}
