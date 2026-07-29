use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{Map, Value};
use uuid::Uuid;

mod canonical_fork;
mod commands;
mod core;
mod desktop_sync;
mod group_participants;
mod identity_context;
mod identity_helpers;
mod message_lookup;
mod message_reconcile;
mod models;
mod presence;
mod prompt_context;
mod sanitization;
mod schema;
mod session_observation;
#[cfg(test)]
mod tests;

pub use self::models::*;
pub(crate) use self::prompt_context::{
    local_agent_session_prompt_context, local_agent_session_task_records,
};
pub(crate) use commands::{archive_session, delete_session, session_exists};

pub(crate) use self::canonical_fork::fork_canonical_session_into_local_chat;
use self::core::{
    canonical_sessions_db_path, canonical_storage_root, hash_hex, now_ms, stable_profile_id,
};
pub(crate) use self::desktop_sync::{
    canonical_session_message_id_for_entry, sync_desktop_chat_state,
};
#[cfg(test)]
use self::desktop_sync::{
    enrich_similar_bridge_agent_message_with_desktop_runtime, explicit_desktop_project_membership,
    reconcile_processing_bridge_agent_placeholder_with_desktop_runtime,
    should_skip_shared_local_agent_runtime_prompt, should_sync_desktop_chat_detail,
    should_sync_desktop_chat_summary, should_update_desktop_session_shell,
};
#[cfg(test)]
pub(crate) use self::group_participants::group_admin_identity_ids;
#[cfg(test)]
pub(crate) use self::group_participants::rename_session_in_db;
pub(crate) use self::group_participants::{
    add_session_participants_in_db, remove_session_participant_in_db,
    rename_any_session_title_in_db, rename_session_in_db_with_actor_account, require_group_admin,
    require_group_creator, require_group_member, require_group_member_removal_permission,
    set_session_metadata_in_db, set_session_participant_role_in_db,
};
pub(crate) use self::identity_context::{
    render_multi_participant_identity_context, IdentityContextParticipant,
    IdentityContextPermissions, IdentityContextRequest, IdentityContextRole,
};
use self::identity_helpers::{
    canonical_avatar_key, canonical_identity_id, default_session_title,
    replace_identity_in_json_value, stable_session_id, validate_identity_kind,
    validate_session_kind,
};
pub(crate) use self::identity_helpers::{
    clean_optional, identity_display_name, json_from_db, json_to_db, validate_status,
};
pub(crate) use self::message_lookup::{
    canonical_message_exists, similar_agent_message_exists, similar_agent_message_text,
};
use self::presence::update_presence_in_db;
use self::schema::{ensure_local_profile, initialize_schema};
pub(crate) use self::session_observation::{
    read_session_for_observation, search_sessions_for_observation,
};

const CANONICAL_SESSIONS_DB_FILENAME: &str = "canonical-sessions.sqlite3";
const SCHEMA_VERSION: i64 = 1;

fn open_db() -> Result<Connection, String> {
    let path = canonical_sessions_db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let conn = Connection::open(path).map_err(|err| err.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| err.to_string())?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;",
    )
    .map_err(|err| err.to_string())?;
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
    let existing_source_identity_id = if request
        .id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        None
    } else if let Some(source_identity_id) = request
        .bridge_node_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        conn.query_row(
            "SELECT id
             FROM identities
             WHERE kind = ?1 AND bridge_node_id = ?2
             ORDER BY updated_at_ms DESC
             LIMIT 1",
            params![kind, source_identity_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
    } else {
        None
    };
    let id = existing_source_identity_id.unwrap_or_else(|| canonical_identity_id(&request, &kind));
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
             profile_image_url = COALESCE(excluded.profile_image_url, identities.profile_image_url),
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

fn normalized_session_title_source(value: Option<&str>) -> Option<&'static str> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "placeholder" => Some("placeholder"),
        "auto" => Some("auto"),
        "imported" => Some("imported"),
        "external" => Some("external"),
        "legacy" => Some("legacy"),
        "manual" => Some("manual"),
        _ => None,
    }
}

fn explicit_session_title_source(
    metadata: &Map<String, Value>,
    kind: &str,
) -> Option<&'static str> {
    normalized_session_title_source(
        metadata
            .get("sessionTitleSource")
            .and_then(Value::as_str)
            .or_else(|| {
                (kind != "group")
                    .then(|| metadata.get("titleSource").and_then(Value::as_str))
                    .flatten()
            }),
    )
}

