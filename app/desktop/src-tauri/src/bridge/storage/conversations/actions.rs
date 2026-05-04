use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use uuid::Uuid;

use super::super::config::now_ms;
use super::lookup::{
    apply_conversation_metadata, find_conversation_for_peer, find_recent_conversation_for_peer,
    scoped_conversation_id,
};
use super::merge::delivery_state_rank;
use super::outreach_metadata::{
    reconcile_conversation_outreach_delivery_state, reconcile_message_outreach_for_storage,
    reconcile_message_outreach_metadata,
};
use super::records::{
    load_conversation_record, load_conversation_store_from_db, optional_json, parse_optional_json,
    store_conversation_record, upsert_conversation_record,
};
use super::schema::{migrate_legacy_conversation_json, open_conversation_db, sqlite_error};
use crate::bridge::constants::{
    is_inbound_message_direction, BRIDGE_MESSAGE_DIRECTION_INBOUND,
    BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE, BRIDGE_MESSAGE_ID_PREFIX,
};
use crate::bridge::{
    DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord,
    DesktopBridgeConversationStore, DesktopBridgeIdentitySnapshot, DesktopBridgeMessageAttachment,
    DesktopBridgeOutreachMetadata,
};

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::bridge) struct BridgeInboxEventInsert {
    pub id: String,
    pub server_message_id: Option<String>,
    pub host_id: String,
    pub from_node_id: String,
    pub request_id: Option<String>,
    pub message_type: String,
    pub chat_queue_key: String,
    pub requesting_user_key: String,
    pub payload_json: String,
    pub status: String,
    pub received_at_ms: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::bridge) struct BridgeInboxEventRecord {
    pub id: String,
    pub server_message_id: Option<String>,
    pub host_id: String,
    pub from_node_id: String,
    pub request_id: Option<String>,
    pub message_type: String,
    pub chat_queue_key: String,
    pub requesting_user_key: String,
    pub payload_json: String,
    pub status: String,
    pub received_at_ms: i64,
    pub acked_at_ms: Option<i64>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::bridge) struct BridgeAgentJobInsert {
    pub id: String,
    pub inbox_event_id: String,
    pub request_id: Option<String>,
    pub requesting_user_key: String,
    pub chat_queue_key: String,
    pub status: String,
    pub created_at_ms: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::bridge) struct BridgeAgentJobRecord {
    pub id: String,
    pub inbox_event_id: String,
    pub request_id: Option<String>,
    pub requesting_user_key: String,
    pub chat_queue_key: String,
    pub status: String,
    pub retry_count: i64,
    pub next_retry_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub last_error: Option<String>,
}

#[allow(dead_code)]
pub(in crate::bridge) fn insert_bridge_inbox_event_if_absent(
    conn: &Connection,
    event: &BridgeInboxEventInsert,
) -> Result<String, String> {
    conn.execute(
        "INSERT OR IGNORE INTO bridge_inbox_events (
            id, server_message_id, host_id, from_node_id, request_id, message_type,
            chat_queue_key, requesting_user_key, payload_json, status, received_at_ms, acked_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)",
        params![
            event.id,
            event.server_message_id,
            event.host_id,
            event.from_node_id,
            event.request_id,
            event.message_type,
            event.chat_queue_key,
            event.requesting_user_key,
            event.payload_json,
            event.status,
            event.received_at_ms,
        ],
    )
    .map_err(sqlite_error)?;

    if let Some(server_message_id) = event.server_message_id.as_deref() {
        if let Some(existing_id) = conn
            .query_row(
                "SELECT id FROM bridge_inbox_events WHERE host_id = ?1 AND server_message_id = ?2",
                params![event.host_id, server_message_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sqlite_error)?
        {
            return Ok(existing_id);
        }
    }

    if let Some(request_id) = event.request_id.as_deref() {
        let existing_id = conn
            .query_row(
                "SELECT id FROM bridge_inbox_events
                 WHERE host_id = ?1 AND from_node_id = ?2 AND message_type = ?3 AND request_id = ?4",
                params![event.host_id, event.from_node_id, event.message_type, request_id],
                |row| row.get(0),
            )
            .map_err(sqlite_error)?;
        if let Some(server_message_id) = event.server_message_id.as_deref() {
            conn.execute(
                "UPDATE bridge_inbox_events
                 SET server_message_id = COALESCE(server_message_id, ?1)
                 WHERE id = ?2",
                params![server_message_id, existing_id],
            )
            .map_err(sqlite_error)?;
        }
        return Ok(existing_id);
    }

    conn.query_row(
        "SELECT id FROM bridge_inbox_events WHERE id = ?1",
        params![event.id],
        |row| row.get(0),
    )
    .map_err(sqlite_error)
}

