//! Message, delivery-state, and delegated-exchange command orchestration.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{Map, Value};

use super::super::{
    append_message_in_db, create_delegated_exchange_in_db, hash_hex, now_ms, open_db,
    upsert_message_in_db, AppendCanonicalMessageRequest, CanonicalMessageDeliveryDelta,
    CanonicalSessionMessage, CanonicalSessionState, CreateCanonicalDelegatedExchangeRequest,
    UpdateCanonicalMessageDeliveryRequest,
};
use super::catalog::load_state_from_db;

pub(in crate::canonical_sessions) fn desktop_canonical_append_message(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    append_message_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(in crate::canonical_sessions) fn desktop_canonical_upsert_message(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    upsert_message_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(in crate::canonical_sessions) fn desktop_canonical_upsert_message_fast(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    let conn = open_db()?;
    upsert_message_in_db(&conn, request)
}

pub(in crate::canonical_sessions) fn desktop_canonical_append_message_fast(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    let conn = open_db()?;
    append_message_in_db(&conn, request)
}

fn validate_outbox_delivery_value(
    value: String,
    allowed: &[&str],
    label: &str,
) -> Result<String, String> {
    let value = value.trim();
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("Invalid canonical message {label}: {value}"))
    }
}

fn validate_recipient_ids(ids: Vec<String>, label: &str) -> Result<Vec<String>, String> {
    ids.into_iter()
        .map(|id| {
            let id = id.trim();
            if id.is_empty() {
                Err(format!(
                    "Canonical message {label} must not contain blank ids"
                ))
            } else {
                Ok(id.to_string())
            }
        })
        .collect()
}

pub(super) fn update_canonical_message_delivery_in_db(
    conn: &mut Connection,
    request: UpdateCanonicalMessageDeliveryRequest,
) -> Result<Option<CanonicalMessageDeliveryDelta>, String> {
    let message_id = request.message_id.trim();
    if message_id.is_empty() {
        return Err("Message id is required".to_string());
    }
    let session_id = request.session_id.trim();
    if session_id.is_empty() {
        return Err("Session id is required".to_string());
    }
    let status = validate_outbox_delivery_value(
        request.status,
        &["sending", "delivered", "failed"],
        "status",
    )?;
    let delivery_state = validate_outbox_delivery_value(
        request.delivery_state,
        &["sending", "partial", "delivered", "failed"],
        "delivery state",
    )?;
    let delivered_recipient_ids =
        validate_recipient_ids(request.delivered_recipient_ids, "delivered recipient ids")?;
    let pending_recipient_ids =
        validate_recipient_ids(request.pending_recipient_ids, "pending recipient ids")?;
    let exhausted_recipient_ids =
        validate_recipient_ids(request.exhausted_recipient_ids, "exhausted recipient ids")?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let row = tx
        .query_row(
            "SELECT session_id, content_text, content_json, created_at_ms
             FROM session_messages WHERE id = ?1",
            params![message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((stored_session_id, content_text, content_json, created_at_ms)) = row else {
        tx.commit().map_err(|err| err.to_string())?;
        return Ok(None);
    };
    if stored_session_id != session_id {
        return Err(format!(
            "Canonical message {message_id} belongs to session {stored_session_id}, not {session_id}"
        ));
    }

    let mut content = match content_json {
        Some(content_json) => {
            match serde_json::from_str::<Value>(&content_json).map_err(|err| err.to_string())? {
                Value::Object(content) => content,
                _ => Map::new(),
            }
        }
        None => Map::new(),
    };
    content.insert(
        "deliveryState".to_string(),
        Value::String(delivery_state.clone()),
    );
    content.insert(
        "deliveredRecipientIds".to_string(),
        serde_json::to_value(&delivered_recipient_ids).map_err(|err| err.to_string())?,
    );
    content.insert(
        "pendingRecipientIds".to_string(),
        serde_json::to_value(&pending_recipient_ids).map_err(|err| err.to_string())?,
    );
    content.insert(
        "exhaustedRecipientIds".to_string(),
        serde_json::to_value(&exhausted_recipient_ids).map_err(|err| err.to_string())?,
    );
    let content_json =
        serde_json::to_string(&Value::Object(content)).map_err(|err| err.to_string())?;
    let content_hash = hash_hex(&format!("{content_text}|{content_json}"), 16);
    let updated_at_ms = now_ms();

    tx.execute(
        "UPDATE session_messages
         SET status = ?1, content_json = ?2, updated_at_ms = ?3, content_hash = ?4
         WHERE id = ?5 AND session_id = ?6",
        params![
            status,
            content_json,
            updated_at_ms,
            content_hash,
            message_id,
            session_id,
        ],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "UPDATE sessions
         SET updated_at_ms = ?1,
             last_message_at_ms = MAX(COALESCE(last_message_at_ms, 0), ?2)
         WHERE id = ?3",
        params![updated_at_ms, created_at_ms, session_id],
    )
    .map_err(|err| err.to_string())?;
    let (content_hash, session_updated_at_ms, session_last_message_at_ms) = tx
        .query_row(
            "SELECT sm.content_hash, s.updated_at_ms, s.last_message_at_ms
             FROM session_messages sm
             JOIN sessions s ON s.id = sm.session_id
             WHERE sm.id = ?1 AND sm.session_id = ?2",
            params![message_id, session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    Ok(Some(CanonicalMessageDeliveryDelta {
        message_id: message_id.to_string(),
        session_id: session_id.to_string(),
        status,
        delivery_state,
        delivered_recipient_ids,
        pending_recipient_ids,
        exhausted_recipient_ids,
        updated_at_ms,
        content_hash,
        session_updated_at_ms,
        session_last_message_at_ms,
    }))
}

pub(in crate::canonical_sessions) fn desktop_canonical_update_message_delivery(
    request: UpdateCanonicalMessageDeliveryRequest,
) -> Result<Option<CanonicalMessageDeliveryDelta>, String> {
    let mut conn = open_db()?;
    update_canonical_message_delivery_in_db(&mut conn, request)
}

pub(in crate::canonical_sessions) fn desktop_canonical_create_delegated_exchange(
    request: CreateCanonicalDelegatedExchangeRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    create_delegated_exchange_in_db(&conn, request)?;
    load_state_from_db(&conn)
}
