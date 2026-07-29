use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run;
use crate::cloud_agent_runtime::sync_events::{
    append_cloud_agent_response_sync_event, CloudAgentResponseSyncEvent,
};
use crate::scheduled_tasks::store::{
    mark_scheduled_task_run_completed, mark_scheduled_task_run_failed,
};
use sqlx_postgres::PgPool;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct ClaimRunRequest {
    #[serde(rename = "requestMessageId")]
    pub request_message_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "requesterAccountId")]
    pub requester_account_id: String,
    pub prompt: String,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

impl ClaimRunRequest {
    pub fn is_well_formed(&self) -> bool {
        !self.request_message_id.trim().is_empty()
            && !self.session_id.trim().is_empty()
            && !self.owner_account_id.trim().is_empty()
            && !self.requester_account_id.trim().is_empty()
            && !self.prompt.trim().is_empty()
            && !self.idempotency_key.trim().is_empty()
    }
}

#[derive(Debug, Serialize)]
pub struct CloudAgentRunResponse {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub status: String,
    #[serde(rename = "sandboxId")]
    pub sandbox_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct CloudAgentRunLookupResponse {
    pub run: Option<CloudAgentRunResponse>,
}

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

const CLOUD_AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";
const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";
const CLOUD_DIRECT_MESSAGE_PREFIX: &str = "kordi-cloud-message:";
const MAX_CLOUD_FALLBACK_HISTORY_MESSAGES: i64 = 12;

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CloudGroupParticipant {
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "avatarUrl")]
    avatar_url: Option<String>,
    role: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CloudGroupMessage {
    id: String,
    #[serde(rename = "senderAccountId")]
    sender_account_id: String,
    text: String,
    #[serde(rename = "createdAtMs")]
    created_at_ms: i64,
    #[serde(rename = "senderKind", skip_serializing_if = "Option::is_none")]
    sender_kind: Option<String>,
    #[serde(rename = "senderDisplayName", skip_serializing_if = "Option::is_none")]
    sender_display_name: Option<String>,
    #[serde(rename = "deliveryState", skip_serializing_if = "Option::is_none")]
    delivery_state: Option<String>,
    #[serde(rename = "replyToMessageId", skip_serializing_if = "Option::is_none")]
    reply_to_message_id: Option<String>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(rename = "messageAction", skip_serializing_if = "Option::is_none")]
    message_action: Option<serde_json::Value>,
    #[serde(rename = "targetCloudAgentId", skip_serializing_if = "Option::is_none")]
    target_cloud_agent_id: Option<String>,
    #[serde(
        rename = "targetCloudAgentName",
        skip_serializing_if = "Option::is_none"
    )]
    target_cloud_agent_name: Option<String>,
    #[serde(
        rename = "targetCloudAgentOwnerAccountId",
        skip_serializing_if = "Option::is_none"
    )]
    target_cloud_agent_owner_account_id: Option<String>,
    #[serde(
        rename = "targetCloudAgentOwnerName",
        skip_serializing_if = "Option::is_none"
    )]
    target_cloud_agent_owner_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CloudGroupEnvelope {
    kind: String,
    #[serde(rename = "groupId")]
    group_id: String,
    #[serde(rename = "groupSpaceId", skip_serializing_if = "Option::is_none")]
    group_space_id: Option<String>,
    #[serde(rename = "groupTitle")]
    group_title: Option<String>,
    #[serde(rename = "createdByAccountId")]
    created_by_account_id: String,
    actor: CloudGroupParticipant,
    participants: Vec<CloudGroupParticipant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<CloudGroupMessage>,
}

#[derive(Debug, Clone)]
struct CloudFallbackHistoryMessage {
    from_account_id: String,
    body: String,
}

fn strip_leading_agent_mention(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with('@') {
        return trimmed.to_string();
    }
    let Some((_, rest)) = trimmed.split_once(char::is_whitespace) else {
        return trimmed.to_string();
    };
    rest.trim().to_string()
}

fn cloud_agent_response_text(body: &str) -> Option<String> {
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

fn parse_cloud_group_envelope(body: &str) -> Option<CloudGroupEnvelope> {
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

fn cloud_group_response_body(
    request_envelope: &CloudGroupEnvelope,
    owner_account_id: &str,
    request_message_id: &str,
    response_message_id: &str,
    response_text: &str,
    delivery_state: &str,
    created_at_ms: i64,
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
    let sender_display_name = shared_agent_label.unwrap_or_else(|| {
        if owner.display_name.trim().is_empty() {
            "Kordi".to_string()
        } else {
            format!("{}'s Kordi", owner.display_name.trim())
        }
    });
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
            text: response_text.to_string(),
            created_at_ms,
            sender_kind: Some("agent".to_string()),
            sender_display_name: Some(sender_display_name),
            delivery_state: Some(delivery_state.to_string()),
            reply_to_message_id: Some(request_message_id.to_string()),
            request_id: Some(request_message_id.to_string()),
            message_action: None,
            target_cloud_agent_id: None,
            target_cloud_agent_name: None,
            target_cloud_agent_owner_account_id: None,
            target_cloud_agent_owner_name: None,
        }),
    })
}

