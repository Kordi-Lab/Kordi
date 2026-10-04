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
use super::envelope_placement::{
    canonicalize_envelope_placement, validate_envelope_placement, CLOUD_GROUP_PREFIX,
    INVALID_GROUP_ENVELOPE,
};
use super::{load_message, normalize_title, MessageSnapshot};

const SENDER_MISMATCH: &str = "group message sender must be the signed-in account";
const UNOWNED_SENDER_AGENT: &str = "group message agent must belong to the signed-in account";
/// Agent-only presentation fields. The server derives them for agent senders
/// and removes them from human messages.
const AGENT_SENDER_FIELDS: [&str; 3] = ["senderAgentId", "senderOwnerAccountId", "senderOwnerName"];

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

/// Identifiers that clients use for the sender's own default agent. Older
/// desktop and iOS builds still send the legacy local-execution aliases.
fn is_default_agent_alias(agent_id: &str, account_id: &str) -> bool {
    let account_id = account_id.trim();
    agent_id == default_agent_id(account_id)
        || agent_id == "cloud-local-agent"
        || agent_id == format!("cloud-self:{account_id}")
}

/// Returns whether message content carries a group envelope, and rejects any
/// envelope outside canonical position. Clients join the text of every block
/// before decoding, so an envelope that starts in a later block, after
/// whitespace, or split across blocks must never reach storage without server
/// normalization.
fn carries_group_envelope(content: &Value) -> Result<bool, StoreError> {
    Ok(validate_envelope_placement(content)? == Some(CLOUD_GROUP_PREFIX))
}

fn decode_group_envelope_strict(text: &str) -> Result<Value, StoreError> {
    let encoded = text
        .strip_prefix(CLOUD_GROUP_PREFIX)
        .ok_or(StoreError::InvalidInput(INVALID_GROUP_ENVELOPE))?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| StoreError::InvalidInput(INVALID_GROUP_ENVELOPE))?;
    let envelope: Value = serde_json::from_slice(&decoded)
        .map_err(|_| StoreError::InvalidInput(INVALID_GROUP_ENVELOPE))?;
    if envelope.is_object() {
        Ok(envelope)
    } else {
        Err(StoreError::InvalidInput(INVALID_GROUP_ENVELOPE))
    }
}

/// The sender's server-side display names: the account display name and the
/// default agent display name.
async fn sender_names(
    transaction: &mut Transaction<'_, Postgres>,
    profiles: &HashMap<String, ParticipantProfile>,
    sender_account_id: &str,
) -> Result<(Option<String>, Option<String>), StoreError> {
    if let Some((_, owner_name, agent_name)) = profiles.get(sender_account_id) {
        return Ok((owner_name.clone(), Some(agent_name.clone())));
    }
    let row: Option<(Option<String>, Option<String>)> = query_as(
        "SELECT account.display_name, agent.display_name \
         FROM cloud_accounts account \
         LEFT JOIN cloud_default_agent_profiles agent \
           ON agent.owner_account_id = account.account_id \
         WHERE account.account_id = $1",
    )
    .bind(sender_account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(row.unwrap_or_default())
}

fn set_or_remove(message: &mut Map<String, Value>, key: &str, value: Option<String>) {
    match value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(value) => {
            message.insert(key.to_string(), Value::String(value));
        }
        None => {
            message.remove(key);
        }
    }
}

