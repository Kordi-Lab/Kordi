//! Shared SQLite row projection for canonical read models.

use rusqlite::Connection;

use super::super::super::{
    json_from_db, CanonicalDelegatedExchange, CanonicalIdentity, CanonicalSession,
    CanonicalSessionMessage,
};

pub(super) fn query_all<T>(
    conn: &Connection,
    sql: &str,
    map: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let mut stmt = conn.prepare(sql).map_err(|err| err.to_string())?;
    let rows = stmt.query_map([], map).map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub(super) fn canonical_message_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CanonicalSessionMessage> {
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
}

pub(super) fn canonical_identity_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CanonicalIdentity> {
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
}

pub(super) fn canonical_session_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CanonicalSession> {
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
}

pub(super) fn canonical_delegated_exchange_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CanonicalDelegatedExchange> {
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
}
