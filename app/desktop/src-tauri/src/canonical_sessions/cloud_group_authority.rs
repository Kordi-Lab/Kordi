//! Group authority comes from the authenticated sync snapshot, not message history.
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::CanonicalSession;

pub(super) struct GroupAuthority {
    pub creator: String,
    pub admins: Vec<String>,
    pub members: Vec<String>,
    group_space_id: Option<String>,
}

fn identity_id(conn: &Connection, account: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT id FROM identities WHERE kind='human' AND (human_id=?1 OR bridge_node_id=?1)
         ORDER BY (id=(SELECT human_identity_id FROM local_profile LIMIT 1)) DESC,
                  (id='human:'||?1) DESC, id LIMIT 1",
        [account],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| error.to_string())
    .map(|id| id.unwrap_or_else(|| format!("human:{account}")))
}

pub(super) fn read(conn: &Connection, session_id: &str) -> Result<Option<GroupAuthority>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT cache.snapshot_json FROM chat_sync_conversations cache
         JOIN local_profile profile ON 1=1
         JOIN identities viewer ON viewer.id=profile.human_identity_id
         WHERE cache.client_session_id=?1
           AND (cache.account_id=viewer.human_id OR cache.account_id=viewer.bridge_node_id)
           AND json_extract(cache.snapshot_json,'$.kind')='group'
         ORDER BY cache.version DESC LIMIT 1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else { return Ok(None) };
    let snapshot: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let members = snapshot["members"]
        .as_array()
        .ok_or("Reliable group membership is unavailable")?;
    let creator = snapshot["created_by_account_id"]
        .as_str()
        .filter(|id| !id.trim().is_empty())
        .ok_or("Reliable group owner is unavailable")?;
    let mut authority = GroupAuthority {
        creator: identity_id(conn, creator)?,
        admins: Vec::new(),
        members: Vec::new(),
        group_space_id: snapshot["group_space_id"]
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
    };
    for member in members {
        if member["membership_state"] != "active" {
            continue;
        }
        let account = member["account_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Reliable group member identity is unavailable")?;
        let id = identity_id(conn, account)?;
        authority.members.push(id.clone());
        if matches!(member["role"].as_str(), Some("owner" | "admin")) {
            authority.admins.push(id.clone());
        }
        if member["role"] == "owner" {
            authority.creator = id;
        }
    }
    Ok(Some(authority))
}

pub(super) fn project_session(
    conn: &Connection,
    session: &mut CanonicalSession,
) -> Result<(), String> {
    if session.kind != "group" {
        return Ok(());
    }
    let Some(authority) = read(conn, &session.id)? else {
        return Ok(());
    };
    let mut metadata = session
        .metadata
        .take()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    metadata.insert("groupCreatorIdentityId".into(), json!(authority.creator));
    metadata.insert("adminIdentityIds".into(), json!(authority.admins));
    if let Some(group) = authority.group_space_id {
        metadata.insert("groupSpaceId".into(), json!(group));
        metadata.insert("groupId".into(), json!(group));
    }
    session.metadata = Some(Value::Object(metadata));
    Ok(())
}

pub(super) fn project_participants(
    conn: &Connection,
    sessions: &[CanonicalSession],
    participants: &mut [super::CanonicalSessionParticipant],
) -> Result<(), String> {
    for session in sessions.iter().filter(|session| session.kind == "group") {
        let Some(authority) = read(conn, &session.id)? else {
            continue;
        };
        for participant in participants
            .iter_mut()
            .filter(|p| p.session_id == session.id)
        {
            let human = conn
                .query_row(
                    "SELECT kind='human' FROM identities WHERE id=?1",
                    [&participant.identity_id],
                    |row| row.get::<_, bool>(0),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .unwrap_or(false);
            if !human {
                continue;
            }
            participant.state = if authority.members.contains(&participant.identity_id) {
                "active"
            } else {
                "left"
            }
            .into();
            if participant.role != "self" {
                participant.role = if authority.admins.contains(&participant.identity_id) {
                    "admin"
                } else {
                    "person"
                }
                .into();
            }
        }
    }
    Ok(())
}
