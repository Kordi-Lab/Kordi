use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::{now_ms, select_session, upsert_participant, CanonicalSession};

fn manual_title_metadata(session: &CanonicalSession, updated_at_ms: i64) -> Result<String, String> {
    let mut metadata = match session.metadata.clone() {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    let revision = metadata
        .get("sessionTitleRevision")
        .and_then(Value::as_i64)
        .unwrap_or_default()
        + 1;
    metadata.insert(
        "titleSource".to_string(),
        Value::String("manual".to_string()),
    );
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
    // Cloud assigns the authoritative actor after accepting this edit. A new
    // local rename must not inherit the actor from an older synchronized edit.
    metadata.remove("sessionTitleUpdatedByAccountId");
    serde_json::to_string(&Value::Object(metadata)).map_err(|err| err.to_string())
}

pub(crate) fn ensure_group_session(
    conn: &Connection,
    session_id: &str,
) -> Result<CanonicalSession, String> {
    let session =
        select_session(conn, session_id)?.ok_or_else(|| "Group session not found".to_string())?;
    if session.kind != "group" {
        return Err("Session is not a group".to_string());
    }
    Ok(session)
}

pub(crate) fn rename_session_in_db(
    conn: &Connection,
    session_id: &str,
    title: &str,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Group name is required".to_string());
    }
    let session = ensure_group_session(conn, session_id)?;
    let updated_at_ms = now_ms();
    let metadata = manual_title_metadata(&session, updated_at_ms)?;
    conn.execute(
        "UPDATE sessions SET title = ?2, metadata_json = ?3, updated_at_ms = ?4 WHERE id = ?1",
        params![session_id, title, metadata, updated_at_ms],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn rename_any_session_title_in_db(
    conn: &Connection,
    session_id: &str,
    title: &str,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Session title is required".to_string());
    }
    let session =
        select_session(conn, session_id)?.ok_or_else(|| "Session not found".to_string())?;
    let updated_at_ms = now_ms();
    let metadata = manual_title_metadata(&session, updated_at_ms)?;
    conn.execute(
        "UPDATE sessions SET title = ?2, metadata_json = ?3, updated_at_ms = ?4 WHERE id = ?1",
        params![session_id, title, metadata, updated_at_ms],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn set_session_metadata_in_db(
    conn: &Connection,
    session_id: &str,
    metadata: Value,
) -> Result<(), String> {
    ensure_group_session(conn, session_id)?;
    let raw = serde_json::to_string(&metadata).map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE sessions SET metadata_json = ?2, updated_at_ms = ?3 WHERE id = ?1",
        params![session_id, raw, now_ms()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn add_session_participants_in_db(
    conn: &Connection,
    session_id: &str,
    identity_ids: &[String],
    added_by: &str,
) -> Result<(), String> {
    ensure_group_session(conn, session_id)?;
    let now = now_ms();
    for identity_id in identity_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        upsert_participant(conn, session_id, identity_id, "person", Some(added_by), now)?;
    }
    Ok(())
}

pub(crate) fn metadata_admin_identity_ids(metadata: Option<&Value>) -> Vec<String> {
    metadata
        .and_then(|value| value.get("adminIdentityIds"))
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(crate) fn participant_is_active(
    conn: &Connection,
    session_id: &str,
    identity_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_participants WHERE session_id = ?1 AND identity_id = ?2 AND state = 'active')",
        params![session_id, identity_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|err| err.to_string())
}

pub(crate) fn group_admin_identity_ids(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let session = ensure_group_session(conn, session_id)?;
    let mut admin_ids = Vec::new();
    for identity_id in metadata_admin_identity_ids(session.metadata.as_ref()) {
        if !admin_ids.contains(&identity_id)
            && participant_is_active(conn, session_id, &identity_id)?
        {
            admin_ids.push(identity_id);
        }
    }
    if !admin_ids.is_empty() {
        return Ok(admin_ids);
    }

    let mut stmt = conn
        .prepare(
            "SELECT identity_id FROM session_participants
             WHERE session_id = ?1 AND role = 'admin' AND state = 'active'
             ORDER BY added_at_ms ASC, identity_id ASC",
        )
        .map_err(|err| err.to_string())?;
    let role_admins = stmt
        .query_map(params![session_id], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    for identity_id in role_admins {
        if !admin_ids.contains(&identity_id) {
            admin_ids.push(identity_id);
        }
    }
    if !admin_ids.is_empty() {
        return Ok(admin_ids);
    }

    if participant_is_active(conn, session_id, &session.created_by_identity_id)? {
        admin_ids.push(session.created_by_identity_id);
    }
    Ok(admin_ids)
}

pub(crate) fn require_group_admin(
    conn: &Connection,
    session_id: &str,
    actor_identity_id: Option<&str>,
    action: &str,
) -> Result<(), String> {
    let Some(actor_identity_id) = actor_identity_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    if group_admin_identity_ids(conn, session_id)?
        .iter()
        .any(|admin_id| admin_id == actor_identity_id)
    {
        return Ok(());
    }
    Err(format!("Only group admins can {action}."))
}

pub(crate) fn set_session_participant_role_in_db(
    conn: &Connection,
    session_id: &str,
    identity_id: &str,
    role: &str,
) -> Result<(), String> {
    ensure_group_session(conn, session_id)?;
    let role = role.trim().to_lowercase();
    if !matches!(role.as_str(), "self" | "admin" | "person" | "delegate") {
        return Err("Unsupported participant role".to_string());
    }
    let existing_role: Option<String> = conn
        .query_row(
            "SELECT role FROM session_participants WHERE session_id = ?1 AND identity_id = ?2 AND state = 'active'",
            params![session_id, identity_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if existing_role.is_none() {
        return Err("Participant not found in group".to_string());
    }
    let admin_ids = group_admin_identity_ids(conn, session_id)?;
    if admin_ids.iter().any(|admin_id| admin_id == identity_id)
        && !matches!(role.as_str(), "admin")
        && admin_ids.len() <= 1
    {
        return Err("Group must keep at least one admin".to_string());
    }
    conn.execute(
        "UPDATE session_participants SET role = ?3 WHERE session_id = ?1 AND identity_id = ?2 AND state = 'active'",
        params![session_id, identity_id, role],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn remove_session_participant_in_db(
    conn: &Connection,
    session_id: &str,
    identity_id: &str,
) -> Result<(), String> {
    ensure_group_session(conn, session_id)?;
    let existing_role: Option<String> = conn
        .query_row(
            "SELECT role FROM session_participants WHERE session_id = ?1 AND identity_id = ?2 AND state = 'active'",
            params![session_id, identity_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if existing_role.is_none() {
        return Err("Participant not found in group".to_string());
    }
    let admin_ids = group_admin_identity_ids(conn, session_id)?;
    if admin_ids.iter().any(|admin_id| admin_id == identity_id) && admin_ids.len() <= 1 {
        return Err("Group must keep at least one admin".to_string());
    }
    conn.execute(
        "UPDATE session_participants SET state = 'left' WHERE session_id = ?1 AND identity_id = ?2",
        params![session_id, identity_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn session_has_participant(
    conn: &Connection,
    session_id: &str,
    identity_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM session_participants
            WHERE session_id = ?1 AND identity_id = ?2 AND state = 'active'
         )",
        params![session_id, identity_id],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_admin_identity_ids_filters_blank_values() {
        assert_eq!(
            metadata_admin_identity_ids(Some(&serde_json::json!({
                "adminIdentityIds": ["human:a", " "]
            }))),
            vec!["human:a".to_string()],
        );
    }
}