fn direct_message_envelope(body: &str) -> Option<serde_json::Value> {
    let encoded = body.trim().strip_prefix(CLOUD_DIRECT_MESSAGE_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn direct_person_peer_account_id(session_id: &str, owner_account_id: &str) -> Option<String> {
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

fn is_scheduled_run_request_id(request_message_id: &str) -> bool {
    request_message_id.trim().starts_with("scheduled_run_")
}

fn cloud_group_response_recipients(
    request_envelope: &CloudGroupEnvelope,
) -> std::collections::BTreeSet<String> {
    request_envelope
        .participants
        .iter()
        .map(|participant| participant.account_id.trim().to_string())
        .filter(|account_id| !account_id.is_empty())
        .collect()
}

fn cloud_group_response_direction(
    owner_account_id: &str,
    recipient_account_id: &str,
) -> &'static str {
    if recipient_account_id == owner_account_id {
        "outgoing"
    } else {
        "incoming"
    }
}

fn action_context_suffix(action: Option<&serde_json::Value>) -> String {
    let Some(action) = action else {
        return String::new();
    };
    let kind = action
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    let source = action.get("source").and_then(serde_json::Value::as_object);
    let sender = source
        .and_then(|source| source.get("senderLabel"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown sender");
    let source_message_id = source
        .and_then(|source| source.get("sourceMessageId"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    let preview = source
        .and_then(|source| source.get("textPreview"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!(": {}", value.chars().take(180).collect::<String>()))
        .unwrap_or_default();
    match kind {
        "quote" => format!(" [quotes message {source_message_id} from {sender}{preview}]"),
        "forward" => format!(" [forwarded from message {source_message_id} by {sender}{preview}]"),
        _ => String::new(),
    }
}

fn fallback_prompt_history_line(
    requester_account_id: &str,
    owner_account_id: &str,
    message: &CloudFallbackHistoryMessage,
) -> Option<String> {
    let (label, text, suffix) = if let Some(text) = cloud_agent_response_text(&message.body) {
        ("Owner's Kordi", text, String::new())
    } else if let Some(envelope) = parse_cloud_group_envelope(&message.body) {
        let group_message = envelope.message?;
        let label = if group_message.sender_account_id == requester_account_id {
            "Requester"
        } else if group_message.sender_account_id == owner_account_id {
            if group_message.sender_kind.as_deref() == Some("agent") {
                "Owner's Kordi"
            } else {
                "Owner"
            }
        } else {
            "Participant"
        };
        (
            label,
            strip_leading_agent_mention(&group_message.text),
            action_context_suffix(group_message.message_action.as_ref()),
        )
    } else if let Some(envelope) = direct_message_envelope(&message.body) {
        let text = envelope
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let suffix = action_context_suffix(envelope.get("messageAction"));
        if message.from_account_id == requester_account_id {
            ("Requester", strip_leading_agent_mention(&text), suffix)
        } else if message.from_account_id == owner_account_id {
            ("Owner", text.trim().to_string(), suffix)
        } else {
            return None;
        }
    } else if message.from_account_id == requester_account_id {
        (
            "Requester",
            strip_leading_agent_mention(&message.body),
            String::new(),
        )
    } else if message.from_account_id == owner_account_id {
        ("Owner", message.body.trim().to_string(), String::new())
    } else {
        return None;
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(format!("{label}: {text}{suffix}"))
}

fn fallback_prompt_with_history(
    requester_account_id: &str,
    owner_account_id: &str,
    current_prompt: &str,
    history: &[CloudFallbackHistoryMessage],
) -> String {
    let current_prompt = current_prompt.trim();
    let lines = history
        .iter()
        .filter_map(|message| {
            fallback_prompt_history_line(requester_account_id, owner_account_id, message)
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return current_prompt.to_string();
    }
    format!(
        "Conversation history:\n{}\n\nCurrent request:\n{}",
        lines.join("\n"),
        current_prompt
    )
}

#[derive(Debug, Clone)]
struct SharedCloudAgentTarget {
    agent_id: String,
    owner_account_id: String,
    owner_name: Option<String>,
}

async fn shared_cloud_agent_target_for_claim(
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

async fn shared_cloud_agent_prompt_prefix(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<Option<String>, sqlx_core::Error> {
    let Some(target) = shared_cloud_agent_target_for_claim(pool, input).await? else {
        return Ok(None);
    };
    let row: Option<(String, String, Option<String>, serde_json::Value, serde_json::Value)> = query_as(
        "SELECT name, system_prompt, source_summary, boundaries_json, skills_json
         FROM cloud_agent_definitions
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active' AND access_scope = 'participant_conversations'",
    )
    .bind(&target.agent_id)
    .bind(&target.owner_account_id)
    .fetch_optional(pool)
    .await?;
    let Some((name, system_prompt, source_summary, boundaries_json, skills_json)) = row else {
        return Ok(None);
    };
    let boundaries: Vec<String> = serde_json::from_value(boundaries_json).unwrap_or_default();
    let skills: Vec<serde_json::Value> = serde_json::from_value(skills_json).unwrap_or_default();
    let owner = target.owner_name.unwrap_or(target.owner_account_id);
    let mut sections = vec![
        format!("You are {name}, {owner}'s shared Cloud Agent."),
        "Answer as this shared Cloud Agent, not as the default Kordi agent.".to_string(),
        format!("Cloud Agent system prompt:\n{system_prompt}"),
    ];
    if let Some(summary) = source_summary
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("Source summary:\n{summary}"));
    }
    if !boundaries.is_empty() {
        sections.push(format!(
            "Boundaries:\n{}",
            boundaries
                .into_iter()
                .map(|value| format!("- {value}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let skill_sections = skills
        .into_iter()
        .filter_map(|skill| {
            let name = skill.get("name")?.as_str()?.trim();
            let description = skill.get("description")?.as_str()?.trim();
            if name.is_empty() || description.is_empty() {
                return None;
            }
            let content = skill
                .get("content")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            Some(match content {
                Some(content) => format!("Skill {name} ({description}):\n{content}"),
                None => format!("Skill {name}: {description}"),
            })
        })
        .collect::<Vec<_>>();
    if !skill_sections.is_empty() {
        sections.push(format!("Agent skills:\n{}", skill_sections.join("\n\n")));
    }
    Ok(Some(sections.join("\n\n")))
}

async fn fallback_prompt_for_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<String, sqlx_core::Error> {
    let Some((request_created_at,)) = query_as::<_, (String,)>(
        "SELECT created_at FROM cloud_messages WHERE message_id = $1 AND session_id = $2",
    )
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(input.prompt.trim().to_string());
    };

    let mut history = query_as::<_, (String, String)>(
        "SELECT from_account_id, body FROM cloud_messages \
         WHERE session_id = $1 AND created_at < $2 \
         ORDER BY created_at DESC LIMIT $3",
    )
    .bind(&input.session_id)
    .bind(&request_created_at)
    .bind(MAX_CLOUD_FALLBACK_HISTORY_MESSAGES)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(from_account_id, body)| CloudFallbackHistoryMessage {
        from_account_id,
        body,
    })
    .collect::<Vec<_>>();
    history.reverse();

    let prompt = fallback_prompt_with_history(
        &input.requester_account_id,
        &input.owner_account_id,
        &input.prompt,
        &history,
    );
    if let Some(prefix) = shared_cloud_agent_prompt_prefix(pool, input).await? {
        return Ok(format!("{prefix}\n\nConversation request:\n{prompt}"));
    }
    Ok(prompt)
}

pub async fn lookup_run_for_request(
    pool: &PgPool,
    request_message_id: &str,
    account_id: &str,
) -> Result<CloudAgentRunLookupResponse, sqlx_core::Error> {
    let row: Option<(String, String, Option<String>, String, String)> = query_as(
        "SELECT run_id, status, sandbox_id, created_at, updated_at \
         FROM cloud_agent_fallback_runs \
         WHERE request_message_id = $1 AND (owner_account_id = $2 OR requester_account_id = $2) \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(request_message_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;

    Ok(CloudAgentRunLookupResponse {
        run: row.map(|row| CloudAgentRunResponse {
            run_id: row.0,
            status: row.1,
            sandbox_id: row.2,
            created_at: row.3,
            updated_at: row.4,
        }),
    })
}

pub async fn claim_run(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<CloudAgentRunResponse, sqlx_core::Error> {
    let existing: Option<(String, String, Option<String>, String, String)> = query_as(
        "SELECT run_id, status, sandbox_id, created_at, updated_at \
         FROM cloud_agent_fallback_runs WHERE idempotency_key = $1",
    )
    .bind(&input.idempotency_key)
    .fetch_optional(pool)
    .await?;
    if let Some(row) = existing {
        return Ok(CloudAgentRunResponse {
            run_id: row.0,
            status: row.1,
            sandbox_id: row.2,
            created_at: row.3,
            updated_at: row.4,
        });
    }

    let now = Utc::now().to_rfc3339();
    let sandbox = ensure_sandbox_for_run(
        pool,
        &input.session_id,
        &input.owner_account_id,
        &input.requester_account_id,
    )
    .await?;
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let prompt = fallback_prompt_for_claim(pool, input).await?;
    let row: (String, String, Option<String>, String, String) = query_as(
        "INSERT INTO cloud_agent_fallback_runs (
            run_id, idempotency_key, request_message_id, session_id, owner_account_id,
            requester_account_id, status, prompt, sandbox_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $9)
         ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = cloud_agent_fallback_runs.idempotency_key
         RETURNING run_id, status, sandbox_id, created_at, updated_at",
    )
    .bind(&run_id)
    .bind(&input.idempotency_key)
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .bind(&input.owner_account_id)
    .bind(&input.requester_account_id)
    .bind(&prompt)
    .bind(&sandbox.sandbox_id)
    .bind(&now)
    .fetch_one(pool)
    .await?;

    Ok(CloudAgentRunResponse {
        run_id: row.0,
        status: row.1,
        sandbox_id: row.2,
        created_at: row.3,
        updated_at: row.4,
    })
}

#[cfg(test)]
mod tests {
    use super::ClaimRunRequest;

    #[test]
    fn runner_request_accepts_optional_canary_run_id() {
        let request = super::RunnerRunRequest {
            runner_id: "runner-a".to_string(),
            canary_run_id: Some(" car_canary ".to_string()),
        };
        assert_eq!(request.canary_run_id().as_deref(), Some("car_canary"));

        let empty = super::RunnerRunRequest {
            runner_id: "runner-a".to_string(),
            canary_run_id: Some(" ".to_string()),
        };
        assert_eq!(empty.canary_run_id(), None);
    }

    #[test]
    fn cloud_group_response_body_links_to_group_request() {
        let request = super::CloudGroupEnvelope {
            kind: "group-message".to_string(),
            group_id: "session:group:one".to_string(),
            group_space_id: Some("session:group:one".to_string()),
            group_title: None,
            created_by_account_id: "acct_requester".to_string(),
            actor: super::CloudGroupParticipant {
                account_id: "acct_requester".to_string(),
                display_name: "Requester".to_string(),
                avatar_url: None,
                role: Some("admin".to_string()),
            },
            participants: vec![
                super::CloudGroupParticipant {
                    account_id: "acct_requester".to_string(),
                    display_name: "Requester".to_string(),
                    avatar_url: None,
                    role: Some("admin".to_string()),
                },
                super::CloudGroupParticipant {
                    account_id: "acct_owner".to_string(),
                    display_name: "Owner".to_string(),
                    avatar_url: None,
                    role: Some("person".to_string()),
                },
            ],
            message: Some(super::CloudGroupMessage {
                id: "msg:ui:request".to_string(),
                sender_account_id: "acct_requester".to_string(),
                text: "@OwnerKordi hello".to_string(),
                created_at_ms: 1,
                sender_kind: Some("human".to_string()),
                sender_display_name: None,
                delivery_state: None,
                reply_to_message_id: None,
                request_id: None,
                message_action: None,
                target_cloud_agent_id: None,
                target_cloud_agent_name: None,
                target_cloud_agent_owner_account_id: None,
                target_cloud_agent_owner_name: None,
            }),
        };

        let body = super::cloud_group_response_body(
            &request,
            "acct_owner",
            "msg:ui:request",
            "cloudrunmsg_response",
            "Hello everyone!",
            "complete",
            2,
        );
        let response = super::parse_cloud_group_envelope(&body).expect("group response envelope");
        let message = response.message.expect("group response message");

        assert_eq!(response.kind, "group-message");
        assert_eq!(message.sender_account_id, "acct_owner");
        assert_eq!(message.sender_kind.as_deref(), Some("agent"));
        assert_eq!(
            message.sender_display_name.as_deref(),
            Some("Owner's Kordi")
        );
        assert_eq!(message.request_id.as_deref(), Some("msg:ui:request"));
        assert_eq!(message.delivery_state.as_deref(), Some("complete"));
        assert_eq!(message.text, "Hello everyone!");
    }

    #[test]
    fn shared_cloud_agent_group_response_uses_agent_owner_label() {
        let request = super::CloudGroupEnvelope {
            kind: "group-message".to_string(),
            group_id: "session:group:one".to_string(),
            group_space_id: Some("session:group:one".to_string()),
            group_title: None,
            created_by_account_id: "acct_requester".to_string(),
            actor: super::CloudGroupParticipant {
                account_id: "acct_requester".to_string(),
                display_name: "Requester".to_string(),
                avatar_url: None,
                role: Some("admin".to_string()),
            },
            participants: vec![
                super::CloudGroupParticipant {
                    account_id: "acct_requester".to_string(),
                    display_name: "Requester".to_string(),
                    avatar_url: None,
                    role: Some("admin".to_string()),
                },
                super::CloudGroupParticipant {
                    account_id: "acct_owner".to_string(),
                    display_name: "Shuyang".to_string(),
                    avatar_url: None,
                    role: Some("person".to_string()),
                },
            ],
            message: Some(super::CloudGroupMessage {
                id: "msg:ui:request".to_string(),
                sender_account_id: "acct_requester".to_string(),
                text: "@ProjectDriver help".to_string(),
                created_at_ms: 1,
                sender_kind: Some("human".to_string()),
                sender_display_name: None,
                delivery_state: None,
                reply_to_message_id: None,
                request_id: None,
                message_action: None,
                target_cloud_agent_id: Some("cloud_agent_project".to_string()),
                target_cloud_agent_name: Some("Project Driver".to_string()),
                target_cloud_agent_owner_account_id: Some("acct_owner".to_string()),
                target_cloud_agent_owner_name: Some("Shuyang".to_string()),
            }),
        };

        let body = super::cloud_group_response_body(
            &request,
            "acct_owner",
            "msg:ui:request",
            "cloudrunmsg_response",
            "Done.",
            "complete",
            2,
        );
        let response = super::parse_cloud_group_envelope(&body).expect("group response envelope");
        let message = response.message.expect("group response message");

        assert_eq!(
            message.sender_display_name.as_deref(),
            Some("Project Driver · Shuyang's Agent")
        );
    }

    #[test]
    fn fallback_prompt_includes_prior_direct_chat_history() {
        let prompt = super::fallback_prompt_with_history(
            "acct_requester",
            "acct_owner",
            "check ahain",
            &[
                super::CloudFallbackHistoryMessage {
                    from_account_id: "acct_requester".to_string(),
                    body: "@111sKordi what is xuzhu city weather".to_string(),
                },
                super::CloudFallbackHistoryMessage {
                    from_account_id: "acct_owner".to_string(),
                    body: super::encode_cloud_agent_response_body(
                        "msg_weather",
                        "I think you mean Xuzhou city, China.",
                    ),
                },
            ],
        );

        assert!(prompt.contains("Conversation history:\nRequester: what is xuzhu city weather"));
        assert!(prompt.contains("Owner's Kordi: I think you mean Xuzhou city, China."));
        assert!(prompt.ends_with("Current request:\ncheck ahain"));
    }

    #[test]
    fn scheduled_direct_person_peer_routes_to_the_contact_peer() {
        assert_eq!(
            super::direct_person_peer_account_id("session:direct-person:acct_a:acct_b", "acct_a")
                .as_deref(),
            Some("acct_b")
        );
        assert_eq!(
            super::direct_person_peer_account_id("session:direct-person:acct_a:acct_b", "acct_b")
                .as_deref(),
            Some("acct_a")
        );
        assert_eq!(
            super::direct_person_peer_account_id("session:direct-person:acct_a:acct_b", "acct_c"),
            None
        );
    }

    #[test]
    fn scheduled_run_request_ids_are_identified() {
        assert!(super::is_scheduled_run_request_id("scheduled_run_123"));
        assert!(!super::is_scheduled_run_request_id("msg_123"));
    }

    #[test]
    fn scheduled_group_response_recipients_include_owner_and_peer_participants() {
        let envelope = super::CloudGroupEnvelope {
            kind: "group-message".to_string(),
            group_id: "session:group:scheduled".to_string(),
            group_space_id: Some("session:group:scheduled".to_string()),
            group_title: None,
            created_by_account_id: "acct_peer".to_string(),
            actor: super::CloudGroupParticipant {
                account_id: "acct_peer".to_string(),
                display_name: "Peer".to_string(),
                avatar_url: None,
                role: Some("admin".to_string()),
            },
            participants: vec![
                super::CloudGroupParticipant {
                    account_id: "acct_owner".to_string(),
                    display_name: "Owner".to_string(),
                    avatar_url: None,
                    role: Some("person".to_string()),
                },
                super::CloudGroupParticipant {
                    account_id: "acct_peer".to_string(),
                    display_name: "Peer".to_string(),
                    avatar_url: None,
                    role: Some("admin".to_string()),
                },
            ],
            message: None,
        };

        let recipients = super::cloud_group_response_recipients(&envelope);
        assert_eq!(recipients.len(), 2);
        assert!(recipients.contains("acct_owner"));
        assert!(recipients.contains("acct_peer"));
        assert_eq!(
            super::cloud_group_response_direction("acct_owner", "acct_owner"),
            "outgoing"
        );
        assert_eq!(
            super::cloud_group_response_direction("acct_owner", "acct_peer"),
            "incoming"
        );
    }

    #[test]
    fn claim_request_rejects_empty_required_fields() {
        let valid = ClaimRunRequest {
            request_message_id: "msg_1".to_string(),
            session_id: "session:direct-person:a:b".to_string(),
            owner_account_id: "acct_owner".to_string(),
            requester_account_id: "acct_requester".to_string(),
            prompt: "@OwnerKordi hello".to_string(),
            idempotency_key: "session:msg:owner".to_string(),
        };
        assert!(valid.is_well_formed());

        let invalid = ClaimRunRequest {
            prompt: " ".to_string(),
            ..valid
        };
        assert!(!invalid.is_well_formed());
    }
}

#[derive(Debug, Deserialize)]
pub struct RunnerRunRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    #[serde(rename = "canaryRunId")]
    pub canary_run_id: Option<String>,
}

impl RunnerRunRequest {
    pub fn runner_id(&self) -> Option<String> {
        let trimmed = self.runner_id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    pub fn canary_run_id(&self) -> Option<String> {
        let trimmed = self.canary_run_id.as_deref()?.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CompleteRunRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    #[serde(rename = "responseText")]
    pub response_text: String,
}

impl CompleteRunRequest {
    pub fn runner_id(&self) -> Option<String> {
        let trimmed = self.runner_id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct FailRunRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    #[serde(rename = "errorCode")]
    pub error_code: String,
    pub message: String,
}

impl FailRunRequest {
    pub fn runner_id(&self) -> Option<String> {
        let trimmed = self.runner_id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    pub fn error_code(&self) -> String {
        let trimmed = self.error_code.trim();
        if trimmed.is_empty() {
            "runner_error".to_string()
        } else {
            trimmed.to_string()
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RunnerLeaseResponse {
    pub run: Option<RunnerRunResponse>,
}

#[derive(Debug, Serialize)]
pub struct RunnerRunEnvelope {
    pub run: RunnerRunResponse,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunnerRunResponse {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub status: String,
    pub prompt: String,
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "requesterAccountId")]
    pub requester_account_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sandboxId")]
    pub sandbox_id: Option<String>,
    #[serde(rename = "providerAuthAvailable")]
    pub provider_auth_available: bool,
    #[serde(rename = "responseMessageId")]
    pub response_message_id: Option<String>,
    #[serde(rename = "errorCode")]
    pub error_code: Option<String>,
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
}

pub async fn lease_next_run(
    pool: &PgPool,
    runner_id: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let now = Utc::now();
    let lease_expires_at = (now + chrono::Duration::seconds(120)).to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'leased', claimed_by = $1, lease_expires_at = $2, updated_at = $3 \
         WHERE run_id = ( \
             SELECT run_id FROM cloud_agent_fallback_runs \
             WHERE status = 'queued' \
             ORDER BY created_at ASC \
             LIMIT 1 \
             FOR UPDATE SKIP LOCKED \
         ) \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(runner_id)
    .bind(&lease_expires_at)
    .bind(now.to_rfc3339())
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    runner_response_from_row(pool, row).await.map(Some)
}

pub async fn lease_canary_run(
    pool: &PgPool,
    runner_id: &str,
    canary_run_id: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let now = Utc::now();
    let lease_expires_at = (now + chrono::Duration::seconds(120)).to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'leased', claimed_by = $1, lease_expires_at = $2, updated_at = $3 \
         WHERE run_id = $4 AND status = 'queued' \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(runner_id)
    .bind(&lease_expires_at)
    .bind(now.to_rfc3339())
    .bind(canary_run_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    runner_response_from_row(pool, row).await.map(Some)
}

pub async fn mark_run_running(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'running', updated_at = $3 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(Utc::now().to_rfc3339())
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => runner_response_from_row(pool, row).await.map(Some),
        None => Ok(None),
    }
}

fn encode_cloud_agent_response_body_with_state(
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

fn cloud_agent_failure_response_text(error_code: &str) -> &'static str {
    match error_code {
        "missing_provider_auth" => "No provider configured yet.",
        "model_provider_error" => {
            "Cloud fallback could not complete this request because the configured provider/model failed."
        }
        "sandbox_error" => {
            "Cloud fallback could not complete this request because the sandbox failed."
        }
        _ => "Cloud fallback could not complete this request.",
    }
}

fn encode_failed_cloud_agent_response_body(request_message_id: &str, error_code: &str) -> String {
    encode_cloud_agent_response_body_with_state(
        request_message_id,
        cloud_agent_failure_response_text(error_code),
        "failed",
    )
}

async fn cloud_group_request_envelope_for_run(
    pool: &PgPool,
    session_id: &str,
    request_message_id: &str,
) -> Result<Option<CloudGroupEnvelope>, sqlx_core::Error> {
    if !session_id.trim().starts_with("session:group:") {
        return Ok(None);
    }
    let rows = query_as::<_, (String,)>(
        "SELECT body FROM cloud_messages WHERE session_id = $1 ORDER BY created_at ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().find_map(|(body,)| {
        let envelope = parse_cloud_group_envelope(&body)?;
        let message = envelope.message.as_ref()?;
        (envelope.kind == "group-message" && message.id == request_message_id).then_some(envelope)
    }))
}

async fn latest_cloud_group_envelope_for_session(
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

struct GroupResponse<'a> {
    run_id: &'a str,
    owner_account_id: &'a str,
    session_id: &'a str,
    request_message_id: &'a str,
    response_text: &'a str,
    delivery_state: &'a str,
}

async fn ensure_group_response_messages(
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

async fn ensure_scheduled_direct_person_response_message(
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

pub async fn complete_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let trimmed = response_text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let existing: Option<(String, String, String, String, String, Option<String>)> = query_as(
        "SELECT owner_account_id, requester_account_id, session_id, request_message_id, status, response_message_id \
         FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((
        owner_account_id,
        requester_account_id,
        session_id,
        request_message_id,
        _status,
        _message_id,
    )) = existing
    else {
        return Ok(None);
    };
    let response_body = encode_cloud_agent_response_body(&request_message_id, trimmed);
    let mut direct_response_sync_event: Option<String> = None;
    let response_message_id = if is_scheduled_run_request_id(&request_message_id) {
        if let Some(message_id) = ensure_scheduled_direct_person_response_message(
            pool,
            run_id,
            &owner_account_id,
            &session_id,
            &response_body,
        )
        .await?
        {
            message_id
        } else if let Some(message_id) = ensure_group_response_messages(
            pool,
            GroupResponse {
                run_id,
                owner_account_id: &owner_account_id,
                session_id: &session_id,
                request_message_id: &request_message_id,
                response_text: trimmed,
                delivery_state: "complete",
            },
        )
        .await?
        {
            message_id
        } else {
            let message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
                pool,
                run_id,
                &owner_account_id,
                &requester_account_id,
                &session_id,
                &response_body,
            )
            .await?;
            crate::cloud_agent_runtime::artifacts::update_response_message_body(
                pool,
                &message_id,
                &response_body,
            )
            .await?;
            direct_response_sync_event = Some(message_id.clone());
            message_id
        }
    } else if let Some(message_id) = ensure_group_response_messages(
        pool,
        GroupResponse {
            run_id,
            owner_account_id: &owner_account_id,
            session_id: &session_id,
            request_message_id: &request_message_id,
            response_text: trimmed,
            delivery_state: "complete",
        },
    )
    .await?
    {
        message_id
    } else {
        let message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
            pool,
            run_id,
            &owner_account_id,
            &requester_account_id,
            &session_id,
            &response_body,
        )
        .await?;
        crate::cloud_agent_runtime::artifacts::update_response_message_body(
            pool,
            &message_id,
            &response_body,
        )
        .await?;
        direct_response_sync_event = Some(message_id.clone());
        message_id
    };
    if let Some(message_id) = direct_response_sync_event.as_deref() {
        append_cloud_agent_response_sync_event(
            pool,
            CloudAgentResponseSyncEvent {
                account_id: &requester_account_id,
                peer_account_id: &owner_account_id,
                message_id,
                from_account_id: &owner_account_id,
                to_account_id: &requester_account_id,
                body: &response_body,
                session_id: &session_id,
                created_at: &Utc::now().to_rfc3339(),
                direction: "incoming",
            },
        )
        .await?;
    }
    let now = Utc::now();
    let now_text = now.to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'completed', response_message_id = $3, \
             error_code = NULL, error_message = NULL, updated_at = $4, completed_at = $4 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(&response_message_id)
    .bind(&now_text)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => {
            mark_scheduled_task_run_completed(pool, &request_message_id, &response_message_id, now)
                .await?;
            runner_response_from_row(pool, row).await.map(Some)
        }
        None => Ok(None),
    }
}

pub async fn fail_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    error_code: &str,
    message: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let existing: Option<(String, String, String, String, Option<String>)> = query_as(
        "SELECT owner_account_id, requester_account_id, session_id, request_message_id, response_message_id \
         FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((owner_account_id, requester_account_id, session_id, request_message_id, _message_id)) =
        existing
    else {
        return Ok(None);
    };
    let failure_text = cloud_agent_failure_response_text(error_code);
    let response_body = encode_failed_cloud_agent_response_body(&request_message_id, error_code);
    let mut direct_response_sync_event: Option<String> = None;
    let response_message_id = if is_scheduled_run_request_id(&request_message_id) {
        if let Some(message_id) = ensure_scheduled_direct_person_response_message(
            pool,
            run_id,
            &owner_account_id,
            &session_id,
            &response_body,
        )
        .await?
        {
            message_id
        } else if let Some(message_id) = ensure_group_response_messages(
            pool,
            GroupResponse {
                run_id,
                owner_account_id: &owner_account_id,
                session_id: &session_id,
                request_message_id: &request_message_id,
                response_text: failure_text,
                delivery_state: "failed",
            },
        )
        .await?
        {
            message_id
        } else {
            let message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
                pool,
                run_id,
                &owner_account_id,
                &requester_account_id,
                &session_id,
                &response_body,
            )
            .await?;
            crate::cloud_agent_runtime::artifacts::update_response_message_body(
                pool,
                &message_id,
                &response_body,
            )
            .await?;
            direct_response_sync_event = Some(message_id.clone());
            message_id
        }
    } else if let Some(message_id) = ensure_group_response_messages(
        pool,
        GroupResponse {
            run_id,
            owner_account_id: &owner_account_id,
            session_id: &session_id,
            request_message_id: &request_message_id,
            response_text: failure_text,
            delivery_state: "failed",
        },
    )
    .await?
    {
        message_id
    } else {
        let message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
            pool,
            run_id,
            &owner_account_id,
            &requester_account_id,
            &session_id,
            &response_body,
        )
        .await?;
        crate::cloud_agent_runtime::artifacts::update_response_message_body(
            pool,
            &message_id,
            &response_body,
        )
        .await?;
        direct_response_sync_event = Some(message_id.clone());
        message_id
    };
    if let Some(message_id) = direct_response_sync_event.as_deref() {
        append_cloud_agent_response_sync_event(
            pool,
            CloudAgentResponseSyncEvent {
                account_id: &requester_account_id,
                peer_account_id: &owner_account_id,
                message_id,
                from_account_id: &owner_account_id,
                to_account_id: &requester_account_id,
                body: &response_body,
                session_id: &session_id,
                created_at: &Utc::now().to_rfc3339(),
                direction: "incoming",
            },
        )
        .await?;
    }
    let now = Utc::now();
    let now_text = now.to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'failed', response_message_id = $5, error_code = $3, error_message = $4, updated_at = $6, completed_at = $6 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(error_code)
    .bind(message)
    .bind(&response_message_id)
    .bind(&now_text)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => {
            mark_scheduled_task_run_failed(pool, &request_message_id, error_code, message, now)
                .await?;
            runner_response_from_row(pool, row).await.map(Some)
        }
        None => Ok(None),
    }
}

type RunnerRunRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

async fn runner_response_from_row(
    pool: &PgPool,
    row: RunnerRunRow,
) -> Result<RunnerRunResponse, sqlx_core::Error> {
    let provider_auth_available: Option<(String,)> = query_as(
        "SELECT snapshot_id FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&row.3)
    .fetch_optional(pool)
    .await?;
    Ok(RunnerRunResponse {
        run_id: row.0,
        status: row.1,
        prompt: row.2,
        owner_account_id: row.3,
        requester_account_id: row.4,
        session_id: row.5,
        sandbox_id: row.6,
        provider_auth_available: provider_auth_available.is_some(),
        response_message_id: row.7,
        error_code: row.8,
        error_message: row.9,
    })
}
