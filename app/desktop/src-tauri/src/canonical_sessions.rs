//! Canonical session persistence composition and stable desktop command boundary.

#[cfg(test)]
use rusqlite::TransactionBehavior;
use rusqlite::{params, Connection, OptionalExtension};
#[cfg(test)]
use uuid::Uuid;

mod canonical_fork;
pub(crate) mod chat_sync;
mod chat_sync_schema;
mod commands;
mod core;
mod desktop_runtime_status;
mod desktop_sync;
mod group_participants;
mod identity_context;
mod identity_helpers;
mod identity_migration;
mod message_lookup;
mod message_mirror_command;
mod message_reconcile;
mod message_visibility;
mod models;
mod persistence;
mod presence;
pub(crate) mod prompt_context;
mod sanitization;
mod schema;
mod session_observation;
#[cfg(test)]
mod tests;
mod title_policy;

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
    canonical_avatar_key, canonical_identity_id, default_session_title, stable_session_id,
    validate_identity_kind, validate_session_kind,
};
pub(crate) use self::identity_helpers::{
    clean_optional, identity_display_name, json_from_db, json_to_db, validate_status,
};
#[cfg(test)]
use self::identity_migration::update_local_profile_identities;
use self::identity_migration::{
    adopt_cloud_profile_identity_in_db, local_agent_identity_id, local_profile_human_identity_id,
};
pub(crate) use self::message_lookup::{
    canonical_message_exists, similar_agent_message_exists, similar_agent_message_text,
};
pub use self::message_mirror_command::desktop_canonical_reconcile_message_mirror;
pub(crate) use self::message_visibility::latest_readable_session_message_id;
pub(crate) use self::persistence::{
    append_message_in_db, create_delegated_exchange_in_db, select_delegated_exchange,
    select_message, select_message_by_source, upsert_message_in_db,
};
use self::persistence::{
    enforce_only_local_group_self, open_or_create_session_in_db, select_identity, select_session,
    upsert_identity_in_db, upsert_participant,
};
use self::presence::update_presence_in_db;
use self::schema::{ensure_local_profile, initialize_schema};
pub(crate) use self::session_observation::{
    read_session_for_observation, search_sessions_for_observation_scoped,
};
use self::title_policy::reconcile_session_title_metadata;

const CANONICAL_SESSIONS_DB_FILENAME: &str = "canonical-sessions.sqlite3";
const SCHEMA_VERSION: i64 = 2;

pub(crate) fn open_db() -> Result<Connection, String> {
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
pub async fn desktop_canonical_existing_message_sources(
    sources: Vec<CanonicalMessageSourceRef>,
) -> Result<Vec<CanonicalMessageSourceRef>, String> {
    run_canonical_blocking(move || commands::desktop_canonical_existing_message_sources(sources))
        .await
}

#[tauri::command]
pub async fn desktop_canonical_delete_cloud_message(
    cloud_message_id: String,
) -> Result<Vec<String>, String> {
    run_canonical_blocking(move || {
        commands::desktop_canonical_delete_cloud_message(&cloud_message_id)
    })
    .await
}

#[tauri::command]
pub async fn desktop_canonical_prune_missing_cloud_messages(
    account_id: String,
) -> Result<Vec<String>, String> {
    run_canonical_blocking(move || {
        commands::desktop_canonical_prune_missing_cloud_messages(&account_id)
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
pub async fn desktop_canonical_list_legacy_cloud_group_title_notice_ids(
) -> Result<Vec<String>, String> {
    run_canonical_blocking(commands::desktop_canonical_list_legacy_cloud_group_title_notice_ids)
        .await
}

#[tauri::command]
pub async fn desktop_canonical_classify_legacy_cloud_group_title_notices(
    requests: Vec<ClassifyLegacyCloudGroupTitleNoticeRequest>,
) -> Result<ClassifyLegacyCloudGroupTitleNoticesResponse, String> {
    run_canonical_blocking(move || {
        commands::desktop_canonical_classify_legacy_cloud_group_title_notices(requests)
    })
    .await
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
