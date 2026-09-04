use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::super::StoreError;
use super::{load_message, normalize_title, MessageSnapshot};

const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";

type ParticipantProfile = (DateTime<Utc>, Option<String>, String);

pub(super) struct GroupEnvelopeProjection {
    pub kind: String,
    pub group_space_id: String,
    pub group_title: Option<String>,
    pub session_title: Option<String>,
}

pub(super) async fn lock_group_message_fingerprint(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    request_fingerprint: &str,
) -> Result<(), StoreError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "group-message:{conversation_id}:{account_id}:{request_fingerprint}"
        ))
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub(super) async fn load_existing_group_message(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    request_fingerprint: &str,
) -> Result<Option<MessageSnapshot>, StoreError> {
    let existing: Option<(Uuid,)> = query_as(
        "SELECT message_id FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND sender_account_id = $2 \
           AND request_fingerprint = $3 \
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(conversation_id)
    .bind(account_id)
    .bind(request_fingerprint)
    .fetch_optional(&mut **transaction)
    .await?;
    match existing {
        Some((message_id,)) => load_message(transaction, message_id).await.map(Some),
        None => Ok(None),
    }
}

pub(super) async fn apply_group_control_title(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    projection: &GroupEnvelopeProjection,
) -> Result<(), StoreError> {
    if matches!(
        projection.kind.as_str(),
        "group-title-update" | "session-title-update"
    ) {
        let authorization: Option<(String, String)> = query_as(
            "SELECT conversation.kind, member.role \
             FROM cloud_chat_conversations conversation \
             JOIN cloud_chat_conversation_members member \
               ON member.conversation_id = conversation.conversation_id \
             WHERE conversation.conversation_id = $1 \
               AND member.account_id = $2 \
               AND member.membership_state = 'active'",
        )
        .bind(conversation_id)
        .bind(account_id)
        .fetch_optional(&mut **transaction)
        .await?;
        let Some((kind, role)) = authorization else {
            return Err(StoreError::Forbidden);
        };
        if kind != "group" || (role != "owner" && role != "admin") {
            return Err(StoreError::Forbidden);
        }
    }
    if projection.kind == "session-title-update" {
        let Some(session_title) = normalize_title(projection.session_title.as_deref())? else {
            return Err(StoreError::InvalidInput("channel title is required"));
        };
        query(
            "UPDATE cloud_chat_conversations \
             SET shared_title = $2, version = version + 1, updated_at = now() \
             WHERE conversation_id = $1 AND shared_title IS DISTINCT FROM $2",
        )
        .bind(conversation_id)
        .bind(session_title)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

fn default_agent_id(account_id: &str) -> String {
    format!("cloud-agent:{}", account_id.trim())
}

fn normalized_group_space_id(value: &str) -> &str {
    let mut normalized = value.trim();
    while let Some(value) = normalized.strip_prefix("group:") {
        normalized = value;
    }
    normalized
}

fn group_text_mut(content: &mut Value) -> Option<&mut Value> {
    content
        .get_mut("blocks")?
        .as_array_mut()?
        .iter_mut()
        .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))?
        .get_mut("text")
}

fn decode_group_envelope(content: &mut Value) -> Option<(Value, &mut Value)> {
    let text = group_text_mut(content)?;
    let encoded = text.as_str()?.strip_prefix(CLOUD_GROUP_PREFIX)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let envelope = serde_json::from_slice(&decoded).ok()?;
    Some((envelope, text))
}

fn encode_group_envelope(envelope: &Value) -> Result<String, StoreError> {
    Ok(format!(
        "{CLOUD_GROUP_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(envelope)
                .map_err(|_| StoreError::InvalidInput("group message envelope is invalid"))?
        )
    ))
}

fn enrich_participant(
    participant: &mut Map<String, Value>,
    profiles: &HashMap<String, ParticipantProfile>,
) {
    let Some(account_id) = participant
        .get("accountId")
        .and_then(Value::as_str)
        .map(ToString::to_string)
    else {
        return;
    };
    let Some((joined_at, owner_name, agent_name)) = profiles.get(&account_id) else {
        return;
    };
    if let Some(owner_name) = owner_name {
        participant.insert("displayName".to_string(), Value::String(owner_name.clone()));
    }
    participant.insert(
        "joinedAt".to_string(),
        Value::String(joined_at.to_rfc3339()),
    );
    participant.insert(
        "agentId".to_string(),
        Value::String(default_agent_id(&account_id)),
    );
    participant.insert(
        "agentDisplayName".to_string(),
        Value::String(agent_name.clone()),
    );
}

