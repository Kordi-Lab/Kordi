//! Message, delivery-state, and delegated-exchange command orchestration.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{Map, Value};

use super::super::{
    append_message_in_db, create_delegated_exchange_in_db, hash_hex, json_to_db,
    latest_readable_session_message_id, now_ms, open_db, select_message, upsert_message_in_db,
    AppendCanonicalMessageRequest, CanonicalMessageDeliveryDelta, CanonicalSessionMessage,
    CanonicalSessionState, ClassifyLegacyCloudGroupTitleNoticeRequest,
    ClassifyLegacyCloudGroupTitleNoticesResponse, CreateCanonicalDelegatedExchangeRequest,
    LegacyCloudGroupTitleNoticeSessionRepair, UpdateCanonicalMessageDeliveryRequest,
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

pub(super) fn list_legacy_cloud_group_title_notice_ids_in_db(
    conn: &Connection,
) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT SUBSTR(id, LENGTH('cloud-group-title-notice:') + 1)
             FROM session_messages
             WHERE message_kind = 'status'
               AND source_transport = 'cloud-group-title-update'
               AND id LIKE 'cloud-group-title-notice:%'
               AND source_event_id = 'cloud-group-title-update:' || SUBSTR(id, LENGTH('cloud-group-title-notice:') + 1)
               AND json_valid(content_json)
               AND json_extract(content_json, '$.kind') = 'group-title-update'
               AND json_extract(content_json, '$.scope') = 'group'
               AND NULLIF(TRIM(COALESCE(json_extract(content_json, '$.sourceControlKind'), '')), '') IS NULL
             ORDER BY sequence_num ASC, created_at_ms ASC, id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(super) fn classify_legacy_cloud_group_title_notices_in_db(
    conn: &mut Connection,
    requests: Vec<ClassifyLegacyCloudGroupTitleNoticeRequest>,
) -> Result<ClassifyLegacyCloudGroupTitleNoticesResponse, String> {
    if requests.len() > 500 {
        return Err(
            "At most 500 legacy Cloud group title notices can be classified at once".into(),
        );
    }
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let mut seen_notice_ids = HashSet::new();
    let mut classified = Vec::new();
    let mut repaired_sessions = HashMap::<String, i64>::new();

    for request in requests {
        let cloud_message_id = request.cloud_message_id.trim();
        let source_control_kind = request.source_control_kind.trim();
        if cloud_message_id.is_empty() {
            continue;
        }
        if !matches!(
            source_control_kind,
            "group-invite" | "group-update" | "group-title-update"
        ) {
            return Err(format!(
                "Unsupported Cloud group title synchronization kind: {source_control_kind}"
            ));
        }
        let notice_id = format!("cloud-group-title-notice:{cloud_message_id}");
        if !seen_notice_ids.insert(notice_id.clone()) {
            continue;
        }
        let Some(message) = select_message(&transaction, &notice_id)? else {
            continue;
        };
        let expected_source_event_id = format!("cloud-group-title-update:{cloud_message_id}");
        if message.message_kind != "status"
            || message.source_transport.as_deref() != Some("cloud-group-title-update")
            || message.source_event_id.as_deref() != Some(expected_source_event_id.as_str())
        {
            continue;
        }
        let Some(Value::Object(mut content)) = message.content.clone() else {
            continue;
        };
        if content.get("kind").and_then(Value::as_str) != Some("group-title-update")
            || content.get("scope").and_then(Value::as_str) != Some("group")
        {
            continue;
        }

        let synchronization_only = matches!(source_control_kind, "group-invite" | "group-update");
        content.insert(
            "sourceControlKind".to_string(),
            Value::String(source_control_kind.to_string()),
        );
        if synchronization_only {
            content.insert("synchronizationOnly".to_string(), Value::Bool(true));
        } else {
            content.remove("synchronizationOnly");
        }
        let content_value = Some(Value::Object(content));
        let content_json = json_to_db(&content_value)?;
        let content_hash = hash_hex(
            &format!(
                "{}|{}",
                message.content_text,
                content_json.clone().unwrap_or_default()
            ),
            16,
        );
        transaction
            .execute(
                "UPDATE session_messages SET content_json = ?1, content_hash = ?2 WHERE id = ?3",
                params![content_json, content_hash, notice_id],
            )
            .map_err(|error| error.to_string())?;

        if synchronization_only {
            let replacement_message_id =
                latest_readable_session_message_id(&transaction, &message.session_id)?;
            transaction
                .execute(
                    "UPDATE session_participants SET last_read_message_id = ?1
                     WHERE session_id = ?2 AND last_read_message_id = ?3",
                    params![replacement_message_id, message.session_id, notice_id],
                )
                .map_err(|error| error.to_string())?;
            let replacement_created_at_ms = replacement_message_id
                .as_deref()
                .map(|message_id| {
                    transaction.query_row(
                        "SELECT created_at_ms FROM session_messages WHERE id = ?1",
                        params![message_id],
                        |row| row.get::<_, i64>(0),
                    )
                })
                .transpose()
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE sessions SET last_message_at_ms = ?1 WHERE id = ?2",
                    params![replacement_created_at_ms, message.session_id],
                )
                .map_err(|error| error.to_string())?;
            repaired_sessions
                .entry(message.session_id.clone())
                .and_modify(|latest| *latest = (*latest).max(message.created_at_ms))
                .or_insert(message.created_at_ms);
        }
        if let Some(updated) = select_message(&transaction, &notice_id)? {
            classified.push(updated);
        }
    }

    let mut repaired_sessions = repaired_sessions.into_iter().collect::<Vec<_>>();
    repaired_sessions.sort_by(|left, right| left.0.cmp(&right.0));
    let session_repairs = repaired_sessions
        .into_iter()
        .map(|(session_id, replaced_through_at_ms)| {
            transaction
                .query_row(
                    "SELECT last_message_at_ms FROM sessions WHERE id = ?1",
                    params![session_id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()
                .map_err(|error| error.to_string())
                .map(|last_message_at_ms| {
                    last_message_at_ms.map(|last_message_at_ms| {
                        LegacyCloudGroupTitleNoticeSessionRepair {
                            session_id,
                            last_message_at_ms,
                            replaced_through_at_ms,
                        }
                    })
                })
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect();

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ClassifyLegacyCloudGroupTitleNoticesResponse {
        messages: classified,
        session_repairs,
    })
}

pub(in crate::canonical_sessions) fn desktop_canonical_list_legacy_cloud_group_title_notice_ids(
) -> Result<Vec<String>, String> {
    let conn = open_db()?;
    list_legacy_cloud_group_title_notice_ids_in_db(&conn)
}

pub(in crate::canonical_sessions) fn desktop_canonical_classify_legacy_cloud_group_title_notices(
    requests: Vec<ClassifyLegacyCloudGroupTitleNoticeRequest>,
) -> Result<ClassifyLegacyCloudGroupTitleNoticesResponse, String> {
    let mut conn = open_db()?;
    classify_legacy_cloud_group_title_notices_in_db(&mut conn, requests)
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
