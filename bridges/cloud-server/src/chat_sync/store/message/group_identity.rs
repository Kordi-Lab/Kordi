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
    validate_envelope_placement, CLOUD_GROUP_PREFIX, INVALID_GROUP_ENVELOPE,
};
use super::group_sender::{bind_group_message_sender, default_agent_id, SENDER_MISMATCH};
use super::{load_message, normalize_title, MessageSnapshot};

pub(super) type ParticipantProfile = (DateTime<Utc>, Option<String>, String);

pub(super) struct GroupEnvelopeProjection {
    pub kind: String,
    pub group_space_id: String,
    pub group_title: Option<String>,
    pub session_title: Option<String>,
    pub group_avatar: Option<Value>,
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
        "group-title-update" | "session-title-update" | "group-avatar-update"
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

fn normalized_group_space_id(value: &str) -> &str {
    let mut normalized = value.trim();
    while let Some(value) = normalized.strip_prefix("group:") {
        normalized = value;
    }
    normalized
}

pub(super) fn group_text_mut(content: &mut Value) -> Option<&mut Value> {
    content
        .get_mut("blocks")?
        .as_array_mut()?
        .iter_mut()
        .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))?
        .get_mut("text")
}

pub(super) fn decode_group_envelope(content: &mut Value) -> Option<(Value, &mut Value)> {
    let text = group_text_mut(content)?;
    let encoded = text.as_str()?.strip_prefix(CLOUD_GROUP_PREFIX)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let envelope = serde_json::from_slice(&decoded).ok()?;
    Some((envelope, text))
}

pub(super) fn set_group_avatar(
    content: &mut Value,
    avatar: Option<Value>,
) -> Result<(), StoreError> {
    let Some((mut envelope, text)) = decode_group_envelope(content) else {
        return Ok(());
    };
    if let Some(object) = envelope.as_object_mut() {
        object.remove("groupAvatar");
        if let Some(avatar) = avatar {
            object.insert("groupAvatar".to_string(), avatar);
        }
    }
    *text = Value::String(encode_group_envelope(&envelope)?);
    Ok(())
}

pub(super) fn encode_group_envelope(envelope: &Value) -> Result<String, StoreError> {
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
            group_avatar: envelope
                .get("groupAvatar")
                .cloned()
                .filter(|value| !value.is_null()),
        }),
    )
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
}
