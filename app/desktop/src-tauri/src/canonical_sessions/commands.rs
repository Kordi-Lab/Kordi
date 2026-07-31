use super::{
    adopt_cloud_profile_identity_in_db, mark_session_read_in_db, open_db,
    open_or_create_session_in_db, update_presence_in_db, upsert_identity_in_db,
    AdoptCloudProfileIdentityRequest, CanonicalIdentity, CanonicalProfileIdentityDelta,
    CanonicalReadCursorDelta, CanonicalSessionState, MarkCanonicalSessionReadRequest,
    OpenCanonicalSessionFastResult, OpenCanonicalSessionRequest, UpdateCanonicalPresenceRequest,
    UpsertCanonicalIdentityRequest,
};

mod catalog;
mod delivery;
mod groups;

pub(super) use self::catalog::{
    desktop_canonical_session_catalog, desktop_canonical_session_messages,
    desktop_canonical_session_state, load_state_from_db,
};
#[cfg(test)]
use self::catalog::{load_catalog_from_db, load_message_page_from_db};
#[cfg(test)]
use self::delivery::update_canonical_message_delivery_in_db;
pub(super) use self::delivery::{
    desktop_canonical_append_message, desktop_canonical_append_message_fast,
    desktop_canonical_create_delegated_exchange, desktop_canonical_update_message_delivery,
    desktop_canonical_upsert_message, desktop_canonical_upsert_message_fast,
};
#[cfg(test)]
use self::groups::add_canonical_group_members_in_db;
use self::groups::select_session_participants;
pub(super) use self::groups::{
    desktop_canonical_add_group_members_fast, desktop_canonical_add_session_participants,
    desktop_canonical_remove_session_participant, desktop_canonical_rename_session,
    desktop_canonical_set_session_participant_role, desktop_canonical_update_session_metadata,
};

pub(super) fn desktop_canonical_upsert_identity(
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    upsert_identity_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_adopt_cloud_profile_identity(
    request: AdoptCloudProfileIdentityRequest,
) -> Result<CanonicalProfileIdentityDelta, String> {
    let mut conn = open_db()?;
    adopt_cloud_profile_identity_in_db(&mut conn, request)
}

pub(super) fn desktop_canonical_upsert_identity_fast(
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalIdentity, String> {
    let conn = open_db()?;
    upsert_identity_in_db(&conn, request)
}

pub(super) fn desktop_canonical_open_or_create_session_fast(
    request: OpenCanonicalSessionRequest,
) -> Result<OpenCanonicalSessionFastResult, String> {
    let conn = open_db()?;
    let session = open_or_create_session_in_db(&conn, request)?;
    let participants = select_session_participants(&conn, &session.id)?;
    Ok(OpenCanonicalSessionFastResult {
        session,
        participants,
    })
}

pub(super) fn desktop_canonical_open_or_create_session(
    request: OpenCanonicalSessionRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    open_or_create_session_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_update_presence(
    request: UpdateCanonicalPresenceRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    update_presence_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_mark_session_read(
    request: MarkCanonicalSessionReadRequest,
) -> Result<Option<CanonicalReadCursorDelta>, String> {
    let conn = open_db()?;
    mark_session_read_in_db(&conn, request)
}

pub(crate) fn session_exists(session_id: &str) -> Result<bool, String> {
    let conn = open_db()?;
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            rusqlite::params![session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    Ok(exists != 0)
}

pub(crate) fn archive_session(session_id: &str) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "UPDATE sessions SET status = 'archived', updated_at_ms = ?2 WHERE id = ?1",
        rusqlite::params![session_id, super::now_ms()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn delete_session(session_id: &str) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "DELETE FROM kv_cache_entries WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM context_snapshots WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM presence WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM delegated_exchanges WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM session_messages WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM session_participants WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM sessions WHERE id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg(test)]
mod catalog_tests;
