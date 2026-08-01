//! Group authority, membership, metadata, and participant command orchestration.

use std::collections::HashSet;

use rusqlite::{Connection, TransactionBehavior};
use serde_json::{json, Map, Value};

use super::super::{
    add_session_participants_in_db, append_message_in_db, identity_display_name, json_from_db,
    open_db, remove_session_participant_in_db, rename_any_session_title_in_db,
    rename_session_in_db_with_actor_account, require_group_admin, require_group_creator,
    require_group_member, require_group_member_removal_permission, select_identity, select_session,
    set_session_metadata_in_db, set_session_participant_role_in_db,
    AddCanonicalGroupMembersRequest, AddCanonicalSessionParticipantsRequest,
    AppendCanonicalMessageRequest, CanonicalGroupMembershipDelta, CanonicalGroupMembershipUpdate,
    CanonicalSessionParticipant, CanonicalSessionState, RemoveCanonicalSessionParticipantRequest,
    RenameCanonicalSessionRequest, SetCanonicalSessionParticipantRoleRequest,
    UpdateCanonicalSessionMetadataRequest,
};
use super::catalog::load_state_from_db;

pub(super) fn select_session_participants(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<CanonicalSessionParticipant>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT participant.session_id, participant.identity_id, participant.role, participant.state,
                    participant.added_by_identity_id, participant.added_at_ms, participant.last_seen_at_ms,
                    participant.last_read_message_id,
                    (
                        SELECT message.sequence_num
                        FROM session_messages AS message
                        WHERE message.id = participant.last_read_message_id
                          AND message.session_id = participant.session_id
                    ),
                    participant.metadata_json
             FROM session_participants AS participant
             WHERE participant.session_id = ?1
             ORDER BY participant.added_at_ms ASC, participant.identity_id ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok(CanonicalSessionParticipant {
                session_id: row.get(0)?,
                identity_id: row.get(1)?,
                role: row.get(2)?,
                state: row.get(3)?,
                added_by_identity_id: row.get(4)?,
                added_at_ms: row.get(5)?,
                last_seen_at_ms: row.get(6)?,
                last_read_message_id: row.get(7)?,
                last_read_sequence_num: row.get(8)?,
                metadata: json_from_db(row.get(9)?),
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn group_authority_metadata_signature(metadata: Option<&Value>) -> (String, Vec<String>, i64) {
    let creator_identity_id = metadata
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("groupCreatorIdentityId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let mut admin_identity_ids = metadata
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("adminIdentityIds"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|identity_id| !identity_id.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    admin_identity_ids.sort();
    admin_identity_ids.dedup();
    let updated_at_ms = metadata
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("groupAdminUpdatedAtMs"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    (creator_identity_id, admin_identity_ids, updated_at_ms)
}

fn cloud_account_id_for_identity(
    conn: &Connection,
    identity_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(identity_id) = identity_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some(identity) = select_identity(conn, identity_id)? else {
        return Ok(None);
    };
    Ok(identity
        .human_id
        .or(identity.bridge_node_id)
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("acct_")))
}

pub(in crate::canonical_sessions) fn desktop_canonical_rename_session(
    request: RenameCanonicalSessionRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    let session = select_session(&conn, &request.session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    if session.kind == "group" {
        require_group_admin(
            &conn,
            &request.session_id,
            request.requested_by_identity_id.as_deref(),
            "rename this group",
        )?;
        let updated_by_account_id =
            cloud_account_id_for_identity(&conn, request.requested_by_identity_id.as_deref())?;
        rename_session_in_db_with_actor_account(
            &conn,
            &request.session_id,
            &request.title,
            updated_by_account_id.as_deref(),
        )?;
    } else {
        rename_any_session_title_in_db(&conn, &request.session_id, &request.title)?;
    }
    load_state_from_db(&conn)
}

pub(in crate::canonical_sessions) fn desktop_canonical_update_session_metadata(
    request: UpdateCanonicalSessionMetadataRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    let session = select_session(&conn, &request.session_id)?
        .ok_or_else(|| "Group session not found".to_string())?;
    let changes_authority = group_authority_metadata_signature(session.metadata.as_ref())
        != group_authority_metadata_signature(Some(&request.metadata));
    if changes_authority {
        require_group_creator(
            &conn,
            &request.session_id,
            request.requested_by_identity_id.as_deref(),
            "change group admins",
        )?;
    } else {
        require_group_admin(
            &conn,
            &request.session_id,
            request.requested_by_identity_id.as_deref(),
            "change this group",
        )?;
    }
    set_session_metadata_in_db(&conn, &request.session_id, request.metadata)?;
    load_state_from_db(&conn)
}

pub(in crate::canonical_sessions) fn desktop_canonical_add_session_participants(
    request: AddCanonicalSessionParticipantsRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    require_group_member(
        &conn,
        &request.session_id,
        Some(request.added_by_identity_id.as_str()),
        "invite people to this group",
    )?;
    add_session_participants_in_db(
        &conn,
        &request.session_id,
        &request.identity_ids,
        &request.added_by_identity_id,
    )?;
    load_state_from_db(&conn)
}

fn merge_group_membership_metadata(
    conn: &Connection,
    update: &CanonicalGroupMembershipUpdate,
) -> Result<Value, String> {
    let session = select_session(conn, &update.session_id)?
        .ok_or_else(|| "Group session not found".to_string())?;
    if session.kind != "group" {
        return Err("Session is not a group".to_string());
    }
    let mut metadata = match session.metadata {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let existing_group_space_id = metadata
        .get("groupSpaceId")
        .and_then(Value::as_str)
        .or_else(|| metadata.get("groupId").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let group_space_id = existing_group_space_id
        .unwrap_or_else(|| update.group_space_id.trim())
        .to_string();
    if group_space_id.is_empty() {
        return Err("Group space id is required".to_string());
    }
    metadata.insert("groupId".to_string(), Value::String(group_space_id.clone()));
    metadata.insert("groupSpaceId".to_string(), Value::String(group_space_id));

    for (key, additions) in [
        ("initialContactIds", &update.added_contact_ids),
        ("initialParticipantNames", &update.added_participant_names),
    ] {
        let mut seen = HashSet::new();
        let values = metadata
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .chain(additions.iter().map(String::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty() && seen.insert((*value).to_string()))
            .map(|value| Value::String(value.to_string()))
            .collect::<Vec<_>>();
        metadata.insert(key.to_string(), Value::Array(values));
    }
    Ok(Value::Object(metadata))
}

pub(super) fn add_canonical_group_members_in_db(
    conn: &mut Connection,
    request: AddCanonicalGroupMembersRequest,
) -> Result<CanonicalGroupMembershipDelta, String> {
    let AddCanonicalGroupMembersRequest {
        sessions: requested_sessions,
        identity_ids: requested_identity_ids,
        added_by_identity_id,
        join_events: requested_join_events,
    } = request;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let added_by_identity_id = added_by_identity_id.trim();
    if added_by_identity_id.is_empty() {
        return Err("Group member inviter is required".to_string());
    }

    let mut seen_session_ids = HashSet::new();
    let updates = requested_sessions
        .into_iter()
        .filter_map(|mut update| {
            update.session_id = update.session_id.trim().to_string();
            if update.session_id.is_empty() || !seen_session_ids.insert(update.session_id.clone()) {
                return None;
            }
            Some(update)
        })
        .collect::<Vec<_>>();
    if updates.is_empty() {
        return Err("At least one group session is required".to_string());
    }
    let mut seen_identity_ids = HashSet::new();
    let identity_ids = requested_identity_ids
        .into_iter()
        .map(|identity_id| identity_id.trim().to_string())
        .filter(|identity_id| {
            !identity_id.is_empty() && seen_identity_ids.insert(identity_id.clone())
        })
        .collect::<Vec<_>>();
    if identity_ids.is_empty() {
        return Err("At least one group member is required".to_string());
    }
    let identity_id_set = identity_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut seen_join_event_ids = HashSet::new();
    let mut join_events = Vec::new();
    for mut event in requested_join_events {
        event.event_id = event.event_id.trim().to_string();
        event.member_identity_id = event.member_identity_id.trim().to_string();
        if event.event_id.is_empty()
            || event.event_id.len() > 80
            || !event.event_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err("Group member join event id is invalid".to_string());
        }
        if !identity_id_set.contains(event.member_identity_id.as_str()) {
            return Err("Group member join event does not match an invited member".to_string());
        }
        if seen_join_event_ids.insert(event.event_id.clone()) {
            join_events.push(event);
        }
    }

    for update in &updates {
        require_group_member(
            &transaction,
            update.session_id.trim(),
            Some(added_by_identity_id),
            "invite people to this group",
        )?;
    }
    let invited_by_display_name = identity_display_name(&transaction, added_by_identity_id)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Someone".to_string());
    let join_events = join_events
        .into_iter()
        .map(|event| {
            let member_display_name =
                identity_display_name(&transaction, event.member_identity_id.as_str())?
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "Someone".to_string());
            Ok((event, member_display_name))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut messages = Vec::with_capacity(updates.len() * join_events.len());
    for update in &updates {
        let session_id = update.session_id.trim();
        add_session_participants_in_db(
            &transaction,
            session_id,
            &identity_ids,
            added_by_identity_id,
        )?;
        let metadata = merge_group_membership_metadata(&transaction, update)?;
        set_session_metadata_in_db(&transaction, session_id, metadata)?;
        for (event, member_display_name) in &join_events {
            let message_id = format!("msg:group-member-join:{}:{}", event.event_id, session_id);
            messages.push(append_message_in_db(
                &transaction,
                AppendCanonicalMessageRequest {
                    id: Some(message_id.clone()),
                    session_id: session_id.to_string(),
                    sender_identity_id: added_by_identity_id.to_string(),
                    sender_role: "system".to_string(),
                    message_kind: "status".to_string(),
                    content_text: format!(
                        "{member_display_name} joined the group, invited by {invited_by_display_name}."
                    ),
                    content: Some(json!({
                        "kind": "group-member-joined",
                        "eventId": event.event_id,
                        "memberIdentityId": event.member_identity_id,
                        "memberDisplayName": member_display_name,
                        "invitedByIdentityId": added_by_identity_id,
                        "invitedByDisplayName": invited_by_display_name,
                    })),
                    created_at_ms: Some(event.created_at_ms),
                    parent_message_id: None,
                    delegated_exchange_id: None,
                    status: Some("complete".to_string()),
                    source_transport: Some("group-member-join".to_string()),
                    source_event_id: Some(message_id),
                },
            )?);
        }
    }

    let mut sessions = Vec::with_capacity(updates.len());
    let mut participants = Vec::new();
    for update in &updates {
        let session_id = update.session_id.trim();
        sessions.push(
            select_session(&transaction, session_id)?
                .ok_or_else(|| "Group session not found after member update".to_string())?,
        );
        participants.extend(select_session_participants(&transaction, session_id)?);
    }
    transaction.commit().map_err(|err| err.to_string())?;
    Ok(CanonicalGroupMembershipDelta {
        sessions,
        participants,
        messages,
    })
}

pub(in crate::canonical_sessions) fn desktop_canonical_add_group_members_fast(
    request: AddCanonicalGroupMembersRequest,
) -> Result<CanonicalGroupMembershipDelta, String> {
    let mut conn = open_db()?;
    add_canonical_group_members_in_db(&mut conn, request)
}

pub(in crate::canonical_sessions) fn desktop_canonical_remove_session_participant(
    request: RemoveCanonicalSessionParticipantRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    require_group_member_removal_permission(
        &conn,
        &request.session_id,
        request.removed_by_identity_id.as_deref(),
        &request.identity_id,
    )?;
    remove_session_participant_in_db(&conn, &request.session_id, &request.identity_id)?;
    load_state_from_db(&conn)
}

pub(in crate::canonical_sessions) fn desktop_canonical_set_session_participant_role(
    request: SetCanonicalSessionParticipantRoleRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    require_group_creator(
        &conn,
        &request.session_id,
        request.requested_by_identity_id.as_deref(),
        "change group admins",
    )?;
    set_session_participant_role_in_db(
        &conn,
        &request.session_id,
        &request.identity_id,
        &request.role,
    )?;
    load_state_from_db(&conn)
}