#[allow(dead_code)]
fn read_bridge_inbox_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<BridgeInboxEventRecord> {
    Ok(BridgeInboxEventRecord {
        id: row.get(0)?,
        server_message_id: row.get(1)?,
        host_id: row.get(2)?,
        from_node_id: row.get(3)?,
        request_id: row.get(4)?,
        message_type: row.get(5)?,
        chat_queue_key: row.get(6)?,
        requesting_user_key: row.get(7)?,
        payload_json: row.get(8)?,
        status: row.get(9)?,
        received_at_ms: row.get(10)?,
        acked_at_ms: row.get(11)?,
    })
}

#[allow(dead_code)]
pub(in crate::bridge) fn load_bridge_inbox_event(
    conn: &Connection,
    inbox_event_id: &str,
) -> Result<Option<BridgeInboxEventRecord>, String> {
    conn.query_row(
        "SELECT id, server_message_id, host_id, from_node_id, request_id, message_type,
                chat_queue_key, requesting_user_key, payload_json, status, received_at_ms, acked_at_ms
         FROM bridge_inbox_events
         WHERE id = ?1",
        params![inbox_event_id],
        read_bridge_inbox_event,
    )
    .optional()
    .map_err(sqlite_error)
}

#[allow(dead_code)]
pub(in crate::bridge) fn load_bridge_inbox_event_from_storage(
    inbox_event_id: &str,
) -> Result<Option<BridgeInboxEventRecord>, String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    load_bridge_inbox_event(&conn, inbox_event_id)
}

#[allow(dead_code)]
pub(in crate::bridge) fn mark_bridge_inbox_event_acked(
    conn: &Connection,
    inbox_event_id: &str,
    acked_at_ms: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE bridge_inbox_events SET status = 'acked', acked_at_ms = ?1 WHERE id = ?2",
        params![acked_at_ms, inbox_event_id],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

#[allow(dead_code)]
pub(in crate::bridge) fn record_bridge_inbox_event_and_agent_job(
    event: &BridgeInboxEventInsert,
    job: &BridgeAgentJobInsert,
) -> Result<(String, String), String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let event_id = insert_bridge_inbox_event_if_absent(&conn, event)?;
    let mut job = job.clone();
    job.inbox_event_id = event_id.clone();
    let job_id = create_bridge_agent_job_if_absent(&conn, &job)?;
    Ok((event_id, job_id))
}

#[allow(dead_code)]
pub(in crate::bridge) fn create_bridge_agent_job_if_absent(
    conn: &Connection,
    job: &BridgeAgentJobInsert,
) -> Result<String, String> {
    conn.execute(
        "INSERT OR IGNORE INTO bridge_agent_jobs (
            id, inbox_event_id, request_id, requesting_user_key, chat_queue_key, status,
            retry_count, next_retry_at_ms, created_at_ms, started_at_ms, completed_at_ms, last_error
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, NULL, NULL, NULL)",
        params![
            job.id,
            job.inbox_event_id,
            job.request_id,
            job.requesting_user_key,
            job.chat_queue_key,
            job.status,
            job.created_at_ms,
        ],
    )
    .map_err(sqlite_error)?;

    conn.query_row(
        "SELECT id FROM bridge_agent_jobs WHERE inbox_event_id = ?1",
        params![job.inbox_event_id],
        |row| row.get(0),
    )
    .map_err(sqlite_error)
}

