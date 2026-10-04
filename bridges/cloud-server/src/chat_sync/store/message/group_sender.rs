//! Sender identity for group envelopes: binding the sender of a new message
//! to the signed-in account, and presenting stored messages with an identity
//! the server can vouch for.

use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{Map, Value};
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

use super::super::StoreError;
use super::envelope_placement::{canonicalize_envelope_placement, CLOUD_GROUP_PREFIX};
use super::group_identity::{decode_group_envelope, encode_group_envelope, ParticipantProfile};
use super::MessageSnapshot;

pub(super) const SENDER_MISMATCH: &str = "group message sender must be the signed-in account";
const UNOWNED_SENDER_AGENT: &str = "group message agent must belong to the signed-in account";
/// Agent-only presentation fields. The server derives them for agent senders
/// and removes them from human messages.
const AGENT_SENDER_FIELDS: [&str; 3] = ["senderAgentId", "senderOwnerAccountId", "senderOwnerName"];

pub(super) fn default_agent_id(account_id: &str) -> String {
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
pub(super) async fn bind_group_message_sender(
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
mod tests;
