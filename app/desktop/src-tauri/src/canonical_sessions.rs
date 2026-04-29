use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

mod bridge_identities;
mod bridge_routing;
mod bridge_sync;
mod commands;
mod core;
mod desktop_sync;
mod message_reconcile;
mod models;
mod parent_sessions;
mod presence;
mod prompt_context;
mod sanitization;
mod schema;
#[cfg(test)]
mod tests;

pub use self::models::*;
pub(crate) use self::prompt_context::{
    bridge_agent_parent_session_prompt, local_agent_session_prompt_context,
};
pub(crate) use self::sanitization::sanitize_shared_agent_response_text;
pub(crate) use commands::{archive_session, delete_session, session_exists};

#[cfg(test)]
use self::bridge_identities::{
    bridge_human_display_name, bridge_human_identity_for_node,
    cleanup_bridge_fallback_identity_for_session, cleanup_unmentioned_agent_participants,
};
#[cfg(test)]
use self::bridge_routing::{
    bridge_conversation_has_unrouted_direct_messages, message_scoped_outreach_groups,
};
pub(crate) use self::bridge_sync::{sync_bridge_state_identities, sync_bridge_state_sessions};
pub(crate) use self::core::canonical_bridge_session_id;
use self::core::{
    canonical_sessions_db_path, canonical_storage_root, hash_hex, now_ms, stable_profile_id,
};
pub(crate) use self::desktop_sync::sync_desktop_chat_state;
#[cfg(test)]
use self::desktop_sync::{
    explicit_desktop_project_membership, should_skip_shared_local_agent_runtime_prompt,
    should_sync_desktop_chat_detail, should_sync_desktop_chat_summary,
    should_update_desktop_session_shell,
};
#[cfg(test)]
use self::parent_sessions::{
    store_outreach_context_snapshot, sync_bridge_outreach_into_parent_session,
    sync_parent_session_snapshot_messages,
};
use self::presence::update_presence_in_db;
use self::schema::{ensure_local_profile, initialize_schema};

const CANONICAL_SESSIONS_DB_FILENAME: &str = "canonical-sessions.sqlite3";
const SCHEMA_VERSION: i64 = 1;

fn stable_session_id(request: &OpenCanonicalSessionRequest) -> String {
    let seed = [
        request.kind.trim(),
        request.created_by_identity_id.trim(),
        request
            .relationship_identity_id
            .as_deref()
            .unwrap_or_default()
            .trim(),
        request
            .primary_identity_id
            .as_deref()
            .unwrap_or_default()
            .trim(),
        request.project_id.as_deref().unwrap_or_default().trim(),
    ]
    .join("|");
    format!("session:{}", hash_hex(&seed, 16))
}