/// Binds the envelope's sender fields to the authenticated account. The
/// claimed sender must be that account, an agent sender must be one of its
/// agents, and every display field is derived from server records.
async fn bind_group_message_sender(
    transaction: &mut Transaction<'_, Postgres>,
    message: &mut Map<String, Value>,
    sender_account_id: &str,
    profiles: &HashMap<String, ParticipantProfile>,
) -> Result<(), StoreError> {
    let claimed_sender_matches = match message.get("senderAccountId") {
        None | Some(Value::Null) => true,
        Some(Value::String(claimed)) => {
            let claimed = claimed.trim();
            claimed.is_empty() || claimed == sender_account_id
        }
        Some(_) => false,
    };
    if !claimed_sender_matches {
        return Err(StoreError::InvalidInput(SENDER_MISMATCH));
    }
    message.insert(
        "senderAccountId".to_string(),
        Value::String(sender_account_id.to_string()),
    );
    let (owner_name, default_agent_name) =
        sender_names(transaction, profiles, sender_account_id).await?;
    if message.get("senderKind").and_then(Value::as_str) != Some("agent") {
        if message.contains_key("senderKind") {
            message.insert("senderKind".to_string(), Value::String("human".to_string()));
        }
        for key in AGENT_SENDER_FIELDS {
            message.remove(key);
        }
        set_or_remove(message, "senderDisplayName", owner_name);
        return Ok(());
    }
    let sender_agent_id = message
        .get("senderAgentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| default_agent_id(sender_account_id));
    let agent_name = if is_default_agent_alias(&sender_agent_id, sender_account_id) {
        default_agent_name
    } else {
        // Ownership binds the agent to the sender. An agent archived after a
        // run was admitted still belongs to its owner, so that run can publish
        // its final state instead of leaving a processing message behind.
        let owned: Option<(String,)> = query_as(
            "SELECT name FROM cloud_agent_definitions \
             WHERE agent_id = $1 AND owner_account_id = $2",
        )
        .bind(&sender_agent_id)
        .bind(sender_account_id)
        .fetch_optional(&mut **transaction)
        .await?;
        Some(
            owned
                .ok_or(StoreError::InvalidInput(UNOWNED_SENDER_AGENT))?
                .0,
        )
    };
    message.insert("senderAgentId".to_string(), Value::String(sender_agent_id));
    message.insert(
        "senderOwnerAccountId".to_string(),
        Value::String(sender_account_id.to_string()),
    );
    set_or_remove(message, "senderOwnerName", owner_name);
    set_or_remove(message, "senderDisplayName", agent_name);
    Ok(())
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
    // Accounts without a display name show their account id, as clients do
    // for members, never a name chosen by the sender.
    let display_name = owner_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&account_id);
    participant.insert(
        "displayName".to_string(),
        Value::String(display_name.to_string()),
    );
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

/// Normalizes a group envelope before it is stored. The server is
/// authoritative for sender identity: the envelope's sender and actor must be
/// the authenticated account, and names are derived from server records.
pub(super) async fn normalize_group_envelope(
    transaction: &mut Transaction<'_, Postgres>,
    sender_account_id: &str,
    conversation_id: uuid::Uuid,
    content: &mut Value,
) -> Result<Option<GroupEnvelopeProjection>, StoreError> {
    if !carries_group_envelope(content)? {
        return Ok(None);
    }
    let text = group_text_mut(content).ok_or(StoreError::InvalidInput(INVALID_GROUP_ENVELOPE))?;
    let mut envelope = decode_group_envelope_strict(text.as_str().unwrap_or_default())?;
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
    let object = envelope
        .as_object_mut()
        .ok_or(StoreError::InvalidInput(INVALID_GROUP_ENVELOPE))?;
    if let Some(actor) = object.get_mut("actor").and_then(Value::as_object_mut) {
        let actor_matches = match actor.get("accountId") {
            None | Some(Value::Null) => true,
            Some(Value::String(account_id)) => {
                let account_id = account_id.trim();
                account_id.is_empty() || account_id == sender_account_id
            }
            Some(_) => false,
        };
        if !actor_matches {
            return Err(StoreError::InvalidInput(SENDER_MISMATCH));
        }
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
    match object.get_mut("message") {
        None | Some(Value::Null) => {}
        Some(Value::Object(message)) => {
            bind_group_message_sender(transaction, message, sender_account_id, &profiles).await?;
        }
        Some(_) => return Err(StoreError::InvalidInput(INVALID_GROUP_ENVELOPE)),
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

/// Presents a stored envelope as the stored sender's own human message.
fn present_as_stored_human(
    message: &mut Map<String, Value>,
    sender_account_id: &str,
    owner_name: Option<String>,
) {
    message.insert(
        "senderAccountId".to_string(),
        Value::String(sender_account_id.to_string()),
    );
    if message.contains_key("senderKind") {
        message.insert("senderKind".to_string(), Value::String("human".to_string()));
    }
    for key in AGENT_SENDER_FIELDS {
        message.remove(key);
    }
    set_or_remove(message, "senderDisplayName", owner_name);
}

/// Applies server records to a stored group envelope when it is read, so
/// clients render only an identity the server can vouch for, including for
/// messages stored before envelope senders were bound on write:
///
/// - An envelope that names another sender is the stored sender's own human
///   message.
/// - Human messages show the sender's account display name.
/// - Agent messages name the stored sender as their owner. The default agent
///   shows its current name; custom agents are checked against agent records
///   by `verify_stored_custom_agent_senders`.
pub(crate) fn normalize_stored_group_agent_identity(
    content: &mut Value,
    sender_account_id: &str,
    default_agent_name: &str,
    owner_name: Option<&str>,
) {
    canonicalize_envelope_placement(content);
    let Some((mut envelope, text)) = decode_group_envelope(content) else {
        return;
    };
    let Some(message) = envelope.get_mut("message").and_then(Value::as_object_mut) else {
        return;
    };
    let original = message.clone();
    let owner_name = owner_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    if message.get("senderAccountId").and_then(Value::as_str) != Some(sender_account_id) {
        present_as_stored_human(message, sender_account_id, owner_name);
    } else if message.get("senderKind").and_then(Value::as_str) == Some("agent") {
        message.insert(
            "senderOwnerAccountId".to_string(),
            Value::String(sender_account_id.to_string()),
        );
        set_or_remove(message, "senderOwnerName", owner_name);
        let sender_agent_id = message
            .get("senderAgentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        match sender_agent_id {
            None => {
                message.insert(
                    "senderAgentId".to_string(),
                    Value::String(default_agent_id(sender_account_id)),
                );
                set_or_remove(
                    message,
                    "senderDisplayName",
                    Some(default_agent_name.to_string()),
                );
            }
            Some(agent_id) if is_default_agent_alias(&agent_id, sender_account_id) => {
                set_or_remove(
                    message,
                    "senderDisplayName",
                    Some(default_agent_name.to_string()),
                );
            }
            Some(_) => {}
        }
    } else {
        for key in AGENT_SENDER_FIELDS {
            message.remove(key);
        }
        set_or_remove(message, "senderDisplayName", owner_name);
    }
    if *message != original {
        if let Ok(encoded) = encode_group_envelope(&envelope) {
            *text = Value::String(encoded);
        }
    }
}

/// The custom agent that a stored group envelope names for its stored sender.
fn custom_agent_claim(content: &Value, sender_account_id: &str) -> Option<String> {
    let text = content
        .get("blocks")?
        .as_array()?
        .iter()
        .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))?
        .get("text")?
        .as_str()?;
    let decoded = URL_SAFE_NO_PAD
        .decode(text.strip_prefix(CLOUD_GROUP_PREFIX)?)
        .ok()?;
    let envelope: Value = serde_json::from_slice(&decoded).ok()?;
    let message = envelope.get("message")?;
    if message.get("senderKind").and_then(Value::as_str) != Some("agent")
        || message.get("senderAccountId").and_then(Value::as_str) != Some(sender_account_id)
    {
        return None;
    }
    let agent_id = message.get("senderAgentId")?.as_str()?.trim();
    (!agent_id.is_empty() && !is_default_agent_alias(agent_id, sender_account_id))
        .then(|| agent_id.to_string())
}

fn apply_custom_agent_record(
    content: &mut Value,
    agent_name: Option<String>,
    owner_name: Option<String>,
) {
    let Some((mut envelope, text)) = decode_group_envelope(content) else {
        return;
    };
    let Some(message) = envelope.get_mut("message").and_then(Value::as_object_mut) else {
        return;
    };
    let original = message.clone();
    match agent_name {
        Some(agent_name) => set_or_remove(message, "senderDisplayName", Some(agent_name)),
        None => {
            message.insert("senderKind".to_string(), Value::String("human".to_string()));
            for key in AGENT_SENDER_FIELDS {
                message.remove(key);
            }
            set_or_remove(message, "senderDisplayName", owner_name);
        }
    }
    if *message != original {
        if let Ok(encoded) = encode_group_envelope(&envelope) {
            *text = Value::String(encoded);
        }
    }
}

/// Checks the custom agents named by stored group messages against agent
/// records when the messages are read. An agent that belongs to the stored
/// sender shows its current name; any other agent claim is presented as the
/// stored sender's own human message.
pub(crate) async fn verify_stored_custom_agent_senders(
    transaction: &mut Transaction<'_, Postgres>,
    messages: &mut [MessageSnapshot],
) -> Result<(), StoreError> {
    let claims = messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            custom_agent_claim(&message.content, &message.sender_account_id)
                .map(|agent_id| (index, agent_id))
        })
        .collect::<Vec<_>>();
    if claims.is_empty() {
        return Ok(());
    }
    let owners = claims
        .iter()
        .map(|(index, _)| messages[*index].sender_account_id.clone())
        .collect::<Vec<_>>();
    let agent_ids = claims
        .iter()
        .map(|(_, agent_id)| agent_id.clone())
        .collect::<Vec<_>>();
    let rows: Vec<(String, String, Option<String>, Option<String>)> = query_as(
        "SELECT claim.owner_account_id, claim.agent_id, agent.name, account.display_name \
         FROM UNNEST($1::text[], $2::text[]) AS claim(owner_account_id, agent_id) \
         JOIN cloud_accounts account ON account.account_id = claim.owner_account_id \
         LEFT JOIN cloud_agent_definitions agent \
           ON agent.owner_account_id = claim.owner_account_id \
          AND agent.agent_id = claim.agent_id",
    )
    .bind(&owners)
    .bind(&agent_ids)
    .fetch_all(&mut **transaction)
    .await?;
    let records = rows
        .into_iter()
        .map(|(owner, agent_id, agent_name, owner_name)| {
            ((owner, agent_id), (agent_name, owner_name))
        })
        .collect::<HashMap<_, _>>();
    for (index, agent_id) in claims {
        let message = &mut messages[index];
        let (agent_name, owner_name) = records
            .get(&(message.sender_account_id.clone(), agent_id))
            .cloned()
            .unwrap_or_default();
        apply_custom_agent_record(&mut message.content, agent_name, owner_name);
    }
    Ok(())
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

    #[test]
    fn stored_envelopes_naming_another_sender_present_as_the_stored_sender() {
        let mut stored = content("Owner's Agent", Some("cloud_agent_research"));
        normalize_stored_group_agent_identity(
            &mut stored,
            "acct_member",
            "Member Kordi",
            Some("Member"),
        );
        let (envelope, _) = decode_group_envelope(&mut stored).expect("group envelope");
        let message = &envelope["message"];
        assert_eq!(message["senderAccountId"], "acct_member");
        assert_eq!(message["senderKind"], "human");
        assert_eq!(message["senderDisplayName"], "Member");
        for key in AGENT_SENDER_FIELDS {
            assert!(message.get(key).is_none(), "{key} must be removed");
        }
        assert_eq!(message["text"], "done");
    }

    fn with_message(message: Value) -> Value {
        let envelope = json!({
            "kind": "group-message",
            "groupId": "session:group:test",
            "createdByAccountId": "acct_owner",
            "actor": { "accountId": "acct_member", "displayName": "Member" },
            "participants": [],
            "message": message
        });
        json!({ "blocks": [{
            "type": "text",
            "text": encode_group_envelope(&envelope).unwrap()
        }] })
    }

    #[test]
    fn stored_agent_messages_name_the_stored_sender_as_owner() {
        let mut stored = with_message(json!({
            "id": "agent", "senderAccountId": "acct_member", "senderKind": "agent",
            "senderAgentId": "cloud_agent_other", "senderDisplayName": "Owner's Research Agent",
            "senderOwnerName": "Owner", "senderOwnerAccountId": "acct_owner", "text": "approved"
        }));
        normalize_stored_group_agent_identity(
            &mut stored,
            "acct_member",
            "Member Kordi",
            Some("Member"),
        );
        let (envelope, _) = decode_group_envelope(&mut stored).expect("group envelope");
        let message = &envelope["message"];
        assert_eq!(message["senderOwnerAccountId"], "acct_member");
        assert_eq!(message["senderOwnerName"], "Member");
        assert_eq!(
            custom_agent_claim(&stored, "acct_member").as_deref(),
            Some("cloud_agent_other")
        );
        assert_eq!(custom_agent_claim(&stored, "acct_owner"), None);

        // An agent that the stored sender does not own becomes its human message.
        apply_custom_agent_record(&mut stored, None, Some("Member".to_string()));
        let (envelope, _) = decode_group_envelope(&mut stored).expect("group envelope");
        let message = &envelope["message"];
        assert_eq!(message["senderKind"], "human");
        assert_eq!(message["senderDisplayName"], "Member");
        for key in AGENT_SENDER_FIELDS {
            assert!(message.get(key).is_none(), "{key} must be removed");
        }
        assert_eq!(custom_agent_claim(&stored, "acct_member"), None);

        let mut owned = with_message(json!({
            "id": "agent", "senderAccountId": "acct_member", "senderKind": "agent",
            "senderAgentId": "cloud_agent_mine", "senderDisplayName": "Anything", "text": "ok"
        }));
        apply_custom_agent_record(&mut owned, Some("Research".to_string()), None);
        let (envelope, _) = decode_group_envelope(&mut owned).expect("group envelope");
        assert_eq!(envelope["message"]["senderDisplayName"], "Research");
        assert_eq!(envelope["message"]["senderKind"], "agent");

        let mut default_alias = with_message(json!({
            "id": "agent", "senderAccountId": "acct_member", "senderKind": "agent",
            "senderAgentId": "cloud-local-agent", "senderDisplayName": "Owner Kordi", "text": "ok"
        }));
        normalize_stored_group_agent_identity(
            &mut default_alias,
            "acct_member",
            "Member Kordi",
            Some("Member"),
        );
        let (envelope, _) = decode_group_envelope(&mut default_alias).expect("group envelope");
        assert_eq!(envelope["message"]["senderDisplayName"], "Member Kordi");
        assert_eq!(custom_agent_claim(&default_alias, "acct_member"), None);
    }

    #[test]
    fn stored_human_messages_show_the_account_display_name() {
        let mut stored = with_message(json!({
            "id": "human", "senderAccountId": "acct_member", "senderKind": "human",
            "senderDisplayName": "Totally The Owner", "senderOwnerAccountId": "acct_owner",
            "text": "hello"
        }));
        normalize_stored_group_agent_identity(
            &mut stored,
            "acct_member",
            "Member Kordi",
            Some("Member"),
        );
        let (envelope, _) = decode_group_envelope(&mut stored).expect("group envelope");
        assert_eq!(envelope["message"]["senderDisplayName"], "Member");
        assert!(envelope["message"].get("senderOwnerAccountId").is_none());

        let mut unnamed = with_message(json!({
            "id": "human", "senderAccountId": "acct_member",
            "senderDisplayName": "Totally The Owner", "text": "hello"
        }));
        normalize_stored_group_agent_identity(&mut unnamed, "acct_member", "Kordi", None);
        let (envelope, _) = decode_group_envelope(&mut unnamed).expect("group envelope");
        assert!(envelope["message"].get("senderDisplayName").is_none());
    }

    #[test]
    fn stored_envelopes_split_across_blocks_are_repaired_as_clients_read_them() {
        let named_owner = with_message(json!({
            "id": "named-owner", "senderAccountId": "acct_owner", "senderKind": "human",
            "senderDisplayName": "Owner", "text": "hello"
        }));
        let text = named_owner["blocks"][0]["text"].as_str().unwrap();
        let (head, tail) = text.split_at("kordi-cloud-".len());
        let mut stored = json!({ "blocks": [
            { "type": "text", "text": head },
            { "type": "text", "text": tail }
        ] });
        normalize_stored_group_agent_identity(&mut stored, "acct_member", "Kordi", Some("Member"));
        let joined = stored["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<String>();
        assert_eq!(joined, stored["blocks"][0]["text"].as_str().unwrap());
        let (envelope, _) = decode_group_envelope(&mut stored).expect("group envelope");
        assert_eq!(envelope["message"]["senderAccountId"], "acct_member");
        assert_eq!(envelope["message"]["senderDisplayName"], "Member");
    }

    fn encoded_envelope() -> String {
        format!(
            "{CLOUD_GROUP_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(br#"{"kind":"group-message","message":{"text":"x"}}"#)
        )
    }

    #[test]
    fn group_envelopes_are_accepted_only_at_the_start_of_the_first_text_block() {
        let envelope = encoded_envelope();
        assert!(!carries_group_envelope(
            &json!({ "blocks": [{ "type": "text", "text": "hello" }] })
        )
        .unwrap());
        assert!(!carries_group_envelope(&json!({ "blocks": [] })).unwrap());
        assert!(carries_group_envelope(
            &json!({ "blocks": [{ "type": "text", "text": envelope }] })
        )
        .unwrap());
        assert!(carries_group_envelope(&json!({ "blocks": [
            { "type": "text", "text": envelope },
            { "type": "voice", "mediaId": "audio" }
        ] }))
        .unwrap());
        let (head, tail) = envelope.split_at(8);
        for rejected in [
            json!({ "blocks": [{ "type": "text", "text": format!(" {envelope}") }] }),
            json!({ "blocks": [{ "type": "text", "text": "" }, { "type": "text", "text": envelope }] }),
            json!({ "blocks": [{ "type": "image", "text": envelope }] }),
            json!({ "blocks": [{ "type": "text", "text": head }, { "type": "text", "text": tail }] }),
            json!({ "blocks": [{ "type": "text", "text": envelope }, { "type": "text", "text": "tail" }] }),
        ] {
            assert!(
                matches!(
                    carries_group_envelope(&rejected),
                    Err(StoreError::InvalidInput(_))
                ),
                "{rejected}"
            );
        }
    }

    #[test]
    fn group_envelopes_must_decode_strictly_to_an_object() {
        assert!(decode_group_envelope_strict(&encoded_envelope()).is_ok());
        let padded = format!(
            "{CLOUD_GROUP_PREFIX}{}",
            // Sixteen bytes always encode with trailing padding.
            base64::engine::general_purpose::STANDARD.encode(br#"{"kind":"group"}"#)
        );
        for rejected in [
            padded,
            format!("{}\n", encoded_envelope()),
            format!("{CLOUD_GROUP_PREFIX}{}", URL_SAFE_NO_PAD.encode(b"[]")),
            format!("{CLOUD_GROUP_PREFIX}not json"),
        ] {
            assert!(
                matches!(
                    decode_group_envelope_strict(&rejected),
                    Err(StoreError::InvalidInput(_))
                ),
                "{rejected}"
            );
        }
    }

    #[test]
    fn legacy_default_agent_aliases_belong_to_the_sender() {
        for alias in [
            "cloud-agent:acct_owner",
            "cloud-local-agent",
            "cloud-self:acct_owner",
        ] {
            assert!(is_default_agent_alias(alias, "acct_owner"), "{alias}");
        }
        assert!(!is_default_agent_alias(
            "cloud-agent:acct_other",
            "acct_owner"
        ));
        assert!(!is_default_agent_alias(
            "cloud-self:acct_other",
            "acct_owner"
        ));
        assert!(!is_default_agent_alias(
            "cloud_agent_research",
            "acct_owner"
        ));
    }
}