#[allow(dead_code)]
fn read_bridge_agent_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<BridgeAgentJobRecord> {
    Ok(BridgeAgentJobRecord {
        id: row.get(0)?,
        inbox_event_id: row.get(1)?,
        request_id: row.get(2)?,
        requesting_user_key: row.get(3)?,
        chat_queue_key: row.get(4)?,
        status: row.get(5)?,
        retry_count: row.get(6)?,
        next_retry_at_ms: row.get(7)?,
        created_at_ms: row.get(8)?,
        started_at_ms: row.get(9)?,
        completed_at_ms: row.get(10)?,
        last_error: row.get(11)?,
    })
}

#[allow(dead_code)]
pub(in crate::bridge) fn load_bridge_agent_job(
    conn: &Connection,
    job_id: &str,
) -> Result<Option<BridgeAgentJobRecord>, String> {
    conn.query_row(
        "SELECT id, inbox_event_id, request_id, requesting_user_key, chat_queue_key, status,
                retry_count, next_retry_at_ms, created_at_ms, started_at_ms, completed_at_ms, last_error
         FROM bridge_agent_jobs
         WHERE id = ?1",
        params![job_id],
        read_bridge_agent_job,
    )
    .optional()
    .map_err(sqlite_error)
}

#[allow(dead_code)]
pub(in crate::bridge) fn list_runnable_bridge_agent_jobs(
    conn: &Connection,
    now_ms: i64,
    limit: usize,
) -> Result<Vec<BridgeAgentJobRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, inbox_event_id, request_id, requesting_user_key, chat_queue_key, status,
                    retry_count, next_retry_at_ms, created_at_ms, started_at_ms, completed_at_ms, last_error
             FROM bridge_agent_jobs
             WHERE status = 'queued'
                OR (status = 'retry_wait' AND (next_retry_at_ms IS NULL OR next_retry_at_ms <= ?1))
             ORDER BY created_at_ms ASC, id ASC
             LIMIT ?2",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map(params![now_ms, limit as i64], read_bridge_agent_job)
        .map_err(sqlite_error)?;

    let mut jobs = Vec::new();
    for row in rows {
        jobs.push(row.map_err(sqlite_error)?);
    }
    Ok(jobs)
}

#[allow(dead_code)]
pub(in crate::bridge) fn list_runnable_bridge_agent_jobs_from_storage(
    now_ms: i64,
    limit: usize,
) -> Result<Vec<BridgeAgentJobRecord>, String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    list_runnable_bridge_agent_jobs(&conn, now_ms, limit)
}

#[allow(dead_code)]
pub(in crate::bridge) fn list_running_bridge_agent_jobs(
    conn: &Connection,
) -> Result<Vec<BridgeAgentJobRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, inbox_event_id, request_id, requesting_user_key, chat_queue_key, status,
                    retry_count, next_retry_at_ms, created_at_ms, started_at_ms, completed_at_ms, last_error
             FROM bridge_agent_jobs
             WHERE status = 'running'
             ORDER BY started_at_ms ASC, id ASC",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([], read_bridge_agent_job)
        .map_err(sqlite_error)?;

    let mut jobs = Vec::new();
    for row in rows {
        jobs.push(row.map_err(sqlite_error)?);
    }
    Ok(jobs)
}

#[allow(dead_code)]
pub(in crate::bridge) fn list_running_bridge_agent_jobs_from_storage(
) -> Result<Vec<BridgeAgentJobRecord>, String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    list_running_bridge_agent_jobs(&conn)
}

#[allow(dead_code)]
pub(in crate::bridge) fn mark_bridge_agent_job_running(
    conn: &Connection,
    job_id: &str,
    started_at_ms: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE bridge_agent_jobs
         SET status = 'running', started_at_ms = ?1, next_retry_at_ms = NULL, last_error = NULL
         WHERE id = ?2",
        params![started_at_ms, job_id],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

#[allow(dead_code)]
pub(in crate::bridge) fn mark_bridge_agent_job_running_in_storage(
    job_id: &str,
    started_at_ms: i64,
) -> Result<(), String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    mark_bridge_agent_job_running(&conn, job_id, started_at_ms)
}