fn identity_display_name(conn: &Connection, identity_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT display_name FROM identities WHERE id = ?1",
        params![identity_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn shared_agent_display_name(
    conn: &Connection,
    identity_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT agent.display_name, owner.display_name
         FROM identities agent
         LEFT JOIN identities owner ON owner.id = agent.owner_identity_id
         WHERE agent.id = ?1 AND agent.kind = 'agent'",
        params![identity_id],
        |row| {
            let agent_name: String = row.get(0)?;
            let owner_name: Option<String> = row.get(1)?;
            Ok(owner_name
                .map(|owner| {
                    let prefix = format!("{}'s ", owner);
                    if agent_name.starts_with(&prefix) {
                        agent_name.clone()
                    } else {
                        format!("{}{}", prefix, agent_name)
                    }
                })
                .unwrap_or(agent_name))
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn receiver_identity_ids(request: &OpenCanonicalSessionRequest) -> Vec<String> {
    let mut receiver_ids = Vec::new();
    let mut push_receiver = |identity_id: Option<&String>| {
        let Some(identity_id) = identity_id.map(String::as_str).map(str::trim) else {
            return;
        };
        if identity_id.is_empty() || identity_id == request.created_by_identity_id.trim() {
            return;
        }
        if !receiver_ids.iter().any(|existing| existing == identity_id) {
            receiver_ids.push(identity_id.to_string());
        }
    };

    push_receiver(request.primary_identity_id.as_ref());
    push_receiver(request.relationship_identity_id.as_ref());
    for participant_id in &request.participant_identity_ids {
        push_receiver(Some(participant_id));
    }

    receiver_ids
}

fn default_session_title(
    conn: &Connection,
    request: &OpenCanonicalSessionRequest,
) -> Result<String, String> {
    if let Some(title) = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(title.to_string());
    }
    if let Some(project_name) = request
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(project_name.to_string());
    }

    for identity_id in receiver_identity_ids(request) {
        if let Some(display_name) = identity_display_name(conn, &identity_id)?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Ok(display_name);
        }
        return Ok(identity_id);
    }

    Ok("New session".to_string())
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn validate_identity_kind(kind: &str) -> Result<String, String> {
    let normalized = kind.trim().to_lowercase();
    if matches!(normalized.as_str(), "human" | "agent") {
        Ok(normalized)
    } else {
        Err("Identity kind must be human or agent".to_string())
    }
}

fn validate_session_kind(kind: &str) -> Result<String, String> {
    let normalized = kind.trim().to_lowercase();
    if matches!(
        normalized.as_str(),
        "self-agent" | "direct-person" | "direct-agent" | "relationship" | "group" | "project"
    ) {
        Ok(normalized)
    } else {
        Err("Unsupported canonical session kind".to_string())
    }
}

fn validate_status(value: Option<String>, fallback: &str) -> String {
    value
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn json_to_db(value: &Option<Value>) -> Result<Option<String>, String> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| err.to_string())
}

fn json_from_db(value: Option<String>) -> Option<Value> {
    value.and_then(|raw| serde_json::from_str(&raw).ok())
}

fn canonical_identity_id(request: &UpsertCanonicalIdentityRequest, kind: &str) -> String {
    if let Some(id) = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return id.to_string();
    }

    if kind == "human" {
        if let Some(human_id) = request
            .human_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return format!("human:{human_id}");
        }
        if let Some(node_id) = request
            .bridge_node_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return format!("human:bridge-node:{node_id}");
        }
        return format!("human:local:{}", hash_hex(&request.display_name, 8));
    }

    if let Some(agent_id) = request
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("agent:{agent_id}");
    }
    if let Some(node_id) = request
        .bridge_node_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("agent:bridge-node:{node_id}");
    }
    format!("agent:local:{}", hash_hex(&request.display_name, 8))
}

