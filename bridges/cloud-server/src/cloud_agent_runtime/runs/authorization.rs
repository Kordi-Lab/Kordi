//! Claim authorization and shared-agent target resolution.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::envelopes::{cloud_group_request_envelope_for_run, direct_cloud_agent_target};
use super::group_mentions::agent_handoff_target;
use super::{ClaimRunRequest, RunResult};

fn normalized_agent_id(value: &str) -> &str {
    value
        .trim()
        .strip_prefix("cloud-agent:")
        .unwrap_or(value.trim())
}

async fn synchronized_agent_target_for_envelope(
    pool: &PgPool,
    envelope: &super::envelopes::CloudGroupEnvelope,
    owner_account_id: &str,
) -> Result<Option<SharedCloudAgentTarget>, sqlx_core::Error> {
    let Some(participant) = envelope
        .participants
        .iter()
        .find(|participant| participant.account_id.trim() == owner_account_id.trim())
    else {
        return Ok(None);
    };
    for source_agent_id in participant
        .agent_ids
        .iter()
        .map(|value| normalized_agent_id(value))
        .filter(|value| !value.is_empty())
    {
        let row: Option<(String,)> = query_as(
            "SELECT agent_id FROM cloud_agent_definitions
             WHERE owner_account_id = $1
               AND (agent_id = $2 OR source_agent_id = $2)
               AND status = 'active' AND is_system_managed = FALSE
             LIMIT 1",
        )
        .bind(owner_account_id)
        .bind(source_agent_id)
        .fetch_optional(pool)
        .await?;
        if let Some((agent_id,)) = row {
            return Ok(Some(SharedCloudAgentTarget {
                agent_id,
                owner_account_id: owner_account_id.to_string(),
                owner_name: Some(participant.display_name.trim().to_string())
                    .filter(|value| !value.is_empty()),
            }));
        }
    }
    Ok(None)
}

async fn source_agent_allows_group_handoff(
    pool: &PgPool,
    input: &ClaimRunRequest,
    envelope: &super::envelopes::CloudGroupEnvelope,
) -> RunResult<bool> {
    let Some(request_message_id) = envelope
        .message
        .as_ref()
        .and_then(|message| message.request_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(true);
    };
    let source_request =
        cloud_group_request_envelope_for_run(pool, &input.session_id, request_message_id).await?;
    let Some(source_request) = source_request else {
        return Ok(true);
    };
    let source_agent_id = source_request
        .message
        .as_ref()
        .and_then(|message| message.target_cloud_agent_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let source_agent_id = if let Some(source_agent_id) = source_agent_id {
        source_agent_id
    } else if let Some(target) =
        synchronized_agent_target_for_envelope(pool, &source_request, &input.requester_account_id)
            .await?
    {
        target.agent_id
    } else {
        return Ok(true);
    };
    let row: Option<(bool,)> = query_as(
        "SELECT mention_agents_enabled FROM cloud_agent_definitions
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active'",
    )
    .bind(source_agent_id)
    .bind(&input.requester_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some_and(|(allowed,)| allowed))
}

pub async fn requester_can_target_owner(
    pool: &PgPool,
    requester_account_id: &str,
    owner_account_id: &str,
) -> RunResult<bool> {
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

pub async fn validate_agent_authored_group_handoff_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<bool> {
    let Some(envelope) =
        cloud_group_request_envelope_for_run(pool, &input.session_id, &input.request_message_id)
            .await?
    else {
        return Ok(true);
    };
    let Some(message) = envelope.message.as_ref() else {
        return Ok(false);
    };
    if message.sender_kind.as_deref() != Some("agent") {
        return Ok(true);
    }
    if message.sender_account_id.trim() != input.requester_account_id.trim() {
        return Ok(false);
    }
    if !source_agent_allows_group_handoff(pool, input, &envelope).await? {
        return Ok(false);
    }
    Ok(agent_handoff_target(&envelope)
        .is_some_and(|target| target.account_id.trim() == input.owner_account_id.trim()))
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
    if let Some(envelope) =
        cloud_group_request_envelope_for_run(pool, &input.session_id, &input.request_message_id)
            .await?
    {
        if let Some(message) = envelope.message.as_ref() {
            if let Some(agent_id) = message
                .target_cloud_agent_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
            {
                let owner_account_id = message
                    .target_cloud_agent_owner_account_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&input.owner_account_id)
                    .to_string();
                return Ok(Some(SharedCloudAgentTarget {
                    agent_id,
                    owner_account_id,
                    owner_name: message
                        .target_cloud_agent_owner_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string),
                }));
            }
        }
        if let Some(target) =
            synchronized_agent_target_for_envelope(pool, &envelope, &input.owner_account_id).await?
        {
            return Ok(Some(target));
        }
    }

    let row: Option<(String,)> =
        query_as("SELECT body FROM cloud_messages WHERE message_id = $1 AND session_id = $2")
            .bind(&input.request_message_id)
            .bind(&input.session_id)
            .fetch_optional(pool)
            .await?;
    let Some(target) = row.and_then(|(body,)| direct_cloud_agent_target(&body)) else {
        return Ok(None);
    };
    Ok(Some(SharedCloudAgentTarget {
        agent_id: target.agent_id,
        owner_account_id: target.owner_account_id,
        owner_name: target.owner_name,
    }))
}

pub async fn claim_has_shared_cloud_agent_target(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<bool> {
    Ok(shared_cloud_agent_target_for_claim(pool, input)
        .await?
        .is_some())
}

pub async fn validate_shared_cloud_agent_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<bool> {
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
