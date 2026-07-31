//! Claim authorization and shared-agent target resolution.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{cloud_group_request_envelope_for_run, ClaimRunRequest};

pub async fn requester_can_target_owner(
    pool: &PgPool,
    requester_account_id: &str,
    owner_account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    if requester_account_id == owner_account_id {
        return Ok(true);
    }
    let row: Option<(String,)> = query_as(
        "SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2 LIMIT 1",
    )
    .bind(requester_account_id)
    .bind(owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

#[derive(Debug, Clone)]
pub(super) struct SharedCloudAgentTarget {
    pub(super) agent_id: String,
    pub(super) owner_account_id: String,
    pub(super) owner_name: Option<String>,
}

pub(super) async fn shared_cloud_agent_target_for_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<Option<SharedCloudAgentTarget>, sqlx_core::Error> {
    let Some(envelope) =
        cloud_group_request_envelope_for_run(pool, &input.session_id, &input.request_message_id)
            .await?
    else {
        return Ok(None);
    };
    let Some(message) = envelope.message else {
        return Ok(None);
    };
    let Some(agent_id) = message
        .target_cloud_agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
    else {
        return Ok(None);
    };
    let owner_account_id = message
        .target_cloud_agent_owner_account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&input.owner_account_id)
        .to_string();
    Ok(Some(SharedCloudAgentTarget {
        agent_id,
        owner_account_id,
        owner_name: message
            .target_cloud_agent_owner_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string),
    }))
}

pub async fn claim_has_shared_cloud_agent_target(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<bool, sqlx_core::Error> {
    Ok(shared_cloud_agent_target_for_claim(pool, input)
        .await?
        .is_some())
}

pub async fn validate_shared_cloud_agent_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<bool, sqlx_core::Error> {
    let Some(target) = shared_cloud_agent_target_for_claim(pool, input).await? else {
        return Ok(true);
    };
    if target.owner_account_id != input.owner_account_id {
        return Ok(false);
    }
    let participants =
        crate::auth::routes::cloud_session_participants(pool, &input.session_id).await?;
    if !participants
        .iter()
        .any(|id| id == &input.requester_account_id)
        || !participants.iter().any(|id| id == &input.owner_account_id)
    {
        return Ok(false);
    }
    let row: Option<(String, String)> = query_as(
        "SELECT access_scope, status FROM cloud_agent_definitions WHERE agent_id = $1 AND owner_account_id = $2",
    )
    .bind(&target.agent_id)
    .bind(&target.owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(
        matches!(row, Some((access_scope, status)) if access_scope == "participant_conversations" && status == "active"),
    )
}