fn title_source_precedence(source: &str) -> u8 {
    match source {
        "manual" => 4,
        "imported" | "external" => 3,
        "legacy" => 2,
        "auto" => 1,
        _ => 0,
    }
}

fn canonical_title_is_placeholder(kind: &str, title: &str) -> bool {
    let normalized = title.trim().to_ascii_lowercase();
    kordi_session::naming::is_placeholder_or_weak_legacy_title(title, "")
        || (kind == "group" && normalized == "group")
        || (matches!(kind, "self-agent" | "project")
            && matches!(
                normalized.as_str(),
                "kordi" | "my kordi" | "my agent" | "my kordi session" | "my agent session"
            ))
}

fn inferred_session_title_source(kind: &str, title: &str) -> &'static str {
    if canonical_title_is_placeholder(kind, title) {
        "placeholder"
    } else if matches!(kind, "direct-person" | "direct-agent" | "relationship") {
        "external"
    } else {
        "legacy"
    }
}

fn title_metadata_i64(metadata: &Map<String, Value>, key: &str) -> i64 {
    metadata
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or_default()
}

fn title_metadata_string(metadata: &Map<String, Value>, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn incoming_title_actor_wins(existing: Option<&str>, incoming: Option<&str>) -> bool {
    match (existing, incoming) {
        (Some(existing), Some(incoming)) => incoming < existing,
        (None, Some(_)) => true,
        _ => false,
    }
}

fn copy_title_metadata(target: &mut Map<String, Value>, source: &Map<String, Value>, kind: &str) {
    for key in [
        "sessionTitleSource",
        "sessionTitleRevision",
        "sessionTitlePolicyVersion",
        "sessionTitleUpdatedAtMs",
        "sessionTitleUpdatedByAccountId",
        "sessionTitleGeneratedFromMessageId",
    ] {
        if let Some(value) = source.get(key) {
            target.insert(key.to_string(), value.clone());
        } else {
            target.remove(key);
        }
    }
    if kind != "group" {
        if let Some(value) = source.get("titleSource") {
            target.insert("titleSource".to_string(), value.clone());
        } else {
            target.remove("titleSource");
        }
    }
}

fn preserve_string_metadata_key(
    target: &mut Map<String, Value>,
    existing: &Map<String, Value>,
    key: &str,
) {
    if target
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return;
    }
    if let Some(value) = existing
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        target.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn preserve_metadata_key(
    target: &mut Map<String, Value>,
    existing: &Map<String, Value>,
    key: &str,
) {
    if target.get(key).is_some() {
        return;
    }
    if let Some(value) = existing.get(key) {
        target.insert(key.to_string(), value.clone());
    }
}

fn reconcile_session_title_metadata(
    existing_session: Option<&CanonicalSession>,
    kind: &str,
    incoming_title: String,
    metadata: Option<Value>,
) -> (String, Option<Value>) {
    let existing_metadata = existing_session
        .and_then(|session| session.metadata.as_ref())
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut next_metadata = match metadata {
        Some(Value::Object(map)) => map,
        Some(other) => return (incoming_title, Some(other)),
        None => Map::new(),
    };

    preserve_string_metadata_key(&mut next_metadata, &existing_metadata, "customName");
    preserve_string_metadata_key(&mut next_metadata, &existing_metadata, "groupId");
    preserve_string_metadata_key(&mut next_metadata, &existing_metadata, "groupSpaceId");
    preserve_metadata_key(
        &mut next_metadata,
        &existing_metadata,
        "groupNameUpdatedAtMs",
    );
    preserve_metadata_key(&mut next_metadata, &existing_metadata, "fork");
    if next_metadata.get("fork").is_some() {
        if let Some(Value::String(existing_created_from)) = existing_metadata.get("createdFrom") {
            if existing_created_from.contains("fork") {
                next_metadata.insert(
                    "createdFrom".to_string(),
                    Value::String(existing_created_from.clone()),
                );
            }
        }
    }

    let incoming_explicit_source = explicit_session_title_source(&next_metadata, kind);
    let incoming_source = incoming_explicit_source.unwrap_or_else(|| {
        if matches!(kind, "self-agent" | "project")
            && !canonical_title_is_placeholder(kind, &incoming_title)
        {
            "auto"
        } else {
            inferred_session_title_source(kind, &incoming_title)
        }
    });
    let incoming_source = if matches!(incoming_source, "auto" | "legacy")
        && canonical_title_is_placeholder(kind, &incoming_title)
    {
        "placeholder"
    } else {
        incoming_source
    };
    let incoming_revision = title_metadata_i64(&next_metadata, "sessionTitleRevision");
    let incoming_updated_at = title_metadata_i64(&next_metadata, "sessionTitleUpdatedAtMs");
    let incoming_updated_by =
        title_metadata_string(&next_metadata, "sessionTitleUpdatedByAccountId");

    let Some(existing_session) = existing_session else {
        let revision = if incoming_source == "placeholder" {
            0
        } else {
            incoming_revision.max(1)
        };
        next_metadata.insert(
            "sessionTitleSource".to_string(),
            Value::String(incoming_source.to_string()),
        );
        if kind != "group" {
            next_metadata.insert(
                "titleSource".to_string(),
                Value::String(incoming_source.to_string()),
            );
        }
        next_metadata.insert("sessionTitleRevision".to_string(), Value::from(revision));
        next_metadata.insert(
            "sessionTitlePolicyVersion".to_string(),
            Value::from(kordi_session::naming::SESSION_TITLE_POLICY_VERSION),
        );
        next_metadata
            .entry("sessionTitleUpdatedAtMs".to_string())
            .or_insert_with(|| Value::from(now_ms()));
        return (incoming_title, Some(Value::Object(next_metadata)));
    };

    let existing_source = explicit_session_title_source(&existing_metadata, kind)
        .unwrap_or_else(|| inferred_session_title_source(kind, &existing_session.title));
    let existing_source = if matches!(existing_source, "auto" | "legacy")
        && canonical_title_is_placeholder(kind, &existing_session.title)
    {
        "placeholder"
    } else {
        existing_source
    };
    let existing_revision = title_metadata_i64(&existing_metadata, "sessionTitleRevision");
    let existing_updated_at = title_metadata_i64(&existing_metadata, "sessionTitleUpdatedAtMs");
    let existing_updated_by =
        title_metadata_string(&existing_metadata, "sessionTitleUpdatedByAccountId");
    let incoming_is_explicit = incoming_explicit_source.is_some();
    let incoming_wins = if !incoming_is_explicit {
        if matches!(kind, "self-agent" | "project") {
            existing_source == "placeholder"
                && !canonical_title_is_placeholder(kind, &incoming_title)
        } else {
            !matches!(existing_source, "manual" | "imported")
        }
    } else {
        match title_source_precedence(incoming_source)
            .cmp(&title_source_precedence(existing_source))
        {
            std::cmp::Ordering::Greater => true,
            std::cmp::Ordering::Less => false,
            std::cmp::Ordering::Equal => match incoming_source {
                "auto" => {
                    (incoming_revision > existing_revision && incoming_revision <= 2)
                        || canonical_title_is_placeholder(kind, &existing_session.title)
                }
                "manual" | "imported" | "external" | "legacy" => {
                    incoming_updated_at > existing_updated_at
                        || (incoming_updated_at == existing_updated_at
                            && (incoming_revision > existing_revision
                                || (incoming_revision == existing_revision
                                    && incoming_title_actor_wins(
                                        existing_updated_by.as_deref(),
                                        incoming_updated_by.as_deref(),
                                    ))))
                }
                _ => canonical_title_is_placeholder(kind, &existing_session.title),
            },
        }
    };

    if !incoming_wins {
        copy_title_metadata(&mut next_metadata, &existing_metadata, kind);
        if explicit_session_title_source(&existing_metadata, kind).is_none() {
            let revision = if existing_source == "placeholder" {
                0
            } else {
                existing_revision.max(1)
            };
            next_metadata.insert(
                "sessionTitleSource".to_string(),
                Value::String(existing_source.to_string()),
            );
            if kind != "group" {
                next_metadata.insert(
                    "titleSource".to_string(),
                    Value::String(existing_source.to_string()),
                );
            }
            next_metadata.insert("sessionTitleRevision".to_string(), Value::from(revision));
            next_metadata.insert(
                "sessionTitlePolicyVersion".to_string(),
                Value::from(kordi_session::naming::SESSION_TITLE_POLICY_VERSION),
            );
            next_metadata.insert(
                "sessionTitleUpdatedAtMs".to_string(),
                Value::from(existing_session.updated_at_ms),
            );
        }
        return (
            existing_session.title.clone(),
            Some(Value::Object(next_metadata)),
        );
    }

    let revision = if incoming_source == "placeholder" {
        0
    } else {
        incoming_revision.max(1)
    };
    next_metadata.insert(
        "sessionTitleSource".to_string(),
        Value::String(incoming_source.to_string()),
    );
    if kind != "group" {
        next_metadata.insert(
            "titleSource".to_string(),
            Value::String(incoming_source.to_string()),
        );
    }
    next_metadata.insert("sessionTitleRevision".to_string(), Value::from(revision));
    next_metadata.insert(
        "sessionTitlePolicyVersion".to_string(),
        Value::from(kordi_session::naming::SESSION_TITLE_POLICY_VERSION),
    );
    next_metadata
        .entry("sessionTitleUpdatedAtMs".to_string())
        .or_insert_with(|| Value::from(now_ms()));
    (incoming_title, Some(Value::Object(next_metadata)))
}

pub(super) fn open_or_create_session_in_db(
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
    let default_title = default_session_title(conn, &request)?;
    let existing_session = select_session(conn, &id)?;
    let (title, metadata_value) = reconcile_session_title_metadata(
        existing_session.as_ref(),
        &kind,
        default_title,
        request.metadata,
    );
    let status = validate_status(request.status, "active");
    let metadata = json_to_db(&metadata_value)?;
    let participant_role = if kind == "group" {
        "person"
    } else {
        "delegate"
    };
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

    let local_group_self_identity_id = if kind == "group" {
        local_profile_self_identity_id(conn)?
    } else {
        None
    };
    let self_identity_id = local_group_self_identity_id
        .as_deref()
        .unwrap_or(request.created_by_identity_id.as_str());
    let created_by_role = if request.created_by_identity_id == self_identity_id {
        "self"
    } else if kind == "group" {
        "admin"
    } else {
        participant_role
    };
    upsert_participant(
        conn,
        &id,
        &request.created_by_identity_id,
        created_by_role,
        Some(&request.created_by_identity_id),
        now,
    )?;
    for participant in request.participant_identity_ids {
        let participant = participant.trim();
        if participant.is_empty() || participant == request.created_by_identity_id {
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
            Some(&request.created_by_identity_id),
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

fn enforce_only_local_group_self(
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

fn latest_readable_session_message_id(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id
         FROM session_messages
         WHERE session_id = ?1
           AND COALESCE(source_transport, '') NOT IN ('canonical-fork-snapshot', 'cloud-group-fork-snapshot')
           AND LOWER(TRIM(status)) NOT IN ('sending', 'processing')
         ORDER BY sequence_num DESC, created_at_ms DESC
         LIMIT 1",
        params![session_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn self_participant_identity_id(
    conn: &Connection,
    session_id: &str,
    preferred_identity_id: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(identity_id) = preferred_identity_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let exists = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM session_participants
                    WHERE session_id = ?1 AND identity_id = ?2 AND role = 'self'
                 )",
                params![session_id, identity_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|err| err.to_string())?
            != 0;
        if exists {
            return Ok(Some(identity_id.to_string()));
        }
    }

    conn.query_row(
        "SELECT identity_id
         FROM session_participants
         WHERE session_id = ?1 AND role = 'self'
         ORDER BY added_at_ms DESC
         LIMIT 1",
        params![session_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

pub(super) fn mark_session_read_in_db(
    conn: &Connection,
    request: MarkCanonicalSessionReadRequest,
) -> Result<Option<CanonicalReadCursorDelta>, String> {
    let session_id = request.session_id.trim();
    if session_id.is_empty() {
        return Err("Session id is required".to_string());
    }
    if select_session(conn, session_id)?.is_none() {
        return Err("Session not found".to_string());
    }

    let profile = ensure_local_profile(conn)?;
    let preferred_identity_id = request
        .identity_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(profile.human_identity_id.as_deref());
    let Some(identity_id) = self_participant_identity_id(conn, session_id, preferred_identity_id)?
    else {
        return Ok(None);
    };

    let message_id = request
        .message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or(latest_readable_session_message_id(conn, session_id)?);
    let now = now_ms();
    let updated_cursor = conn
        .query_row(
            "WITH target_message AS (
                SELECT id, sequence_num
                FROM session_messages
                WHERE id = ?2
                  AND session_id = ?3
                  AND COALESCE(source_transport, '') NOT IN (
                      'canonical-fork-snapshot',
                      'cloud-group-fork-snapshot'
                  )
                  AND LOWER(TRIM(status)) NOT IN ('sending', 'processing')
             )
             UPDATE session_participants AS participant
             SET last_seen_at_ms = MAX(COALESCE(participant.last_seen_at_ms, 0), ?1),
                 last_read_message_id = CASE
                     WHEN ?2 IS NULL THEN participant.last_read_message_id
                     WHEN COALESCE(
                         (
                             SELECT target.sequence_num >= current.sequence_num
                             FROM target_message AS target
                             LEFT JOIN session_messages AS current
                               ON current.id = participant.last_read_message_id
                              AND current.session_id = participant.session_id
                         ),
                         1
                     ) THEN ?2
                     ELSE participant.last_read_message_id
                 END
             WHERE participant.session_id = ?3
               AND participant.identity_id = ?4
               AND participant.role = 'self'
               AND (?2 IS NULL OR EXISTS(SELECT 1 FROM target_message))
             RETURNING last_seen_at_ms, last_read_message_id,
                 (
                     SELECT current.sequence_num
                     FROM session_messages AS current
                     WHERE current.id = last_read_message_id
                       AND current.session_id = ?3
                 )",
            params![now, message_id, session_id, identity_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((last_seen_at_ms, last_read_message_id, last_read_sequence_num)) = updated_cursor
    else {
        if message_id.is_some() {
            return Err("Message is not readable in this session".to_string());
        }
        return Ok(None);
    };
    Ok(Some(CanonicalReadCursorDelta {
        session_id: session_id.to_string(),
        identity_id,
        last_seen_at_ms,
        last_read_message_id,
        last_read_sequence_num,
    }))
}

/// Trust boundary: this helper does not authorize the (session_id, message_id)
/// tuple against any caller identity. It trusts whatever id and content the
/// renderer supplies via the canonical-sessions Tauri surface. The renderer is
/// assumed to be the sole writer; do not call this from code paths that take
/// untrusted input. If an `id` is provided and already exists, the row is
/// upserted in place — meaning a bad id could overwrite an unrelated message.
pub(super) fn append_message_in_db(
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

    let source_transport = clean_optional(request.source_transport);
    let source_event_id = clean_optional(request.source_event_id);
    let inserted = conn.execute(
        "INSERT INTO session_messages(
             id, session_id, sender_identity_id, sender_role, message_kind, content_text, content_json,
             parent_message_id, delegated_exchange_id, status, sequence_num, created_at_ms, updated_at_ms,
             content_hash, source_transport, source_event_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(source_transport, source_event_id)
         WHERE source_transport IS NOT NULL AND source_event_id IS NOT NULL
         DO NOTHING",
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
            source_transport,
            source_event_id,
        ],
    )
    .map_err(|err| err.to_string())?;
    if inserted == 0 {
        if let (Some(source_transport), Some(source_event_id)) =
            (source_transport.as_deref(), source_event_id.as_deref())
        {
            if let Some(existing) =
                select_message_by_source(conn, source_transport, source_event_id)?
            {
                return Ok(existing);
            }
        }
        return Err(
            "Unable to save canonical message after resolving a duplicate source event".to_string(),
        );
    }
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

fn select_cloud_self_agent_existing_echo(
    conn: &Connection,
    request: &AppendCanonicalMessageRequest,
) -> Result<Option<CanonicalSessionMessage>, String> {
    if request.source_transport.as_deref() != Some("cloud-self-agent") {
        return Ok(None);
    }
    let created_at_ms = request.created_at_ms.unwrap_or_else(now_ms);
    let message_id: Option<String> = conn
        .query_row(
            "SELECT id
             FROM session_messages
             WHERE session_id = ?1
               AND sender_role = ?2
               AND message_kind = ?3
               AND content_text = ?4
               AND source_transport IN ('desktop-chat', 'canonical-fork-snapshot')
               AND ABS(created_at_ms - ?5) <= 5_000
             ORDER BY ABS(created_at_ms - ?5) ASC, sequence_num DESC
             LIMIT 1",
            params![
                request.session_id,
                request.sender_role,
                request.message_kind,
                request.content_text,
                created_at_ms,
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    message_id
        .as_deref()
        .map(|id| select_message(conn, id))
        .transpose()
        .map(|message| message.flatten())
}

fn upsert_message_in_db(
    conn: &Connection,
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    // Cloud replay and the local agent runner can reconcile the same stable
    // processing slot at the same time. Acquire the write lock before the
    // source/id lookups so two connections cannot both observe a missing row
    // and then race to insert the same primary key.
    let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let message = upsert_message_in_transaction(&tx, request)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(message)
}

fn upsert_message_in_transaction(
    conn: &Connection,
    mut request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    if let (Some(source_transport), Some(source_event_id)) = (
        request.source_transport.as_deref(),
        request.source_event_id.as_deref(),
    ) {
        if let Some(existing) = select_message_by_source(conn, source_transport, source_event_id)? {
            if request.id.as_deref().map(str::trim) != Some(existing.id.as_str()) {
                request.id = Some(existing.id);
            }
        }
    }
    let Some(id) = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
    else {
        return append_message_in_db(conn, request);
    };

    if select_message(conn, &id)?.is_none() {
        if let Some(existing_echo) = select_cloud_self_agent_existing_echo(conn, &request)? {
            return Ok(existing_echo);
        }
        return append_message_in_db(conn, request);
    }

    let now = now_ms();
    let created_at_ms = request.created_at_ms.unwrap_or(now);
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
        "UPDATE session_messages
         SET sender_identity_id = ?1,
             sender_role = ?2,
             message_kind = ?3,
             content_text = ?4,
             content_json = ?5,
             status = ?6,
             created_at_ms = ?7,
             updated_at_ms = ?8,
             content_hash = ?9,
             parent_message_id = ?10,
             delegated_exchange_id = ?11,
             source_transport = ?12,
             source_event_id = ?13
         WHERE id = ?14",
        params![
            request.sender_identity_id.as_str(),
            request.sender_role.as_str(),
            request.message_kind.as_str(),
            request.content_text.as_str(),
            content,
            status,
            created_at_ms,
            now,
            content_hash,
            clean_optional(request.parent_message_id),
            clean_optional(request.delegated_exchange_id),
            clean_optional(request.source_transport),
            clean_optional(request.source_event_id),
            id,
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

    select_message(conn, &id)?.ok_or_else(|| "Unable to update canonical message".to_string())
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

pub(super) fn adopt_cloud_profile_identity_in_db(
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

pub(super) fn local_profile_human_identity_id(
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

pub(super) fn local_agent_identity_id(
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

pub(crate) fn canonical_session_is_group_chat(session_id: &str) -> Result<bool, String> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let conn = open_db()?;
    Ok(select_session(&conn, trimmed)?.is_some_and(|session| session.kind == "group"))
}

async fn run_canonical_blocking<T>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn desktop_canonical_session_state() -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(commands::desktop_canonical_session_state).await
}

#[tauri::command]
pub async fn desktop_canonical_session_catalog() -> Result<CanonicalSessionCatalog, String> {
    run_canonical_blocking(commands::desktop_canonical_session_catalog).await
}

#[tauri::command]
pub async fn desktop_canonical_session_messages(
    session_id: String,
    before_sequence_num: Option<i64>,
    limit: Option<i64>,
) -> Result<CanonicalMessagePage, String> {
    run_canonical_blocking(move || {
        commands::desktop_canonical_session_messages(&session_id, before_sequence_num, limit)
    })
    .await
}

#[tauri::command]
pub async fn desktop_canonical_upsert_identity(
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || commands::desktop_canonical_upsert_identity(request)).await
}

#[tauri::command]
pub async fn desktop_canonical_adopt_cloud_profile_identity(
    request: AdoptCloudProfileIdentityRequest,
) -> Result<CanonicalProfileIdentityDelta, String> {
    run_canonical_blocking(move || {
        commands::desktop_canonical_adopt_cloud_profile_identity(request)
    })
    .await
}

#[tauri::command]
pub async fn desktop_canonical_upsert_identity_fast(
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalIdentity, String> {
    run_canonical_blocking(move || commands::desktop_canonical_upsert_identity_fast(request)).await
}

#[tauri::command]
pub async fn desktop_canonical_open_or_create_session_fast(
    request: OpenCanonicalSessionRequest,
) -> Result<OpenCanonicalSessionFastResult, String> {
    run_canonical_blocking(move || commands::desktop_canonical_open_or_create_session_fast(request))
        .await
}

#[tauri::command]
pub async fn desktop_canonical_open_or_create_session(
    request: OpenCanonicalSessionRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || commands::desktop_canonical_open_or_create_session(request))
        .await
}

#[tauri::command]
pub async fn desktop_canonical_append_message(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || commands::desktop_canonical_append_message(request)).await
}

/// Trust boundary: this command writes (or overwrites, when the supplied id
/// already exists) a canonical session message based purely on what the
/// renderer sends via IPC. The whole canonical-sessions Tauri surface
/// currently assumes the renderer is the sole writer — there is no
/// per-command authorization. A renderer bug or a code path that picks up an
/// untrusted message id could therefore replace an unrelated message. Do not
/// expose this command to callers outside the renderer process.
#[tauri::command]
pub async fn desktop_canonical_upsert_message(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || commands::desktop_canonical_upsert_message(request)).await
}

#[tauri::command]
pub async fn desktop_canonical_upsert_message_fast(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    run_canonical_blocking(move || commands::desktop_canonical_upsert_message_fast(request)).await
}

#[tauri::command]
pub async fn desktop_canonical_update_message_delivery(
    request: UpdateCanonicalMessageDeliveryRequest,
) -> Result<Option<CanonicalMessageDeliveryDelta>, String> {
    run_canonical_blocking(move || commands::desktop_canonical_update_message_delivery(request))
        .await
}

#[tauri::command]
pub async fn desktop_canonical_append_message_fast(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    run_canonical_blocking(move || commands::desktop_canonical_append_message_fast(request)).await
}

#[tauri::command]
pub async fn desktop_canonical_create_delegated_exchange(
    request: CreateCanonicalDelegatedExchangeRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || commands::desktop_canonical_create_delegated_exchange(request))
        .await
}

#[tauri::command]
pub async fn desktop_canonical_update_presence(
    request: UpdateCanonicalPresenceRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || commands::desktop_canonical_update_presence(request)).await
}

#[tauri::command]
pub async fn desktop_canonical_rename_session(
    request: RenameCanonicalSessionRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || commands::desktop_canonical_rename_session(request)).await
}

#[tauri::command]
pub async fn desktop_canonical_update_session_metadata(
    request: UpdateCanonicalSessionMetadataRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || commands::desktop_canonical_update_session_metadata(request))
        .await
}

#[tauri::command]
pub async fn desktop_canonical_add_session_participants(
    request: AddCanonicalSessionParticipantsRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || commands::desktop_canonical_add_session_participants(request))
        .await
}

#[tauri::command]
pub async fn desktop_canonical_add_group_members_fast(
    request: AddCanonicalGroupMembersRequest,
) -> Result<CanonicalGroupMembershipDelta, String> {
    run_canonical_blocking(move || commands::desktop_canonical_add_group_members_fast(request))
        .await
}

#[tauri::command]
pub async fn desktop_canonical_remove_session_participant(
    request: RemoveCanonicalSessionParticipantRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || commands::desktop_canonical_remove_session_participant(request))
        .await
}

#[tauri::command]
pub async fn desktop_canonical_set_session_participant_role(
    request: SetCanonicalSessionParticipantRoleRequest,
) -> Result<CanonicalSessionState, String> {
    run_canonical_blocking(move || {
        commands::desktop_canonical_set_session_participant_role(request)
    })
    .await
}

#[tauri::command]
pub async fn desktop_canonical_mark_session_read(
    request: MarkCanonicalSessionReadRequest,
) -> Result<Option<CanonicalReadCursorDelta>, String> {
    run_canonical_blocking(move || commands::desktop_canonical_mark_session_read(request)).await
}
