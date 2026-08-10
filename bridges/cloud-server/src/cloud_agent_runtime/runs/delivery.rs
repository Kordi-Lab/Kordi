//! Cloud fallback response routing and durable message fan-out.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use crate::auth::messages::{
    append_cloud_message_sync_events_in_transaction, persist_cloud_message_in_transaction,
    PersistCloudMessageError, PersistCloudMessageInput,
};

use super::envelopes::{cloud_group_response_body, CloudGroupEnvelope};
use super::{RunError, RunResult};

fn run_persistence_error(error: PersistCloudMessageError) -> RunError {
    match error {
        PersistCloudMessageError::Database(error) => RunError::Persistence(error),
        PersistCloudMessageError::IdempotencyConflict => {
            RunError::Persistence(sqlx_core::Error::Protocol(
                "cloud agent run reused a delivery id for different message content".to_string(),
            ))
        }
    }
}

pub(super) fn direct_person_peer_account_id(
    session_id: &str,
    owner_account_id: &str,
) -> Option<String> {
    let suffix = session_id.trim().strip_prefix("session:direct-person:")?;
    let mut ids = suffix
        .split(':')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != 2 || !ids.contains(&owner_account_id) {
        return None;
    }
    ids.into_iter()
        .find(|id| *id != owner_account_id)
        .map(ToString::to_string)
}

pub(super) fn is_scheduled_run_request_id(request_message_id: &str) -> bool {
    request_message_id.trim().starts_with("scheduled_run_")
}

pub(super) fn cloud_group_response_recipients(
    request_envelope: &CloudGroupEnvelope,
) -> std::collections::BTreeSet<String> {
    request_envelope
        .participants
        .iter()
        .map(|participant| participant.account_id.trim().to_string())
        .filter(|account_id| !account_id.is_empty())
        .collect()
}

#[cfg(test)]
pub(super) fn cloud_group_response_direction(
    owner_account_id: &str,
    recipient_account_id: &str,
) -> &'static str {
    if recipient_account_id == owner_account_id {
        "outgoing"
    } else {
        "incoming"
    }
}

pub(super) struct GroupResponse<'a> {
    pub(super) run_id: &'a str,
    pub(super) owner_account_id: &'a str,
    pub(super) session_id: &'a str,
    pub(super) request_message_id: &'a str,
    pub(super) response_text: &'a str,
    pub(super) delivery_state: &'a str,
}

async fn upsert_response_message_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    run_id: &str,
    owner_account_id: &str,
    recipient_account_id: &str,
    session_id: &str,
    response_body: &str,
    now: &str,
) -> RunResult<String> {
    let client_message_id = format!("cloud-agent-run:{run_id}:{recipient_account_id}");
    let existing: Option<(String, Option<String>)> = query_as(
        "SELECT message_id, session_id FROM cloud_messages \
         WHERE from_account_id = $1 AND to_account_id = $2 \
           AND client_message_id = $3 FOR UPDATE",
    )
    .bind(owner_account_id)
    .bind(recipient_account_id)
    .bind(&client_message_id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some((message_id, existing_session_id)) = existing {
        if existing_session_id.as_deref() != Some(session_id) {
            return Err(RunError::Persistence(sqlx_core::Error::Protocol(
                "cloud agent response delivery changed session".to_string(),
            )));
        }
        query("UPDATE cloud_messages SET body = $2 WHERE message_id = $1")
            .bind(&message_id)
            .bind(response_body)
            .execute(&mut **tx)
            .await?;
        append_cloud_message_sync_events_in_transaction(tx, &message_id).await?;
        return Ok(message_id);
    }

    let message_id = format!("cloudrunmsg_{}", Uuid::new_v4().simple());
    let read_at = (recipient_account_id == owner_account_id).then_some(now);
    let outcome = persist_cloud_message_in_transaction(
        tx,
        PersistCloudMessageInput {
            message_id: &message_id,
            from_account_id: owner_account_id,
            to_account_id: recipient_account_id,
            client_message_id: Some(&client_message_id),
            body: response_body,
            session_id: Some(session_id),
            created_at: now,
            delivered_at: now,
            read_at,
            attachments: &[],
            claim_legacy_self_replay: false,
            legacy_self_replay_lock_id: None,
        },
    )
    .await
    .map_err(run_persistence_error)?;
    Ok(outcome.message.message_id)
}

pub(super) async fn ensure_direct_response_message_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    run_id: &str,
    owner_account_id: &str,
    requester_account_id: &str,
    session_id: &str,
    response_body: &str,
    now: &str,
) -> RunResult<String> {
    upsert_response_message_in_transaction(
        tx,
        run_id,
        owner_account_id,
        requester_account_id,
        session_id,
        response_body,
        now,
    )
    .await
}

pub(super) async fn ensure_group_response_messages_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    response: GroupResponse<'_>,
    request_envelope: &CloudGroupEnvelope,
    preferred_message_id: Option<&str>,
    now: &str,
) -> RunResult<Option<String>> {
    let response_group_message_id = format!("cloudrunmsg_{}", response.run_id);
    let now_ms = chrono::DateTime::parse_from_rfc3339(now)
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|_| Utc::now().timestamp_millis());
    let response_body = cloud_group_response_body(
        request_envelope,
        response.owner_account_id,
        response.request_message_id,
        &response_group_message_id,
        response.response_text,
        response.delivery_state,
        now_ms,
    );
    let mut message_ids = Vec::new();
    for recipient_account_id in cloud_group_response_recipients(request_envelope) {
        message_ids.push(
            upsert_response_message_in_transaction(
                tx,
                response.run_id,
                response.owner_account_id,
                &recipient_account_id,
                response.session_id,
                &response_body,
                now,
            )
            .await?,
        );
    }
    Ok(preferred_message_id
        .filter(|preferred| message_ids.iter().any(|id| id == preferred))
        .map(ToString::to_string)
        .or_else(|| message_ids.into_iter().next()))
}

pub(super) async fn ensure_scheduled_direct_person_response_message_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    run_id: &str,
    owner_account_id: &str,
    session_id: &str,
    response_body: &str,
    now: &str,
) -> RunResult<Option<String>> {
    let Some(peer_account_id) = direct_person_peer_account_id(session_id, owner_account_id) else {
        return Ok(None);
    };
    upsert_response_message_in_transaction(
        tx,
        run_id,
        owner_account_id,
        &peer_account_id,
        session_id,
        response_body,
        now,
    )
    .await
    .map(Some)
}
