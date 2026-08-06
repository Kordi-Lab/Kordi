//! Cloud message wire envelopes and their persistence lookup helpers.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::cloud_agents::models::CloudAgentMentionPermissions;

use super::group_mentions::{
    enforce_mention_permissions, resolve_agent_mention, CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH,
};

const CLOUD_AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";
const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";
const CLOUD_DIRECT_MESSAGE_PREFIX: &str = "kordi-cloud-message:";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct CloudGroupParticipant {
    #[serde(rename = "accountId")]
    pub(super) account_id: String,
    #[serde(rename = "displayName")]
    pub(super) display_name: String,
    #[serde(rename = "avatarUrl")]
    pub(super) avatar_url: Option<String>,
    pub(super) role: Option<String>,
    #[serde(rename = "agentIds", default, skip_serializing_if = "Vec::is_empty")]
    pub(super) agent_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct CloudGroupMessage {
    pub(super) id: String,
    #[serde(rename = "senderAccountId")]
    pub(super) sender_account_id: String,
    pub(super) text: String,
    #[serde(rename = "createdAtMs")]
    pub(super) created_at_ms: i64,
    #[serde(rename = "senderKind", skip_serializing_if = "Option::is_none")]
    pub(super) sender_kind: Option<String>,
    #[serde(rename = "senderDisplayName", skip_serializing_if = "Option::is_none")]
    pub(super) sender_display_name: Option<String>,
    #[serde(rename = "deliveryState", skip_serializing_if = "Option::is_none")]
    pub(super) delivery_state: Option<String>,
    #[serde(rename = "replyToMessageId", skip_serializing_if = "Option::is_none")]
    pub(super) reply_to_message_id: Option<String>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub(super) request_id: Option<String>,
    #[serde(rename = "messageAction", skip_serializing_if = "Option::is_none")]
    pub(super) message_action: Option<serde_json::Value>,
    #[serde(rename = "targetCloudAgentId", skip_serializing_if = "Option::is_none")]
    pub(super) target_cloud_agent_id: Option<String>,
    #[serde(
        rename = "targetCloudAgentName",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) target_cloud_agent_name: Option<String>,
    #[serde(
        rename = "targetCloudAgentOwnerAccountId",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) target_cloud_agent_owner_account_id: Option<String>,
    #[serde(
        rename = "targetCloudAgentOwnerName",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) target_cloud_agent_owner_name: Option<String>,
    #[serde(rename = "agentMentionDepth", skip_serializing_if = "Option::is_none")]
    pub(super) agent_mention_depth: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct CloudGroupEnvelope {
    pub(super) kind: String,
    #[serde(rename = "groupId")]
    pub(super) group_id: String,
    #[serde(rename = "groupSpaceId", skip_serializing_if = "Option::is_none")]
    pub(super) group_space_id: Option<String>,
    #[serde(rename = "groupTitle")]
    pub(super) group_title: Option<String>,
    #[serde(rename = "createdByAccountId")]
    pub(super) created_by_account_id: String,
    pub(super) actor: CloudGroupParticipant,
    pub(super) participants: Vec<CloudGroupParticipant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) message: Option<CloudGroupMessage>,
}