pub(super) async fn normalize_group_envelope(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: uuid::Uuid,
    content: &mut Value,
) -> Result<Option<GroupEnvelopeProjection>, StoreError> {
    let Some((mut envelope, text)) = decode_group_envelope(content) else {
        return Ok(None);
    };
    let rows: Vec<(String, DateTime<Utc>, Option<String>, String)> = query_as(
        "SELECT member.account_id, member.joined_at, account.display_name, agent.display_name \
         FROM cloud_chat_conversation_members member \
         JOIN cloud_accounts account ON account.account_id = member.account_id \
         JOIN cloud_default_agent_profiles agent ON agent.owner_account_id = member.account_id \
         WHERE member.conversation_id = $1 AND member.membership_state = 'active' \
         ORDER BY member.joined_at ASC, member.account_id ASC",
    )
    .bind(conversation_id)
    .fetch_all(&mut **transaction)
    .await?;
    let profiles = rows
        .into_iter()
        .map(|(account_id, joined_at, owner_name, agent_name)| {
            (account_id, (joined_at, owner_name, agent_name))
        })
        .collect::<HashMap<_, _>>();
    let object = envelope.as_object_mut().ok_or(StoreError::InvalidInput(
        "group message envelope is invalid",
    ))?;
    if let Some(actor) = object.get_mut("actor").and_then(Value::as_object_mut) {
        enrich_participant(actor, &profiles);
    }
    if let Some(participants) = object.get_mut("participants").and_then(Value::as_array_mut) {
        for participant in participants.iter_mut().filter_map(Value::as_object_mut) {
            enrich_participant(participant, &profiles);
        }
        participants.sort_by(|left, right| {
            let left = left.as_object();
            let right = right.as_object();
            left.and_then(|record| record.get("joinedAt"))
                .and_then(Value::as_str)
                .unwrap_or("9999")
                .cmp(
                    right
                        .and_then(|record| record.get("joinedAt"))
                        .and_then(Value::as_str)
                        .unwrap_or("9999"),
                )
                .then_with(|| {
                    left.and_then(|record| record.get("accountId"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .cmp(
                            right
                                .and_then(|record| record.get("accountId"))
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                        )
                })
        });
    }
    if let Some(message) = object.get_mut("message").and_then(Value::as_object_mut) {
        let sender_is_agent = message.get("senderKind").and_then(Value::as_str) == Some("agent");
        let sender_account_id = message
            .get("senderAccountId")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if sender_is_agent && !sender_account_id.is_empty() {
            let default_id = default_agent_id(&sender_account_id);
            let sender_agent_id = message
                .get("senderAgentId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&default_id)
                .to_string();
            let sender_name = if sender_agent_id == default_id {
                profiles
                    .get(&sender_account_id)
                    .map(|profile| profile.2.clone())
            } else {
                query_as::<_, (String,)>(
                    "SELECT display_name FROM cloud_agent_definitions \
                     WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active'",
                )
                .bind(&sender_agent_id)
                .bind(&sender_account_id)
                .fetch_optional(&mut **transaction)
                .await?
                .map(|row| row.0)
            };
            message.insert("senderAgentId".to_string(), Value::String(sender_agent_id));
            message.insert(
                "senderOwnerAccountId".to_string(),
                Value::String(sender_account_id.to_string()),
            );
            if let Some(owner_name) = profiles
                .get(&sender_account_id)
                .and_then(|profile| profile.1.clone())
            {
                message.insert("senderOwnerName".to_string(), Value::String(owner_name));
            }
            if let Some(sender_name) = sender_name {
                message.insert("senderDisplayName".to_string(), Value::String(sender_name));
            }
        }
    }
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let group_space_id = object
        .get("groupSpaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            object
                .get("groupId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(normalized_group_space_id)
        .unwrap_or_default()
        .to_string();
    if !group_space_id.is_empty() {
        object.insert(
            "groupSpaceId".to_string(),
            Value::String(group_space_id.clone()),
        );
    }
    let group_title = object
        .get("groupTitle")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let session_title = object
        .get("sessionTitle")
        .and_then(Value::as_object)
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    *text = Value::String(encode_group_envelope(&envelope)?);
    Ok(
        (!kind.is_empty() && !group_space_id.is_empty()).then_some(GroupEnvelopeProjection {
            kind,
            group_space_id,
            group_title,
            session_title,
        }),
    )
}

fn is_legacy_default_agent_name(value: &str) -> bool {
    let normalized = value.trim().to_lowercase();
    normalized == "kordi"
        || normalized == "my kordi"
        || normalized.ends_with("'s kordi")
        || normalized.ends_with("’s kordi")
}

pub(crate) fn normalize_stored_group_agent_identity(
    content: &mut Value,
    sender_account_id: &str,
    default_agent_name: &str,
    owner_name: Option<&str>,
) {
    let Some((mut envelope, text)) = decode_group_envelope(content) else {
        return;
    };
    let Some(message) = envelope.get_mut("message").and_then(Value::as_object_mut) else {
        return;
    };
    if message.get("senderKind").and_then(Value::as_str) != Some("agent")
        || message.get("senderAccountId").and_then(Value::as_str) != Some(sender_account_id)
    {
        return;
    }
    let canonical_id = default_agent_id(sender_account_id);
    let sender_agent_id = message
        .get("senderAgentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let legacy_default = sender_agent_id == Some(canonical_id.as_str())
        || (sender_agent_id.is_none()
            && message
                .get("senderDisplayName")
                .and_then(Value::as_str)
                .is_some_and(is_legacy_default_agent_name));
    if !legacy_default {
        return;
    }
    message.insert("senderAgentId".to_string(), Value::String(canonical_id));
    message.insert(
        "senderOwnerAccountId".to_string(),
        Value::String(sender_account_id.to_string()),
    );
    if let Some(owner_name) = owner_name.map(str::trim).filter(|value| !value.is_empty()) {
        message.insert(
            "senderOwnerName".to_string(),
            Value::String(owner_name.to_string()),
        );
    }
    message.insert(
        "senderDisplayName".to_string(),
        Value::String(default_agent_name.to_string()),
    );
    if let Ok(encoded) = encode_group_envelope(&envelope) {
        *text = Value::String(encoded);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn strips_presentation_prefixes_from_group_space_ids() {
        assert_eq!(normalized_group_space_id("group:seed:team"), "seed:team");
        assert_eq!(
            normalized_group_space_id("group:group:seed:team"),
            "seed:team"
        );
        assert_eq!(
            normalized_group_space_id("session:group:team"),
            "session:group:team"
        );
    }

    fn content(sender_name: &str, sender_agent_id: Option<&str>) -> Value {
        let mut message = json!({
            "id": "response",
            "senderAccountId": "acct_owner",
            "senderKind": "agent",
            "senderDisplayName": sender_name,
            "text": "done",
            "createdAtMs": 1
        });
        if let Some(sender_agent_id) = sender_agent_id {
            message["senderAgentId"] = Value::String(sender_agent_id.to_string());
        }
        let envelope = json!({
            "kind": "group-message",
            "groupId": "session:group:test",
            "createdByAccountId": "acct_requester",
            "actor": { "accountId": "acct_owner", "displayName": "Owner" },
            "participants": [{ "accountId": "acct_owner", "displayName": "Owner" }],
            "message": message
        });
        json!({
            "blocks": [{
                "type": "text",
                "text": format!("{CLOUD_GROUP_PREFIX}{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap()))
            }]
        })
    }

    #[test]
    fn repairs_legacy_default_agent_names_without_relabeling_custom_agents() {
        let mut legacy = content("Kordi", None);
        normalize_stored_group_agent_identity(
            &mut legacy,
            "acct_owner",
            "Kordirename11",
            Some("Shu Yang"),
        );
        let (envelope, _) = decode_group_envelope(&mut legacy).expect("group envelope");
        assert_eq!(envelope["message"]["senderDisplayName"], "Kordirename11");
        assert_eq!(
            envelope["message"]["senderAgentId"],
            "cloud-agent:acct_owner"
        );
        assert_eq!(envelope["message"]["senderOwnerName"], "Shu Yang");

        let mut custom = content("Research Agent", Some("cloud_agent_research"));
        normalize_stored_group_agent_identity(
            &mut custom,
            "acct_owner",
            "Kordirename11",
            Some("Shu Yang"),
        );
        let (envelope, _) = decode_group_envelope(&mut custom).expect("group envelope");
        assert_eq!(envelope["message"]["senderDisplayName"], "Research Agent");
    }
}