#[allow(dead_code)]
pub(in crate::bridge) fn mark_bridge_agent_job_retry_wait(
    conn: &Connection,
    job_id: &str,
    next_retry_at_ms: i64,
    last_error: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE bridge_agent_jobs
         SET status = 'retry_wait', retry_count = retry_count + 1, next_retry_at_ms = ?1, last_error = ?2
         WHERE id = ?3",
        params![next_retry_at_ms, last_error, job_id],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

#[allow(dead_code)]
pub(in crate::bridge) fn mark_bridge_agent_job_retry_wait_in_storage(
    job_id: &str,
    next_retry_at_ms: i64,
    last_error: Option<&str>,
) -> Result<(), String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    mark_bridge_agent_job_retry_wait(&conn, job_id, next_retry_at_ms, last_error)
}

#[allow(dead_code)]
pub(in crate::bridge) fn mark_bridge_agent_job_terminal(
    conn: &Connection,
    job_id: &str,
    status: &str,
    completed_at_ms: i64,
    last_error: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE bridge_agent_jobs
         SET status = ?1, completed_at_ms = ?2, next_retry_at_ms = NULL, last_error = ?3
         WHERE id = ?4",
        params![status, completed_at_ms, last_error, job_id],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

#[allow(dead_code)]
pub(in crate::bridge) fn mark_bridge_agent_job_terminal_in_storage(
    job_id: &str,
    status: &str,
    completed_at_ms: i64,
    last_error: Option<&str>,
) -> Result<(), String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    mark_bridge_agent_job_terminal(&conn, job_id, status, completed_at_ms, last_error)
}

