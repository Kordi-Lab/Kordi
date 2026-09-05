//! Canonical session, participant, and row-projection persistence.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::super::{
    clean_optional, default_session_title, json_from_db, json_to_db, now_ms,
    reconcile_session_title_metadata, stable_session_id, validate_session_kind, validate_status,
    CanonicalSession, OpenCanonicalSessionRequest,
};

pub(in crate::canonical_sessions) fn open_or_create_session_in_db(
    conn: &Connection,
    request: OpenCanonicalSessionRequest,
) -> Result<CanonicalSession, String> {
    let kind = validate_session_kind(&request.kind)?;
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| stable_session_id(&request));
    let mut default_title = default_session_title(conn, &request)?;
    let mut request_metadata = request.metadata;
    if kind == "group" {
        if let Some((title, revision, updated_at_ms)) = conn
            .query_row(
                "SELECT json_extract(snapshot_json, '$.shared_title'), version, updated_at_ms
                 FROM chat_sync_conversations
                 WHERE client_session_id = ?1
                   AND json_extract(snapshot_json, '$.kind') = 'group'
                 ORDER BY updated_at_ms DESC LIMIT 1",
                [&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?
            .filter(|(title, _, _)| !title.trim().is_empty())
        {
            default_title = title.trim().to_string();
            let metadata =
                request_metadata.get_or_insert_with(|| Value::Object(Default::default()));
            if let Some(metadata) = metadata.as_object_mut() {
                metadata.insert(
                    "sessionTitleSource".to_string(),
                    Value::String("manual".to_string()),
                );
                metadata.insert("sessionTitleRevision".to_string(), Value::from(revision));
                metadata.insert(
                    "sessionTitlePolicyVersion".to_string(),
                    Value::from(kordi_session::naming::SESSION_TITLE_POLICY_VERSION),
                );
                metadata.insert(
                    "sessionTitleUpdatedAtMs".to_string(),
                    Value::from(updated_at_ms),
                );
                metadata.remove("sessionTitleUpdatedByAccountId");
            }
        }
    }
    let existing_session = select_session(conn, &id)?;
    let (title, metadata_value) = reconcile_session_title_metadata(
        existing_session.as_ref(),
        &kind,
        default_title,
        request_metadata,
    );
    let status = validate_status(request.status, "active");
    let created_by_identity_id = request.created_by_identity_id;
    let primary_identity_id = clean_optional(request.primary_identity_id);
    let project_id = clean_optional(request.project_id);
    let project_name = clean_optional(request.project_name);
    let relationship_identity_id = clean_optional(request.relationship_identity_id);
    let participant_identity_ids = request.participant_identity_ids;
    let metadata = json_to_db(&metadata_value)?;
    let participant_role = if kind == "group" {
        "person"
    } else {
        "delegate"
    };
    let now = now_ms();

    let session_changed = existing_session.as_ref().is_none_or(|existing| {
        existing.kind != kind
            || existing.title != title
            || existing.status != status
            || existing.created_by_identity_id != created_by_identity_id
            || existing.primary_identity_id != primary_identity_id
            || existing.project_id != project_id
            || existing.project_name != project_name
            || existing.relationship_identity_id != relationship_identity_id
            || existing.metadata != metadata_value
    });
    if session_changed {
        conn.execute(
            "INSERT INTO sessions(
             id, kind, title, status, created_by_identity_id, primary_identity_id, project_id,
             project_name, relationship_identity_id, metadata_json, created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)
         ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             title = excluded.title,
             status = excluded.status,
             created_by_identity_id = excluded.created_by_identity_id,
             primary_identity_id = excluded.primary_identity_id,
             project_id = excluded.project_id,
             project_name = excluded.project_name,
             relationship_identity_id = excluded.relationship_identity_id,
             metadata_json = excluded.metadata_json,
             updated_at_ms = excluded.updated_at_ms",
            params![
                id,
                kind,
                title,
                status,
                created_by_identity_id,
                primary_identity_id,
                project_id,
                project_name,
                relationship_identity_id,
                metadata,
                now,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
    }

    let local_group_self_identity_id = if kind == "group" {
        local_profile_self_identity_id(conn)?
    } else {
        None
    };
    let self_identity_id = local_group_self_identity_id
        .as_deref()
        .unwrap_or(created_by_identity_id.as_str());
    let created_by_role = if created_by_identity_id == self_identity_id {
        "self"
    } else if kind == "group" {
        "admin"
    } else {
        participant_role
    };
    upsert_participant(
        conn,
        &id,
        &created_by_identity_id,
        created_by_role,
        Some(&created_by_identity_id),
        now,
    )?;
    for participant in participant_identity_ids {
        let participant = participant.trim();
        if participant.is_empty() || participant == created_by_identity_id {
            continue;
        }
        let role = if participant == self_identity_id {
            "self"
        } else {
            participant_role
        };
        upsert_participant(
            conn,
            &id,
            participant,
            role,
            Some(&created_by_identity_id),
            now,
        )?;
    }
    if let Some(local_self_identity_id) = local_group_self_identity_id.as_deref() {
        enforce_only_local_group_self(conn, &id, local_self_identity_id)?;
    }

    select_session(conn, &id)?.ok_or_else(|| "Unable to save canonical session".to_string())
}

fn local_profile_self_identity_id(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT human_identity_id FROM local_profile LIMIT 1",
        [],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|value| {
        value
            .flatten()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
    })
    .map_err(|err| err.to_string())
}

pub(in crate::canonical_sessions) fn enforce_only_local_group_self(
    conn: &Connection,
    session_id: &str,
    local_self_identity_id: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE session_participants
         SET role = 'person'
         WHERE session_id = ?1 AND role = 'self' AND identity_id <> ?2",
        params![session_id, local_self_identity_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(in crate::canonical_sessions) fn upsert_participant(
    conn: &Connection,
    session_id: &str,
    identity_id: &str,
    role: &str,
    added_by: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO session_participants(session_id, identity_id, role, state, added_by_identity_id, added_at_ms, metadata_json)
         VALUES(?1, ?2, ?3, 'active', ?4, ?5, NULL)
         ON CONFLICT(session_id, identity_id) DO UPDATE SET
             role = CASE WHEN session_participants.role = 'self' THEN session_participants.role ELSE excluded.role END,
             state = 'active'",
        params![session_id, identity_id, role, added_by, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(in crate::canonical_sessions) fn select_session(
    conn: &Connection,
    id: &str,
) -> Result<Option<CanonicalSession>, String> {
    conn.query_row(
        "SELECT id, kind, title, status, created_by_identity_id, primary_identity_id, project_id,
                project_name, relationship_identity_id, metadata_json, created_at_ms, updated_at_ms, last_message_at_ms
         FROM sessions WHERE id = ?1",
        params![id],
        |row| {
            Ok(CanonicalSession {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                status: row.get(3)?,
                created_by_identity_id: row.get(4)?,
                primary_identity_id: row.get(5)?,
                project_id: row.get(6)?,
                project_name: row.get(7)?,
                relationship_identity_id: row.get(8)?,
                metadata: json_from_db(row.get(9)?),
                created_at_ms: row.get(10)?,
                updated_at_ms: row.get(11)?,
                last_message_at_ms: row.get(12)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}
