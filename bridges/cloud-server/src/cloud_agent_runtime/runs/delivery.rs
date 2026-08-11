//! Cloud fallback response routing and durable message fan-out.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::sync_events::{
    append_cloud_agent_response_sync_event, CloudAgentResponseSyncEvent,
};

use super::envelopes::{
    cloud_group_request_envelope_for_run, cloud_group_response_body,
    latest_cloud_group_envelope_for_session, CloudGroupEnvelope,
};
use super::RunResult;

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
    let response_group_message_id = response.run_id.to_string();
    let stable_created_at: Option<(String,)> =
        query_as("SELECT created_at FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(response.run_id)
            .fetch_optional(pool)
            .await?;
    let now = stable_created_at
        .and_then(|(value,)| chrono::DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);
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
    let recipient_account_id = cloud_group_response_recipients(&request_envelope)
        .into_iter()
        .find(|recipient| recipient != response.owner_account_id)
        .unwrap_or_else(|| response.owner_account_id.to_string());
    let message_id = append_cloud_agent_response_sync_event(
        pool,
        CloudAgentResponseSyncEvent {
            account_id: &recipient_account_id,
            peer_account_id: response.owner_account_id,
            message_id: &response_group_message_id,
            from_account_id: response.owner_account_id,
            to_account_id: &recipient_account_id,
            body: &response_body,
            session_id: response.session_id,
            direction: cloud_group_response_direction(
                response.owner_account_id,
                &recipient_account_id,
            ),
        },
    )
    .await?;
    if let Some(message_id) = &message_id {
        query("UPDATE cloud_agent_fallback_runs SET response_message_id = $2, updated_at = $3 WHERE run_id = $1")
            .bind(response.run_id)
            .bind(message_id)
            .bind(&now_string)
            .execute(pool)
            .await?;
    }
    Ok(message_id)
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
    let now = Utc::now().to_rfc3339();
    let message_id = append_cloud_agent_response_sync_event(
        pool,
        CloudAgentResponseSyncEvent {
            account_id: owner_account_id,
            peer_account_id: &peer_account_id,
            message_id: run_id,
            from_account_id: owner_account_id,
            to_account_id: &peer_account_id,
            body: response_body,
            session_id,
            direction: "outgoing",
        },
    )
    .await?;
    let Some(message_id) = message_id else {
        return Ok(None);
    };
    query("UPDATE cloud_agent_fallback_runs SET response_message_id = $2, updated_at = $3 WHERE run_id = $1")
        .bind(run_id)
        .bind(&message_id)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(Some(message_id))
}