pub(super) fn cloud_agent_response_text(body: &str) -> Option<String> {
    let encoded = body.trim().strip_prefix(CLOUD_AGENT_RESPONSE_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("text")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

pub(super) fn parse_cloud_group_envelope(body: &str) -> Option<CloudGroupEnvelope> {
    let encoded = body.trim().strip_prefix(CLOUD_GROUP_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn encode_cloud_group_envelope(envelope: &CloudGroupEnvelope) -> String {
    format!(
        "{}{}",
        CLOUD_GROUP_PREFIX,
        URL_SAFE_NO_PAD.encode(serde_json::to_string(envelope).unwrap_or_default())
    )
}

#[cfg(test)]
pub(super) fn cloud_group_response_body(
    request_envelope: &CloudGroupEnvelope,
    owner_account_id: &str,
    request_message_id: &str,
    response_message_id: &str,
    response_text: &str,
    delivery_state: &str,
    created_at_ms: i64,
) -> String {
    cloud_group_response_body_with_policy(
        request_envelope,
        owner_account_id,
        request_message_id,
        response_message_id,
        response_text,
        delivery_state,
        created_at_ms,
        &CloudAgentMentionPermissions {
            people: true,
            agents: true,
        },
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn cloud_group_response_body_with_policy(
    request_envelope: &CloudGroupEnvelope,
    owner_account_id: &str,
    request_message_id: &str,
    response_message_id: &str,
    response_text: &str,
    delivery_state: &str,
    created_at_ms: i64,
    mention_permissions: &CloudAgentMentionPermissions,
    sender_label_override: Option<&str>,
) -> String {
    let owner = request_envelope
        .participants
        .iter()
        .find(|participant| participant.account_id == owner_account_id)
        .cloned()
        .unwrap_or_else(|| CloudGroupParticipant {
            account_id: owner_account_id.to_string(),
            display_name: "Kordi".to_string(),
            avatar_url: None,
            role: Some("person".to_string()),
            agent_ids: Vec::new(),
        });
    let shared_agent_label = request_envelope.message.as_ref().and_then(|message| {
        let agent_name = message.target_cloud_agent_name.as_deref()?.trim();
        if agent_name.is_empty() {
            return None;
        }
        let owner_name = message
            .target_cloud_agent_owner_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| owner.display_name.trim());
        if owner_name.is_empty() {
            Some(agent_name.to_string())
        } else {
            Some(format!("{} · {}'s Agent", agent_name, owner_name))
        }
    });
    let sender_display_name = sender_label_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or(shared_agent_label)
        .unwrap_or_else(|| {
            if owner.display_name.trim().is_empty() {
                "Kordi".to_string()
            } else {
                format!("{}'s Kordi", owner.display_name.trim())
            }
        });
    let response_text = enforce_mention_permissions(
        response_text,
        &request_envelope.participants,
        mention_permissions,
    );
    let request_mention_depth = request_envelope
        .message
        .as_ref()
        .and_then(|message| message.agent_mention_depth)
        .unwrap_or(0);
    let mentioned_agent = (mention_permissions.agents
        && delivery_state == "complete"
        && request_mention_depth < CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH)
        .then(|| {
            resolve_agent_mention(
                &response_text,
                &request_envelope.participants,
                owner_account_id,
            )
        })
        .flatten();
    let target_cloud_agent_owner_account_id = mentioned_agent
        .as_ref()
        .map(|target| target.account_id.clone());
    let target_cloud_agent_owner_name = mentioned_agent
        .as_ref()
        .map(|target| target.display_name.clone());
    let agent_mention_depth = mentioned_agent.as_ref().map(|_| request_mention_depth + 1);
    encode_cloud_group_envelope(&CloudGroupEnvelope {
        kind: "group-message".to_string(),
        group_id: request_envelope.group_id.clone(),
        group_space_id: request_envelope.group_space_id.clone(),
        group_title: None,
        created_by_account_id: request_envelope.created_by_account_id.clone(),
        actor: owner,
        participants: request_envelope.participants.clone(),
        message: Some(CloudGroupMessage {
            id: response_message_id.to_string(),
            sender_account_id: owner_account_id.to_string(),
            text: response_text,
            created_at_ms,
            sender_kind: Some("agent".to_string()),
            sender_display_name: Some(sender_display_name),
            delivery_state: Some(delivery_state.to_string()),
            reply_to_message_id: Some(request_message_id.to_string()),
            request_id: Some(request_message_id.to_string()),
            message_action: None,
            target_cloud_agent_id: None,
            target_cloud_agent_name: None,
            target_cloud_agent_owner_account_id,
            target_cloud_agent_owner_name,
            agent_mention_depth,
        }),
    })
}

pub(super) fn direct_message_envelope(body: &str) -> Option<serde_json::Value> {
    let encoded = body.trim().strip_prefix(CLOUD_DIRECT_MESSAGE_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[derive(Debug, Clone)]
pub(super) struct DirectCloudAgentTarget {
    pub(super) agent_id: String,
    pub(super) owner_account_id: String,
    pub(super) owner_name: Option<String>,
}

pub(super) fn direct_cloud_agent_target(body: &str) -> Option<DirectCloudAgentTarget> {
    let envelope = direct_message_envelope(body)?;
    if envelope
        .get("schemaVersion")
        .and_then(serde_json::Value::as_i64)
        != Some(1)
        || envelope.get("kind").and_then(serde_json::Value::as_str) != Some("message")
    {
        return None;
    }
    let agent_id = envelope
        .get("targetCloudAgentId")?
        .as_str()?
        .trim()
        .to_string();
    let owner_account_id = envelope
        .get("targetCloudAgentOwnerAccountId")?
        .as_str()?
        .trim()
        .to_string();
    if !agent_id.starts_with("cloud_agent_") || owner_account_id.is_empty() {
        return None;
    }
    let owner_name = envelope
        .get("targetCloudAgentOwnerName")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    Some(DirectCloudAgentTarget {
        agent_id,
        owner_account_id,
        owner_name,
    })
}

pub(super) fn encode_cloud_agent_response_body_with_state(
    request_message_id: &str,
    response_text: &str,
    delivery_state: &str,
) -> String {
    let envelope = serde_json::json!({
        "kind": "agent-response",
        "requestId": request_message_id,
        "text": response_text,
        "deliveryState": delivery_state,
    });
    format!(
        "{}{}",
        CLOUD_AGENT_RESPONSE_PREFIX,
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    )
}

pub fn encode_cloud_agent_response_body(request_message_id: &str, response_text: &str) -> String {
    encode_cloud_agent_response_body_with_state(request_message_id, response_text, "complete")
}

pub(super) async fn cloud_group_request_envelope_for_run(
    pool: &PgPool,
    session_id: &str,
    request_message_id: &str,
) -> Result<Option<CloudGroupEnvelope>, sqlx_core::Error> {
    Ok(
        cloud_group_request_envelope_with_created_at_for_run(pool, session_id, request_message_id)
            .await?
            .map(|(envelope, _)| envelope),
    )
}

pub(super) async fn cloud_group_request_envelope_with_created_at_for_run(
    pool: &PgPool,
    session_id: &str,
    request_message_id: &str,
) -> Result<Option<(CloudGroupEnvelope, String)>, sqlx_core::Error> {
    if !session_id.trim().starts_with("session:group:") {
        return Ok(None);
    }
    let rows = query_as::<_, (String, String)>(
        "SELECT body, created_at FROM cloud_messages WHERE session_id = $1 ORDER BY created_at ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().find_map(|(body, created_at)| {
        let envelope = parse_cloud_group_envelope(&body)?;
        let message = envelope.message.as_ref()?;
        (envelope.kind == "group-message" && message.id == request_message_id)
            .then_some((envelope, created_at))
    }))
}

pub(super) async fn latest_cloud_group_envelope_for_session(
    pool: &PgPool,
    session_id: &str,
) -> Result<Option<CloudGroupEnvelope>, sqlx_core::Error> {
    if !session_id.trim().starts_with("session:group:") {
        return Ok(None);
    }
    let rows = query_as::<_, (String,)>(
        "SELECT body FROM cloud_messages WHERE session_id = $1 ORDER BY created_at DESC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().find_map(|(body,)| {
        let envelope = parse_cloud_group_envelope(&body)?;
        (envelope.kind == "group-message" && !envelope.participants.is_empty()).then_some(envelope)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn direct_body(value: serde_json::Value) -> String {
        format!(
            "{CLOUD_DIRECT_MESSAGE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(value.to_string())
        )
    }

    #[test]
    fn direct_agent_target_requires_the_canonical_message_envelope() {
        let valid = direct_body(serde_json::json!({
            "schemaVersion": 1,
            "kind": "message",
            "text": "Help",
            "targetCloudAgentId": "cloud_agent_kordi_support",
            "targetCloudAgentOwnerAccountId": "acct_support",
            "targetCloudAgentOwnerName": "Kordi",
        }));
        let target = direct_cloud_agent_target(&valid).expect("valid direct target");
        assert_eq!(target.agent_id, "cloud_agent_kordi_support");
        assert_eq!(target.owner_account_id, "acct_support");
        assert_eq!(target.owner_name.as_deref(), Some("Kordi"));

        let wrong_kind = direct_body(serde_json::json!({
            "schemaVersion": 1,
            "kind": "agent-response",
            "targetCloudAgentId": "cloud_agent_kordi_support",
            "targetCloudAgentOwnerAccountId": "acct_support",
        }));
        assert!(direct_cloud_agent_target(&wrong_kind).is_none());
    }
}