fn canonical_avatar_key(request: &UpsertCanonicalIdentityRequest, kind: &str, id: &str) -> String {
    request
        .avatar_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if kind == "human" {
                request
                    .human_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            } else {
                request
                    .agent_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            }
        })
        .or_else(|| {
            request
                .bridge_node_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(id)
        .to_string()
}

fn open_db() -> Result<Connection, String> {
    let path = canonical_sessions_db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let conn = Connection::open(path).map_err(|err| err.to_string())?;
    initialize_schema(&conn)?;
    Ok(conn)
}

fn upsert_identity_in_db(
    conn: &Connection,
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalIdentity, String> {
    let kind = validate_identity_kind(&request.kind)?;
    let display_name = request.display_name.trim();
    if display_name.is_empty() {
        return Err("Identity display name is required".to_string());
    }
    let id = canonical_identity_id(&request, &kind);
    let avatar_key = canonical_avatar_key(&request, &kind, &id);
    let source = request
        .source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local")
        .to_string();
    let metadata = json_to_db(&request.metadata)?;
    let now = now_ms();

    conn.execute(
        "INSERT INTO identities(
             id, kind, display_name, owner_identity_id, source, source_host_id, bridge_node_id,
             human_id, agent_id, avatar_key, profile_image_url, metadata_json, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             display_name = excluded.display_name,
             owner_identity_id = excluded.owner_identity_id,
             source = excluded.source,
             source_host_id = excluded.source_host_id,
             bridge_node_id = excluded.bridge_node_id,
             human_id = excluded.human_id,
             agent_id = excluded.agent_id,
             avatar_key = excluded.avatar_key,
             profile_image_url = excluded.profile_image_url,
             metadata_json = excluded.metadata_json,
             updated_at_ms = excluded.updated_at_ms",
        params![
            id,
            kind,
            display_name,
            clean_optional(request.owner_identity_id),
            source,
            clean_optional(request.source_host_id),
            clean_optional(request.bridge_node_id),
            clean_optional(request.human_id),
            clean_optional(request.agent_id),
            avatar_key,
            clean_optional(request.profile_image_url),
            metadata,
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;

    select_identity(conn, &id)?.ok_or_else(|| "Unable to save canonical identity".to_string())
}

fn select_identity(conn: &Connection, id: &str) -> Result<Option<CanonicalIdentity>, String> {
    conn.query_row(
        "SELECT id, kind, display_name, owner_identity_id, source, source_host_id, bridge_node_id,
                human_id, agent_id, avatar_key, profile_image_url, metadata_json, created_at_ms, updated_at_ms
         FROM identities WHERE id = ?1",
        params![id],
        |row| {
            Ok(CanonicalIdentity {
                id: row.get(0)?,
                kind: row.get(1)?,
                display_name: row.get(2)?,
                owner_identity_id: row.get(3)?,
                source: row.get(4)?,
                source_host_id: row.get(5)?,
                bridge_node_id: row.get(6)?,
                human_id: row.get(7)?,
                agent_id: row.get(8)?,
                avatar_key: row.get(9)?,
                profile_image_url: row.get(10)?,
                metadata: json_from_db(row.get(11)?),
                created_at_ms: row.get(12)?,
                updated_at_ms: row.get(13)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn open_or_create_session_in_db(
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
    let title = default_session_title(conn, &request)?;
    let status = validate_status(request.status, "active");
    let metadata = json_to_db(&request.metadata)?;
    let now = now_ms();

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
            request.created_by_identity_id,
            clean_optional(request.primary_identity_id),
            clean_optional(request.project_id),
            clean_optional(request.project_name),
            clean_optional(request.relationship_identity_id),
            metadata,
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;

    upsert_participant(
        conn,
        &id,
        &request.created_by_identity_id,
        "self",
        Some(&request.created_by_identity_id),
        now,
    )?;
    for participant in request.participant_identity_ids {
        let participant = participant.trim();
        if participant.is_empty() || participant == request.created_by_identity_id {
            continue;
        }
        upsert_participant(
            conn,
            &id,
            participant,
            "delegate",
            Some(&request.created_by_identity_id),
            now,
        )?;
    }

    select_session(conn, &id)?.ok_or_else(|| "Unable to save canonical session".to_string())
}

fn upsert_participant(
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

fn session_has_participant(
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

fn similar_agent_message_exists(
    conn: &Connection,
    session_id: &str,
    content_text: &str,
    source_transport: &str,
    created_at_ms: i64,
    match_window_ms: i64,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM session_messages
            WHERE session_id = ?1
              AND message_kind = 'agent-turn'
              AND sender_role IN ('owned-agent', 'external-agent')
              AND content_text = ?2
              AND source_transport = ?3
              AND ABS(created_at_ms - ?4) <= ?5
         )",
        params![
            session_id,
            content_text,
            source_transport,
            created_at_ms,
            match_window_ms
        ],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|err| err.to_string())
}

fn existing_delegation_join_message_id(
    conn: &Connection,
    session_id: &str,
    target_identity_id: &str,
    target_kind: &str,
    target_display_name: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id
         FROM session_messages
         WHERE session_id = ?1
           AND message_kind = 'status'
           AND json_extract(content_json, '$.kind') = 'delegation-join-event'
           AND json_extract(content_json, '$.targetKind') = ?3
           AND (
             json_extract(content_json, '$.targetIdentityId') = ?2
             OR json_extract(content_json, '$.targetDisplayName') = ?4
           )
         ORDER BY created_at_ms ASC, sequence_num ASC
         LIMIT 1",
        params![
            session_id,
            target_identity_id,
            target_kind,
            target_display_name
        ],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn session_message_count(conn: &Connection, session_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

fn select_session(conn: &Connection, id: &str) -> Result<Option<CanonicalSession>, String> {
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

fn append_message_in_db(
    conn: &Connection,
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    if let (Some(source_transport), Some(source_event_id)) =
        (&request.source_transport, &request.source_event_id)
    {
        if let Some(existing) = select_message_by_source(conn, source_transport, source_event_id)? {
            return Ok(existing);
        }
    }

    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("msg:{}", Uuid::new_v4().simple()));
    let now = now_ms();
    let created_at_ms = request.created_at_ms.unwrap_or(now);
    let sequence_num: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sequence_num), 0) + 1 FROM session_messages WHERE session_id = ?1",
            params![request.session_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let content = json_to_db(&request.content)?;
    let content_hash = hash_hex(
        &format!(
            "{}|{}",
            request.content_text,
            content.clone().unwrap_or_default()
        ),
        16,
    );
    let status = validate_status(request.status, "sent");

    conn.execute(
        "INSERT INTO session_messages(
             id, session_id, sender_identity_id, sender_role, message_kind, content_text, content_json,
             parent_message_id, delegated_exchange_id, status, sequence_num, created_at_ms, updated_at_ms,
             content_hash, source_transport, source_event_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            id,
            request.session_id,
            request.sender_identity_id,
            request.sender_role,
            request.message_kind,
            request.content_text,
            content,
            clean_optional(request.parent_message_id),
            clean_optional(request.delegated_exchange_id),
            status,
            sequence_num,
            created_at_ms,
            now,
            content_hash,
            clean_optional(request.source_transport),
            clean_optional(request.source_event_id),
        ],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE sessions
         SET updated_at_ms = ?1,
             last_message_at_ms = MAX(COALESCE(last_message_at_ms, 0), ?2)
         WHERE id = ?3",
        params![now, created_at_ms, request.session_id],
    )
    .map_err(|err| err.to_string())?;

    select_message(conn, &id)?.ok_or_else(|| "Unable to save canonical message".to_string())
}

fn select_message_by_source(
    conn: &Connection,
    source_transport: &str,
    source_event_id: &str,
) -> Result<Option<CanonicalSessionMessage>, String> {
    conn.query_row(
        "SELECT id FROM session_messages WHERE source_transport = ?1 AND source_event_id = ?2",
        params![source_transport, source_event_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())?
    .map(|id| select_message(conn, &id))
    .transpose()
    .map(|value| value.flatten())
}

fn select_message(conn: &Connection, id: &str) -> Result<Option<CanonicalSessionMessage>, String> {
    conn.query_row(
        "SELECT id, session_id, sender_identity_id, sender_role, message_kind, content_text, content_json,
                parent_message_id, delegated_exchange_id, status, sequence_num, created_at_ms, updated_at_ms,
                content_hash, source_transport, source_event_id
         FROM session_messages WHERE id = ?1",
        params![id],
        |row| {
            Ok(CanonicalSessionMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                sender_identity_id: row.get(2)?,
                sender_role: row.get(3)?,
                message_kind: row.get(4)?,
                content_text: row.get(5)?,
                content: json_from_db(row.get(6)?),
                parent_message_id: row.get(7)?,
                delegated_exchange_id: row.get(8)?,
                status: row.get(9)?,
                sequence_num: row.get(10)?,
                created_at_ms: row.get(11)?,
                updated_at_ms: row.get(12)?,
                content_hash: row.get(13)?,
                source_transport: row.get(14)?,
                source_event_id: row.get(15)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn create_delegated_exchange_in_db(
    conn: &Connection,
    request: CreateCanonicalDelegatedExchangeRequest,
) -> Result<CanonicalDelegatedExchange, String> {
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("delegation:{}", Uuid::new_v4().simple()));
    let session_id = request.session_id.clone();
    let target_identity_id = request.target_identity_id.clone();
    let request_message_id = clean_optional(request.request_message_id.clone());
    let bridge_request_id = clean_optional(request.bridge_request_id.clone());
    if bridge_request_id.is_some() {
        if let Some(request_message_id) = request_message_id.as_deref() {
            conn.execute(
                "DELETE FROM delegated_exchanges
                 WHERE session_id = ?1
                   AND target_identity_id = ?2
                   AND request_message_id = ?3
                   AND bridge_request_id IS NULL
                   AND id <> ?4
                   AND status IN ('pending', 'sending', 'processing')",
                params![session_id, target_identity_id, request_message_id, id],
            )
            .map_err(|err| err.to_string())?;
        }
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO delegated_exchanges(
             id, session_id, initiator_identity_id, target_identity_id, trigger_message_id, request_message_id,
             response_message_id, transport, bridge_host_id, bridge_conversation_id, bridge_request_id,
             context_policy, status, error, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             response_message_id = excluded.response_message_id,
             error = excluded.error,
             updated_at_ms = excluded.updated_at_ms",
        params![
            id,
            session_id,
            request.initiator_identity_id,
            target_identity_id,
            clean_optional(request.trigger_message_id),
            request_message_id,
            clean_optional(request.response_message_id),
            validate_status(request.transport, "bridge"),
            clean_optional(request.bridge_host_id),
            clean_optional(request.bridge_conversation_id),
            bridge_request_id,
            validate_status(request.context_policy, "recent-window"),
            validate_status(request.status, "pending"),
            clean_optional(request.error),
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;

    select_delegated_exchange(conn, &id)?
        .ok_or_else(|| "Unable to save delegated exchange".to_string())
}

fn select_delegated_exchange(
    conn: &Connection,
    id: &str,
) -> Result<Option<CanonicalDelegatedExchange>, String> {
    conn.query_row(
        "SELECT id, session_id, initiator_identity_id, target_identity_id, trigger_message_id,
                request_message_id, response_message_id, transport, bridge_host_id,
                bridge_conversation_id, bridge_request_id, context_policy, status, error,
                created_at_ms, updated_at_ms
         FROM delegated_exchanges WHERE id = ?1",
        params![id],
        |row| {
            Ok(CanonicalDelegatedExchange {
                id: row.get(0)?,
                session_id: row.get(1)?,
                initiator_identity_id: row.get(2)?,
                target_identity_id: row.get(3)?,
                trigger_message_id: row.get(4)?,
                request_message_id: row.get(5)?,
                response_message_id: row.get(6)?,
                transport: row.get(7)?,
                bridge_host_id: row.get(8)?,
                bridge_conversation_id: row.get(9)?,
                bridge_request_id: row.get(10)?,
                context_policy: row.get(11)?,
                status: row.get(12)?,
                error: row.get(13)?,
                created_at_ms: row.get(14)?,
                updated_at_ms: row.get(15)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn runtime_is_agent_like(runtime: &str) -> bool {
    let normalized = runtime.trim().to_lowercase();
    ["agent", "claude", "codex", "openclaw", "pi", "bot", "kordi"]
        .iter()
        .any(|token| normalized.contains(token))
}

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

fn update_local_profile_identities(
    conn: &Connection,
    human_identity_id: Option<&str>,
    active_agent_identity_id: Option<&str>,
    display_name: Option<&str>,
) -> Result<(), String> {
    let profile = ensure_local_profile(conn)?;
    conn.execute(
        "UPDATE local_profile
         SET human_identity_id = COALESCE(?1, human_identity_id),
             active_agent_identity_id = COALESCE(?2, active_agent_identity_id),
             display_name = COALESCE(?3, display_name),
             updated_at_ms = ?4
         WHERE id = ?5",
        params![
            human_identity_id,
            active_agent_identity_id,
            display_name,
            now_ms(),
            profile.id
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn local_profile_human_identity_id(
    conn: &Connection,
    display_name: &str,
) -> Result<String, String> {
    let profile = ensure_local_profile(conn)?;
    if let Some(identity_id) = profile
        .human_identity_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(identity_id.to_string());
    }

    let identity = upsert_identity_in_db(
        conn,
        UpsertCanonicalIdentityRequest {
            id: Some(format!("human:{}", profile.id)),
            kind: "human".to_string(),
            display_name: display_name.to_string(),
            owner_identity_id: None,
            source: Some("local".to_string()),
            source_host_id: None,
            bridge_node_id: None,
            human_id: None,
            agent_id: None,
            avatar_key: Some(profile.id.clone()),
            profile_image_url: None,
            metadata: Some(serde_json::json!({ "profileId": profile.id })),
        },
    )?;
    update_local_profile_identities(conn, Some(identity.id.as_str()), None, Some(display_name))?;
    Ok(identity.id)
}

fn local_delegate_agent_name() -> &'static str {
    "Kordi"
}

fn local_agent_external_id(profile_id: &str, workspace_root: &str) -> String {
    format!(
        "local:{}",
        hash_hex(&format!("{profile_id}|{workspace_root}"), 16)
    )
}

fn reassign_stale_local_agent_identities(
    conn: &Connection,
    owner_identity_id: &str,
    workspace_root: &str,
    active_agent_identity_id: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM identities
             WHERE kind = 'agent'
               AND source = 'local'
               AND owner_identity_id = ?1
               AND id <> ?2
               AND json_extract(metadata_json, '$.workspaceRoot') = ?3",
        )
        .map_err(|err| err.to_string())?;
    let stale_ids = stmt
        .query_map(
            params![owner_identity_id, active_agent_identity_id, workspace_root],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    for stale_id in stale_ids {
        let mut participant_stmt = conn
            .prepare("SELECT session_id FROM session_participants WHERE identity_id = ?1")
            .map_err(|err| err.to_string())?;
        let session_ids = participant_stmt
            .query_map(params![stale_id.as_str()], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;

        for session_id in session_ids {
            let active_exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM session_participants WHERE session_id = ?1 AND identity_id = ?2",
                    params![session_id.as_str(), active_agent_identity_id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            if active_exists > 0 {
                conn.execute(
                    "DELETE FROM session_participants WHERE session_id = ?1 AND identity_id = ?2",
                    params![session_id.as_str(), stale_id.as_str()],
                )
                .map_err(|err| err.to_string())?;
            } else {
                conn.execute(
                    "UPDATE session_participants SET identity_id = ?1 WHERE session_id = ?2 AND identity_id = ?3",
                    params![active_agent_identity_id, session_id.as_str(), stale_id.as_str()],
                )
                .map_err(|err| err.to_string())?;
            }
        }

        conn.execute(
            "UPDATE sessions SET primary_identity_id = ?1 WHERE primary_identity_id = ?2",
            params![active_agent_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE session_messages SET sender_identity_id = ?1 WHERE sender_identity_id = ?2",
            params![active_agent_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE context_snapshots SET agent_identity_id = ?1 WHERE agent_identity_id = ?2",
            params![active_agent_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE delegated_exchanges SET initiator_identity_id = ?1 WHERE initiator_identity_id = ?2",
            params![active_agent_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE delegated_exchanges SET target_identity_id = ?1 WHERE target_identity_id = ?2",
            params![active_agent_identity_id, stale_id.as_str()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute("DELETE FROM identities WHERE id = ?1", params![stale_id])
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn local_agent_identity_id(
    conn: &Connection,
    human_identity_id: &str,
    agent_label: &str,
    workspace_root: &str,
) -> Result<String, String> {
    let profile = ensure_local_profile(conn)?;
    let runtime_label = agent_label.trim();
    let runtime_label_metadata = (!runtime_label.is_empty()).then(|| runtime_label.to_string());
    let delegate_agent_name = local_delegate_agent_name();
    let agent_id = local_agent_external_id(&profile.id, workspace_root);
    let identity = upsert_identity_in_db(
        conn,
        UpsertCanonicalIdentityRequest {
            id: Some(format!("agent:{agent_id}")),
            kind: "agent".to_string(),
            display_name: delegate_agent_name.to_string(),
            owner_identity_id: Some(human_identity_id.to_string()),
            source: Some("local".to_string()),
            source_host_id: None,
            bridge_node_id: None,
            human_id: None,
            agent_id: Some(agent_id.clone()),
            avatar_key: Some(agent_id.clone()),
            profile_image_url: None,
            metadata: Some(serde_json::json!({
                "profileId": profile.id,
                "workspaceRoot": workspace_root,
                "delegateAgentName": delegate_agent_name,
                "runtimeLabel": runtime_label_metadata,
                "ownerIdentityId": human_identity_id,
            })),
        },
    )?;
    reassign_stale_local_agent_identities(conn, human_identity_id, workspace_root, &identity.id)?;
    update_local_profile_identities(conn, None, Some(identity.id.as_str()), None)?;
    Ok(identity.id)
}

#[tauri::command]
pub fn desktop_canonical_session_state() -> Result<CanonicalSessionState, String> {
    commands::desktop_canonical_session_state()
}

#[tauri::command]
pub fn desktop_canonical_upsert_identity(
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalSessionState, String> {
    commands::desktop_canonical_upsert_identity(request)
}

#[tauri::command]
pub fn desktop_canonical_open_or_create_session(
    request: OpenCanonicalSessionRequest,
) -> Result<CanonicalSessionState, String> {
    commands::desktop_canonical_open_or_create_session(request)
}

#[tauri::command]
pub fn desktop_canonical_append_message(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionState, String> {
    commands::desktop_canonical_append_message(request)
}

#[tauri::command]
pub fn desktop_canonical_append_message_fast(
    request: AppendCanonicalMessageRequest,
) -> Result<String, String> {
    commands::desktop_canonical_append_message_fast(request)
}

#[tauri::command]
pub fn desktop_canonical_create_delegated_exchange(
    request: CreateCanonicalDelegatedExchangeRequest,
) -> Result<CanonicalSessionState, String> {
    commands::desktop_canonical_create_delegated_exchange(request)
}

#[tauri::command]
pub fn desktop_canonical_update_presence(
    request: UpdateCanonicalPresenceRequest,
) -> Result<CanonicalSessionState, String> {
    commands::desktop_canonical_update_presence(request)
}
