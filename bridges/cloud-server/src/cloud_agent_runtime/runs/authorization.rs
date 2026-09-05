//! Claim authorization and shared-agent target resolution.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::envelopes::{cloud_group_request_envelope_for_run, direct_cloud_agent_target};
use super::group_mentions::agent_handoff_target;
use super::{ClaimRunRequest, RunResult};

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
    Ok(agent_handoff_target(&envelope).is_some_and(|target| {
        target.participant.account_id.trim() == input.owner_account_id.trim()
    }))
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
        if let Some(message) = envelope.message {
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
                if is_default_kordi_target(
                    &agent_id,
                    &owner_account_id,
                    &input.requester_account_id,
                ) {
                    return Ok(None);
                }
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
    }

    let row: Option<(String,)> = query_as(
        "SELECT message.content #>> '{blocks,0,text}'
         FROM cloud_chat_messages message
         JOIN cloud_chat_conversations conversation
           ON conversation.conversation_id = message.conversation_id
         WHERE message.message_id::text = $1
           AND conversation.legacy_session_id = $2
           AND message.deleted_at IS NULL",
    )
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .fetch_optional(pool)
    .await?;
    let Some(target) = row.and_then(|(body,)| direct_cloud_agent_target(&body)) else {
        return Ok(None);
    };
    if is_default_kordi_target(
        &target.agent_id,
        &target.owner_account_id,
        &input.requester_account_id,
    ) {
        return Ok(None);
    }
    Ok(Some(SharedCloudAgentTarget {
        agent_id: target.agent_id,
        owner_account_id: target.owner_account_id,
        owner_name: target.owner_name,
    }))
}

fn is_default_kordi_target(
    agent_id: &str,
    owner_account_id: &str,
    requester_account_id: &str,
) -> bool {
    agent_id == format!("cloud-agent:{owner_account_id}")
        || agent_id == format!("cloud-self:{owner_account_id}")
        || (agent_id == "cloud-local-agent" && owner_account_id == requester_account_id)
}

pub async fn execution_agent_id(pool: &PgPool, input: &ClaimRunRequest) -> RunResult<String> {
    Ok(shared_cloud_agent_target_for_claim(pool, input)
        .await?
        .map(|target| target.agent_id)
        .unwrap_or_else(|| format!("cloud-agent:{}", input.owner_account_id)))
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
        matches!(row, Some((access_scope, status)) if status == "active"
        && (target.owner_account_id == input.requester_account_id
            || access_scope == "participant_conversations")),
    )
}

#[cfg(test)]
mod tests {
    use super::is_default_kordi_target;

    #[test]
    fn default_kordi_targets_are_not_shared_agent_definitions() {
        assert!(is_default_kordi_target(
            "cloud-agent:acct_owner",
            "acct_owner",
            "acct_requester"
        ));
        assert!(is_default_kordi_target(
            "cloud-local-agent",
            "acct_owner",
            "acct_owner"
        ));
        assert!(!is_default_kordi_target(
            "cloud-local-agent",
            "acct_owner",
            "acct_requester"
        ));
    }
}
