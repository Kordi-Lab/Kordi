//! Cloud fallback response routing and durable message fan-out.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::auth::messages::{
    persist_cloud_message_in_transaction, PersistCloudMessageError, PersistCloudMessageInput,
};

use super::envelopes::{
    cloud_group_request_envelope_for_run, cloud_group_response_body,
    latest_cloud_group_envelope_for_session, CloudGroupEnvelope,
};
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

pub(super) async fn ensure_group_response_messages(
    pool: &PgPool,
    response: GroupResponse<'_>,
) -> RunResult<Option<String>> {
    let request_envelope = if is_scheduled_run_request_id(response.request_message_id) {
        latest_cloud_group_envelope_for_session(pool, response.session_id).await?
    } else {
        cloud_group_request_envelope_for_run(pool, response.session_id, response.request_message_id)
            .await?
    };
    let Some(request_envelope) = request_envelope else {
        return Ok(None);
    };
    let mut tx = pool.begin().await?;
    let existing_response: Option<(Option<String>,)> = sqlx_core::query_as::query_as(
        "SELECT response_message_id FROM cloud_agent_fallback_runs \
             WHERE run_id = $1 FOR UPDATE",
    )
    .bind(response.run_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((existing_response_message_id,)) = existing_response else {
        return Err(RunError::NotFound);
    };
    if let Some(message_id) = existing_response_message_id {
        tx.commit().await?;
        return Ok(Some(message_id));
    }

    let response_group_message_id = format!("cloudrunmsg_{}", response.run_id);
    let now = Utc::now();
    let now_string = now.to_rfc3339();
    let now_ms = now.timestamp_millis();
    let response_body = cloud_group_response_body(
        &request_envelope,
        response.owner_account_id,
        response.request_message_id,
        &response_group_message_id,
        response.response_text,
        response.delivery_state,
        now_ms,
    );
    let recipients = cloud_group_response_recipients(&request_envelope);
    let mut first_message_id = None;
    for recipient_account_id in recipients {
        let message_id = format!("cloudrunmsg_{}", Uuid::new_v4().simple());
        let client_message_id = format!(
            "cloud-agent-run:{}:{}",
            response.run_id, recipient_account_id
        );
        let read_at =
            (recipient_account_id == response.owner_account_id).then_some(now_string.as_str());
        let outcome = persist_cloud_message_in_transaction(
            &mut tx,
            PersistCloudMessageInput {
                message_id: &message_id,
                from_account_id: response.owner_account_id,
                to_account_id: &recipient_account_id,
                client_message_id: Some(&client_message_id),
                body: &response_body,
                session_id: Some(response.session_id),
                created_at: &now_string,
                delivered_at: &now_string,
                read_at,
                attachments: &[],
                claim_legacy_self_replay: false,
                legacy_self_replay_lock_id: None,
            },
        )
        .await
        .map_err(run_persistence_error)?;
        if first_message_id.is_none() {
            first_message_id = Some(outcome.message.message_id);
        }
    }
    if let Some(message_id) = &first_message_id {
        query("UPDATE cloud_agent_fallback_runs SET response_message_id = $2, updated_at = $3 WHERE run_id = $1")
            .bind(response.run_id)
            .bind(message_id)
            .bind(&now_string)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(first_message_id)
}

pub(super) async fn ensure_scheduled_direct_person_response_message(
    pool: &PgPool,
    run_id: &str,
    owner_account_id: &str,
    session_id: &str,
    response_body: &str,
) -> RunResult<Option<String>> {
    let Some(peer_account_id) = direct_person_peer_account_id(session_id, owner_account_id) else {
        return Ok(None);
    };
    let mut tx = pool.begin().await?;
    let existing_response: Option<(Option<String>,)> = sqlx_core::query_as::query_as(
        "SELECT response_message_id FROM cloud_agent_fallback_runs \
             WHERE run_id = $1 FOR UPDATE",
    )
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((existing_response_message_id,)) = existing_response else {
        return Err(RunError::NotFound);
    };
    if let Some(message_id) = existing_response_message_id {
        tx.commit().await?;
        return Ok(Some(message_id));
    }

    let message_id = format!("cloudrunmsg_{}", Uuid::new_v4().simple());
    let client_message_id = format!("cloud-agent-run:{run_id}:{peer_account_id}");
    let now = Utc::now().to_rfc3339();
    let outcome = persist_cloud_message_in_transaction(
        &mut tx,
        PersistCloudMessageInput {
            message_id: &message_id,
            from_account_id: owner_account_id,
            to_account_id: &peer_account_id,
            client_message_id: Some(&client_message_id),
            body: response_body,
            session_id: Some(session_id),
            created_at: &now,
            delivered_at: &now,
            read_at: None,
            attachments: &[],
            claim_legacy_self_replay: false,
            legacy_self_replay_lock_id: None,
        },
    )
    .await
    .map_err(run_persistence_error)?;
    query("UPDATE cloud_agent_fallback_runs SET response_message_id = $2, updated_at = $3 WHERE run_id = $1")
        .bind(run_id)
        .bind(&outcome.message.message_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(outcome.message.message_id))
}
