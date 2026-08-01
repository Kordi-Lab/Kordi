//! Cloud profile adoption and transactional identity-reference migration.

use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::Value;

use super::super::identity_helpers::replace_identity_in_json_value;
use super::super::{
    clean_optional, enforce_only_local_group_self, ensure_local_profile, json_to_db,
    select_identity, upsert_identity_in_db, AdoptCloudProfileIdentityRequest,
    CanonicalProfileIdentityDelta, UpsertCanonicalIdentityRequest,
};
use super::local_identities::update_local_profile_identities;

#[allow(dead_code)]
fn reassign_stale_local_human_identities(
    conn: &Connection,
    active_human_identity_id: &str,
) -> Result<(), String> {
    let profile = ensure_local_profile(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id FROM identities
             WHERE kind = 'human'
               AND id <> ?1
               AND (
                    id = ?2
                    OR (source = 'local' AND json_extract(metadata_json, '$.profileId') = ?3)
               )",
        )
        .map_err(|err| err.to_string())?;
    let stale_ids = stmt
        .query_map(
            params![
                active_human_identity_id,
                format!("human:{}", profile.id),
                profile.id
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    for stale_id in stale_ids {
        let mut participant_stmt = conn
            .prepare("SELECT session_id, role FROM session_participants WHERE identity_id = ?1")
            .map_err(|err| err.to_string())?;
        let session_roles = participant_stmt
            .query_map(params![stale_id.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;

        for (session_id, stale_role) in session_roles {
            let active_exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM session_participants WHERE session_id = ?1 AND identity_id = ?2",
                    params![session_id.as_str(), active_human_identity_id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            if active_exists > 0 {
                if stale_role == "self" {
                    conn.execute(
                        "UPDATE session_participants SET role = 'self' WHERE session_id = ?1 AND identity_id = ?2",
                        params![session_id.as_str(), active_human_identity_id],
                    )
                    .map_err(|err| err.to_string())?;
                }
                conn.execute(
                    "DELETE FROM session_participants WHERE session_id = ?1 AND identity_id = ?2",
                    params![session_id.as_str(), stale_id.as_str()],
                )
                .map_err(|err| err.to_string())?;
            } else {
                conn.execute(
                    "UPDATE session_participants SET identity_id = ?1 WHERE session_id = ?2 AND identity_id = ?3",
                    params![active_human_identity_id, session_id.as_str(), stale_id.as_str()],
                )
                .map_err(|err| err.to_string())?;
            }
        }

        conn.execute(
            "UPDATE sessions SET created_by_identity_id = ?1 WHERE created_by_identity_id = ?2",
            params![active_human_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE sessions SET primary_identity_id = ?1 WHERE primary_identity_id = ?2",
            params![active_human_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE sessions SET relationship_identity_id = ?1 WHERE relationship_identity_id = ?2",
            params![active_human_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE identities SET owner_identity_id = ?1 WHERE owner_identity_id = ?2",
            params![active_human_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE session_messages SET sender_identity_id = ?1 WHERE sender_identity_id = ?2",
            params![active_human_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE delegated_exchanges SET initiator_identity_id = ?1 WHERE initiator_identity_id = ?2",
            params![active_human_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE delegated_exchanges SET target_identity_id = ?1 WHERE target_identity_id = ?2",
            params![active_human_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "DELETE FROM presence WHERE identity_id = ?1",
            params![stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute("DELETE FROM identities WHERE id = ?1", params![stale_id])
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn stable_cloud_human_identity_id(account_id: &str) -> Result<String, String> {
    let account_id = account_id.trim();
    if account_id.is_empty() {
        return Err("Cloud account id is required".to_string());
    }
    if !account_id.starts_with("acct_") {
        return Err("Cloud account id must start with acct_".to_string());
    }
    Ok(format!("human:{account_id}"))
}

fn update_json_identity_references(
    conn: &Connection,
    table: &str,
    id_column: &str,
    json_column: &str,
    old_identity_id: &str,
    new_identity_id: &str,
) -> Result<(), String> {
    let select_sql = format!(
        "SELECT CAST({id_column} AS TEXT), {json_column} FROM {table} WHERE {json_column} LIKE ?1"
    );
    let rows = {
        let mut stmt = conn.prepare(&select_sql).map_err(|err| err.to_string())?;
        let matches = format!("%{old_identity_id}%");
        let rows = stmt
            .query_map(params![matches], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let update_sql = format!("UPDATE {table} SET {json_column} = ?1 WHERE {id_column} = ?2");
    for (row_id, raw_json) in rows {
        let Some(raw_json) = raw_json else { continue };
        let mut value: Value = serde_json::from_str(&raw_json).map_err(|err| err.to_string())?;
        if replace_identity_in_json_value(&mut value, old_identity_id, new_identity_id) {
            let next_json = json_to_db(&Some(value))?;
            conn.execute(&update_sql, params![next_json, row_id])
                .map_err(|err| err.to_string())?;
        }
    }

    Ok(())
}

fn update_identity_references(
    conn: &Connection,
    old_identity_id: &str,
    new_identity_id: &str,
) -> Result<(), String> {
    if old_identity_id == new_identity_id {
        return Ok(());
    }

    conn.execute(
        "UPDATE sessions SET created_by_identity_id = ?1 WHERE created_by_identity_id = ?2",
        params![new_identity_id, old_identity_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE sessions SET primary_identity_id = ?1 WHERE primary_identity_id = ?2",
        params![new_identity_id, old_identity_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE sessions SET relationship_identity_id = ?1 WHERE relationship_identity_id = ?2",
        params![new_identity_id, old_identity_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE session_messages SET sender_identity_id = ?1 WHERE sender_identity_id = ?2",
        params![new_identity_id, old_identity_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE session_participants SET added_by_identity_id = ?1 WHERE added_by_identity_id = ?2",
        params![new_identity_id, old_identity_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE delegated_exchanges SET initiator_identity_id = ?1 WHERE initiator_identity_id = ?2",
        params![new_identity_id, old_identity_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE delegated_exchanges SET target_identity_id = ?1 WHERE target_identity_id = ?2",
        params![new_identity_id, old_identity_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE identities SET owner_identity_id = ?1 WHERE owner_identity_id = ?2",
        params![new_identity_id, old_identity_id],
    )
    .map_err(|err| err.to_string())?;
    update_json_identity_references(
        conn,
        "sessions",
        "id",
        "metadata_json",
        old_identity_id,
        new_identity_id,
    )?;
    update_json_identity_references(
        conn,
        "session_participants",
        "rowid",
        "metadata_json",
        old_identity_id,
        new_identity_id,
    )?;
    update_json_identity_references(
        conn,
        "session_messages",
        "id",
        "content_json",
        old_identity_id,
        new_identity_id,
    )?;
    update_json_identity_references(
        conn,
        "identities",
        "id",
        "metadata_json",
        old_identity_id,
        new_identity_id,
    )?;

    let participant_rows = {
        let mut stmt = conn
            .prepare(
                "SELECT session_id, role, added_by_identity_id, added_at_ms,
                        last_seen_at_ms, last_read_message_id, metadata_json
                 FROM session_participants
                 WHERE identity_id = ?1",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![old_identity_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    for (
        session_id,
        role,
        added_by,
        added_at_ms,
        last_seen_at_ms,
        last_read_message_id,
        metadata_json,
    ) in participant_rows
    {
        conn.execute(
            "INSERT INTO session_participants(
                 session_id, identity_id, role, state, added_by_identity_id, added_at_ms,
                 last_seen_at_ms, last_read_message_id, metadata_json
             )
             VALUES(?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(session_id, identity_id) DO UPDATE SET
                 role = CASE WHEN session_participants.role = 'self' THEN session_participants.role ELSE excluded.role END,
                 state = 'active'",
            params![
                session_id,
                new_identity_id,
                role,
                added_by,
                added_at_ms,
                last_seen_at_ms,
                last_read_message_id,
                metadata_json,
            ],
        )
        .map_err(|err| err.to_string())?;
        if role == "self" {
            conn.execute(
                "UPDATE session_participants SET role = 'self' WHERE session_id = ?1 AND identity_id = ?2",
                params![session_id, new_identity_id],
            )
            .map_err(|err| err.to_string())?;
        }
    }
    conn.execute(
        "DELETE FROM session_participants WHERE identity_id = ?1",
        params![old_identity_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM presence WHERE identity_id = ?1",
        params![old_identity_id],
    )
    .map_err(|err| err.to_string())?;

    Ok(())
}

pub(in crate::canonical_sessions) fn adopt_cloud_profile_identity_in_db(
    conn: &mut Connection,
    request: AdoptCloudProfileIdentityRequest,
) -> Result<CanonicalProfileIdentityDelta, String> {
    let account_id = request.account_id.trim().to_string();
    let stable_identity_id = stable_cloud_human_identity_id(&account_id)?;
    let display_name = request.display_name.trim();
    if display_name.is_empty() {
        return Err("Cloud profile display name is required".to_string());
    }
    let profile_image_url = clean_optional(request.profile_image_url);

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let profile = ensure_local_profile(&tx)?;
    let previous_human_identity_id = profile
        .human_identity_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    upsert_identity_in_db(
        &tx,
        UpsertCanonicalIdentityRequest {
            id: Some(stable_identity_id.clone()),
            kind: "human".to_string(),
            display_name: display_name.to_string(),
            owner_identity_id: None,
            source: Some("local".to_string()),
            source_host_id: None,
            bridge_node_id: None,
            human_id: Some(account_id.clone()),
            agent_id: None,
            avatar_key: request.avatar_key.or_else(|| Some(account_id.clone())),
            profile_image_url: profile_image_url.clone(),
            metadata: Some(serde_json::json!({
                "accountId": account_id,
                "cloudProfileIdentity": true,
            })),
        },
    )?;
    tx.execute(
        "UPDATE identities SET profile_image_url = ?1 WHERE id = ?2",
        params![profile_image_url.as_deref(), stable_identity_id],
    )
    .map_err(|err| err.to_string())?;
    let identity = select_identity(&tx, &stable_identity_id)?
        .ok_or_else(|| "Unable to refresh adopted cloud profile identity".to_string())?;

    if let Some(previous_id) = previous_human_identity_id.as_deref() {
        update_identity_references(&tx, previous_id, &stable_identity_id)?;
    }
    tx.execute(
        "UPDATE session_participants SET role = 'self' WHERE identity_id = ?1 AND state = 'active'",
        params![stable_identity_id],
    )
    .map_err(|err| err.to_string())?;
    let group_session_ids = {
        let mut stmt = tx
            .prepare(
                "SELECT s.id
                 FROM sessions s
                 JOIN session_participants sp ON sp.session_id = s.id
                 WHERE s.kind = 'group' AND sp.identity_id = ?1 AND sp.state = 'active'",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![stable_identity_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };
    for session_id in &group_session_ids {
        enforce_only_local_group_self(&tx, session_id, &stable_identity_id)?;
    }
    update_local_profile_identities(&tx, Some(&stable_identity_id), None, Some(display_name))?;

    let delta = CanonicalProfileIdentityDelta {
        profile: ensure_local_profile(&tx)?,
        identity,
        previous_identity_id: previous_human_identity_id,
        group_self_session_ids: group_session_ids,
    };
    tx.commit().map_err(|err| err.to_string())?;

    Ok(delta)
}