pub(in crate::bridge) fn append_conversation_message_to_storage(
    host_id: &str,
    peer_node_id: &str,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
    identity: Option<DesktopBridgeIdentitySnapshot>,
    outreach: Option<DesktopBridgeOutreachMetadata>,
    direction: &str,
    sender: Option<String>,
    text: String,
    request_id: Option<String>,
    delivery_state: Option<String>,
    attachments: Vec<DesktopBridgeMessageAttachment>,
    increment_unread: bool,
) -> Result<DesktopBridgeConversationStore, String> {
    let timestamp_ms = now_ms();
    let request_id_for_status = request_id.clone();
    let delivery_state_for_status = delivery_state.clone();
    let text_for_status = text.clone();
    let explicit_message_outreach = outreach.as_ref().map(|outreach| {
        let mut outreach = outreach.clone();
        if outreach.bridge_request_id.is_none() {
            outreach.bridge_request_id = request_id.clone();
        }
        outreach
    });
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;

    let mut conversation = find_conversation_for_peer(
        &tx,
        host_id,
        peer_node_id,
        project_id.as_deref(),
        &peer_runtime,
    )?
    .unwrap_or_else(|| DesktopBridgeConversationRecord {
        id: scoped_conversation_id(host_id, peer_node_id, project_id.as_deref(), &peer_runtime),
        host_id: host_id.to_string(),
        peer_node_id: peer_node_id.to_string(),
        peer_display_name: peer_display_name.clone(),
        peer_owner_name: peer_owner_name.clone(),
        peer_runtime: peer_runtime.clone(),
        project_id: project_id.clone(),
        project_name: project_name.clone(),
        unread_count: 0,
        updated_at_ms: timestamp_ms,
        peer_last_typing_at_ms: None,
        peer_last_heartbeat_at_ms: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    });

    apply_conversation_metadata(
        &mut conversation,
        peer_display_name,
        peer_owner_name,
        peer_runtime,
        project_id,
        project_name,
    );
    if let Some(identity) = identity {
        conversation.identity = Some(identity);
    }
    if let Some(mut outreach) = outreach {
        if outreach.bridge_conversation_id.is_none() {
            outreach.bridge_conversation_id = Some(conversation.id.clone());
        }
        if outreach.bridge_request_id.is_none() {
            outreach.bridge_request_id = request_id.clone();
        }
        conversation.outreach = Some(outreach);
    }
    let message_outreach = explicit_message_outreach.or_else(|| {
        let incoming_request_id = request_id.as_deref()?;
        let mut outreach = conversation.outreach.clone()?;
        if outreach.bridge_request_id.as_deref() != Some(incoming_request_id) {
            return None;
        }
        if outreach.bridge_conversation_id.is_none() {
            outreach.bridge_conversation_id = Some(conversation.id.clone());
        }
        Some(outreach)
    });
    conversation.updated_at_ms = timestamp_ms;
    if is_inbound_message_direction(direction) {
        conversation.peer_last_typing_at_ms = None;
    }

    let request_was_cancelled = request_id.as_deref().is_some_and(|incoming_request_id| {
        conversation.messages.iter().any(|message| {
            message.request_id.as_deref() == Some(incoming_request_id)
                && message.delivery_state.as_deref() == Some("cancelled")
        })
    });
    if request_was_cancelled
        && matches!(
            direction,
            BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE | BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
        )
        && delivery_state.as_deref() != Some("cancelled")
    {
        upsert_conversation_record(&tx, &conversation)?;
        tx.commit().map_err(sqlite_error)?;
        return load_conversation_store_from_db(&conn);
    }

    let existing_message = request_id.as_deref().and_then(|existing_request_id| {
        conversation.messages.iter().position(|message| {
            message.request_id.as_deref() == Some(existing_request_id)
                && message.direction == direction
        })
    });

    let conversation_id_for_message = conversation.id.clone();
    if let Some(index) = existing_message {
        let message = &mut conversation.messages[index];
        let should_apply_update = delivery_state
            .as_deref()
            .map(|next| {
                delivery_state_rank(Some(next))
                    >= delivery_state_rank(message.delivery_state.as_deref())
            })
            .unwrap_or(true);
        if should_apply_update {
            let previous_text = message.text.clone();
            message.sender = sender.or_else(|| message.sender.clone());
            message.text = text;
            message.timestamp_ms = timestamp_ms;
            if let Some(delivery_state) = delivery_state {
                message.delivery_state = Some(delivery_state);
            }
            if message.outreach.is_none() {
                message.outreach = message_outreach.clone();
            }
            if !attachments.is_empty() {
                message.attachments = attachments;
            }
            if let Some(outreach) = message.outreach.as_mut() {
                reconcile_message_outreach_for_storage(
                    outreach,
                    &conversation_id_for_message,
                    message.request_id.as_deref(),
                    message.delivery_state.as_deref(),
                    &message.text,
                    Some(&previous_text),
                    timestamp_ms,
                );
            }
        }
    } else {
        if increment_unread {
            conversation.unread_count += 1;
        }
        let mut outreach = message_outreach;
        if let Some(outreach) = outreach.as_mut() {
            reconcile_message_outreach_for_storage(
                outreach,
                &conversation_id_for_message,
                request_id.as_deref(),
                delivery_state.as_deref(),
                &text,
                None,
                timestamp_ms,
            );
        }
        conversation
            .messages
            .push(DesktopBridgeConversationMessageRecord {
                id: format!("{}{}", BRIDGE_MESSAGE_ID_PREFIX, Uuid::new_v4().simple()),
                direction: direction.to_string(),
                sender,
                text,
                timestamp_ms,
                request_id,
                delivery_state,
                outreach,
                attachments,
            });
    }

    if let Some(outreach) = conversation.outreach.as_mut() {
        let matches_request = outreach
            .bridge_request_id
            .as_deref()
            .is_some_and(|request_id| request_id_for_status.as_deref() == Some(request_id));
        if matches!(
            direction,
            BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE | BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
        ) && matches_request
        {
            if let Some(delivery_state) = delivery_state_for_status.as_deref() {
                reconcile_conversation_outreach_delivery_state(
                    outreach,
                    delivery_state,
                    Some(&text_for_status),
                    timestamp_ms,
                );
            }
        }

        let person_reply_completed = outreach.target_kind == "bridge-person"
            && matches!(
                direction,
                BRIDGE_MESSAGE_DIRECTION_INBOUND | BRIDGE_MESSAGE_DIRECTION_OUTBOUND
            )
            && !matches_request
            && timestamp_ms >= outreach.created_at_ms.saturating_sub(2_000)
            && !text_for_status.trim().is_empty();
        if person_reply_completed {
            outreach.status = "completed".to_string();
            outreach.updated_at_ms = timestamp_ms;
            outreach.completed_at_ms = Some(timestamp_ms);
            outreach.error = None;
        }
    }

    upsert_conversation_record(&tx, &conversation)?;
    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

fn should_apply_delivery_state_update(
    direction: &str,
    current_state: Option<&str>,
    next_state: &str,
) -> bool {
    let current = current_state.unwrap_or_default().trim().to_lowercase();
    let next = next_state.trim().to_lowercase();
    let is_response_row = matches!(
        direction,
        BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE | BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE
    );
    if is_response_row
        && current == "processing"
        && matches!(next.as_str(), "sent" | "delivered" | "read")
    {
        return false;
    }
    delivery_state_rank(Some(next_state)) >= delivery_state_rank(current_state)
}

fn update_message_delivery_state_in_db(
    conn: &mut Connection,
    request_id: &str,
    delivery_state: &str,
) -> Result<DesktopBridgeConversationStore, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let now = now_ms();

    let mut statement = tx
        .prepare(
            "SELECT id, conversation_id, direction, delivery_state, text, outreach_metadata FROM bridge_messages\n             WHERE request_id = ?1",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![request_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                parse_optional_json(row.get::<_, Option<String>>(5)?)?,
            ))
        })
        .map_err(sqlite_error)?;

    let mut updates = Vec::new();
    for row in rows {
        let (message_id, conversation_id, direction, current_state, text, outreach) =
            row.map_err(sqlite_error)?;
        if should_apply_delivery_state_update(&direction, current_state.as_deref(), delivery_state)
        {
            updates.push((message_id, conversation_id, text, outreach));
        }
    }
    drop(statement);

    for (message_id, conversation_id, text, mut outreach) in updates {
        if let Some(outreach) = outreach.as_mut() {
            reconcile_message_outreach_metadata(
                outreach,
                Some(delivery_state),
                Some(&text),
                None,
                now,
            );
        }
        let outreach_metadata = optional_json(&outreach)?;
        tx.execute(
            "UPDATE bridge_messages SET delivery_state = ?1, outreach_metadata = ?2 WHERE id = ?3",
            params![delivery_state, outreach_metadata, message_id],
        )
        .map_err(sqlite_error)?;

        let mut conversation = load_conversation_record(&tx, &conversation_id)?;
        if let Some(conversation) = conversation.as_mut() {
            conversation.updated_at_ms = now;
            conversation.peer_last_typing_at_ms = match delivery_state {
                "processing" => Some(now),
                "responded" | "processing_failed" | "cancelled" => None,
                _ => conversation.peer_last_typing_at_ms,
            };
            if let Some(outreach) = conversation.outreach.as_mut() {
                if outreach.bridge_request_id.as_deref() == Some(request_id) {
                    reconcile_conversation_outreach_delivery_state(
                        outreach,
                        delivery_state,
                        Some(&text),
                        now,
                    );
                }
            }
            store_conversation_record(&tx, conversation)?;
        } else {
            tx.execute(
                "UPDATE bridge_conversations\n                 SET updated_at_ms = ?1\n                 WHERE id = ?2",
                params![now, conversation_id],
            )
            .map_err(sqlite_error)?;
        }
    }

    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(conn)
}

