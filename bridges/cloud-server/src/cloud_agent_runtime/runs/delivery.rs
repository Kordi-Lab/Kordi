//! Cloud fallback response routing and durable message fan-out.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agent_runtime::sync_events::{
    append_cloud_agent_response_sync_event, CloudAgentResponseSyncEvent,
};

use super::envelopes::{
    cloud_group_request_envelope_for_run, cloud_group_response_body,
    latest_cloud_group_envelope_for_session, CloudGroupEnvelope,
};

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
) -> Result<Option<String>, sqlx_core::Error> {
    let request_envelope = if is_scheduled_run_request_id(response.request_message_id) {
        latest_cloud_group_envelope_for_session(pool, response.session_id).await?
    } else {
        cloud_group_request_envelope_for_run(pool, response.session_id, response.request_message_id)
            .await?
    };
    let Some(request_envelope) = request_envelope else {
        return Ok(None);
    };
    let response_group_message_id = format!("cloudrunmsg_{}", Uuid::new_v4().simple());
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
        if first_message_id.is_none() {
            first_message_id = Some(message_id.clone());
        }
        query(
            "INSERT INTO cloud_messages (message_id, from_account_id, to_account_id, body, created_at, delivered_at, session_id) \
             VALUES ($1, $2, $3, $4, $5, $5, $6) \
             ON CONFLICT (message_id) DO NOTHING",
        )
        .bind(&message_id)
        .bind(response.owner_account_id)
        .bind(&recipient_account_id)
        .bind(&response_body)
        .bind(&now_string)
        .bind(response.session_id)
        .execute(pool)
        .await?;
        append_cloud_agent_response_sync_event(
            pool,
            CloudAgentResponseSyncEvent {
                account_id: &recipient_account_id,
                peer_account_id: response.owner_account_id,
                message_id: &message_id,
                from_account_id: response.owner_account_id,
                to_account_id: &recipient_account_id,
                body: &response_body,
                session_id: response.session_id,
                created_at: &now_string,
                direction: cloud_group_response_direction(
                    response.owner_account_id,
                    &recipient_account_id,
                ),
            },
        )
        .await?;
    }
    if let Some(message_id) = &first_message_id {
        query("UPDATE cloud_agent_fallback_runs SET response_message_id = $2, updated_at = $3 WHERE run_id = $1")
            .bind(response.run_id)
            .bind(message_id)
            .bind(&now_string)
            .execute(pool)
            .await?;
    }
    Ok(first_message_id)
}

pub(super) async fn ensure_scheduled_direct_person_response_message(
    pool: &PgPool,
    run_id: &str,
    owner_account_id: &str,
    session_id: &str,
    response_body: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let Some(peer_account_id) = direct_person_peer_account_id(session_id, owner_account_id) else {
        return Ok(None);
    };
    let message_id = format!("cloudrunmsg_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_messages (message_id, from_account_id, to_account_id, body, created_at, delivered_at, session_id) \
         VALUES ($1, $2, $3, $4, $5, $5, $6) \
         ON CONFLICT (message_id) DO NOTHING",
    )
    .bind(&message_id)
    .bind(owner_account_id)
    .bind(&peer_account_id)
    .bind(response_body)
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;
    append_cloud_agent_response_sync_event(
        pool,
        CloudAgentResponseSyncEvent {
            account_id: owner_account_id,
            peer_account_id: &peer_account_id,
            message_id: &message_id,
            from_account_id: owner_account_id,
            to_account_id: &peer_account_id,
            body: response_body,
            session_id,
            created_at: &now,
            direction: "outgoing",
        },
    )
    .await?;
    append_cloud_agent_response_sync_event(
        pool,
        CloudAgentResponseSyncEvent {
            account_id: &peer_account_id,
            peer_account_id: owner_account_id,
            message_id: &message_id,
            from_account_id: owner_account_id,
            to_account_id: &peer_account_id,
            body: response_body,
            session_id,
            created_at: &now,
            direction: "incoming",
        },
    )
    .await?;
    query("UPDATE cloud_agent_fallback_runs SET response_message_id = $2, updated_at = $3 WHERE run_id = $1")
        .bind(run_id)
        .bind(&message_id)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(Some(message_id))
}