#[cfg(test)]
pub(in crate::bridge::storage) fn update_message_delivery_state_in_db_for_test(
    conn: &mut Connection,
    request_id: &str,
    delivery_state: &str,
) -> Result<DesktopBridgeConversationStore, String> {
    update_message_delivery_state_in_db(conn, request_id, delivery_state)
}

pub(in crate::bridge) fn update_message_delivery_state_in_storage(
    request_id: &str,
    delivery_state: &str,
) -> Result<DesktopBridgeConversationStore, String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    update_message_delivery_state_in_db(&mut conn, request_id, delivery_state)
}

pub(in crate::bridge) fn bridge_request_is_cancelled(request_id: &str) -> bool {
    let Ok(mut conn) = open_conversation_db() else {
        return false;
    };
    if migrate_legacy_conversation_json(&mut conn).is_err() {
        return false;
    }
    conn.query_row(
        "SELECT 1 FROM bridge_messages WHERE request_id = ?1 AND delivery_state = 'cancelled' LIMIT 1",
        params![request_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

pub(in crate::bridge::storage) fn update_peer_presence_metadata_in_storage(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
    typing_at_ms: Option<Option<i64>>,
    heartbeat_at_ms: Option<i64>,
) -> Result<DesktopBridgeConversationStore, String> {
    let timestamp_ms = now_ms();
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let Some(mut conversation) =
        find_recent_conversation_for_peer(&tx, host_id, peer_node_id, project_id.as_deref())?
    else {
        tx.commit().map_err(sqlite_error)?;
        return load_conversation_store_from_db(&conn);
    };
    if project_id.is_some() {
        conversation.project_id = project_id;
    }
    if project_name.is_some() {
        conversation.project_name = project_name;
    }
    if let Some(typing_at_ms) = typing_at_ms {
        conversation.peer_last_typing_at_ms = typing_at_ms;
    }
    if let Some(heartbeat_at_ms) = heartbeat_at_ms {
        conversation.peer_last_heartbeat_at_ms = Some(heartbeat_at_ms);
    }
    conversation.updated_at_ms = timestamp_ms;
    store_conversation_record(&tx, &conversation)?;
    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

pub(in crate::bridge) fn note_peer_typing_in_storage(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<DesktopBridgeConversationStore, String> {
    update_peer_presence_metadata_in_storage(
        host_id,
        peer_node_id,
        project_id,
        project_name,
        Some(Some(now_ms())),
        None,
    )
}

pub(in crate::bridge) fn note_peer_heartbeat_in_storage(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<DesktopBridgeConversationStore, String> {
    update_peer_presence_metadata_in_storage(
        host_id,
        peer_node_id,
        project_id,
        project_name,
        None,
        Some(now_ms()),
    )
}

pub(in crate::bridge) fn mark_bridge_conversation_read_in_storage(
    conversation_id: &str,
) -> Result<DesktopBridgeConversationStore, String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    tx.execute(
        "UPDATE bridge_conversations SET unread_count = 0, updated_at_ms = ?1 WHERE id = ?2",
        params![now_ms(), conversation_id],
    )
    .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

pub(in crate::bridge) fn load_conversation_store() -> DesktopBridgeConversationStore {
    let mut conn = match open_conversation_db() {
        Ok(conn) => conn,
        Err(error) => {
            eprintln!("Unable to open desktop bridge conversation SQLite store: {error}");
            return DesktopBridgeConversationStore::default();
        }
    };
    if let Err(error) = migrate_legacy_conversation_json(&mut conn) {
        eprintln!("Unable to migrate desktop bridge conversation JSON store: {error}");
    }
    load_conversation_store_from_db(&conn).unwrap_or_else(|error| {
        eprintln!("Unable to load desktop bridge conversations from SQLite: {error}");
        DesktopBridgeConversationStore::default()
    })
}

pub(in crate::bridge) fn save_conversation_store(
    store: &DesktopBridgeConversationStore,
) -> Result<(), String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    for conversation in &store.conversations {
        upsert_conversation_record(&tx, conversation)?;
    }
    tx.commit().map_err(sqlite_error)?;
    Ok(())
}

pub(in crate::bridge) fn delete_conversations_for_host(host_id: &str) -> Result<(), String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    tx.execute(
        "DELETE FROM bridge_conversations WHERE host_id = ?1",
        params![host_id],
    )
    .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(())
}
