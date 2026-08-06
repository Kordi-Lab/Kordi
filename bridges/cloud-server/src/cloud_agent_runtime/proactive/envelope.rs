use std::collections::HashSet;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Participant {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "agentIds", default)]
    pub agent_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Message {
    pub id: String,
    #[serde(rename = "senderAccountId")]
    pub sender_account_id: String,
    pub text: String,
    #[serde(rename = "senderKind")]
    pub sender_kind: Option<String>,
    #[serde(rename = "senderDisplayName")]
    pub sender_display_name: Option<String>,
    #[serde(rename = "deliveryState")]
    pub delivery_state: Option<String>,
    #[serde(rename = "forkSnapshot")]
    pub fork_snapshot: Option<bool>,
    #[serde(rename = "messageAction")]
    pub message_action: Option<serde_json::Value>,
    #[serde(rename = "targetCloudAgentId")]
    pub target_cloud_agent_id: Option<String>,
    #[serde(rename = "targetCloudAgentOwnerAccountId")]
    pub target_cloud_agent_owner_account_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Envelope {
    pub kind: String,
    #[serde(rename = "groupId")]
    pub group_id: String,
    pub actor: Participant,
    pub participants: Vec<Participant>,
    pub message: Option<Message>,
}

pub(super) fn parse(body: &str) -> Option<Envelope> {
    let encoded = body.trim().strip_prefix(CLOUD_GROUP_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(super) fn normalized_agent_id(value: &str) -> String {
    value
        .trim()
        .strip_prefix("cloud-agent:")
        .unwrap_or(value.trim())
        .to_string()
}

fn action_allows_context(message_action: Option<&serde_json::Value>) -> bool {
    message_action
        .and_then(|action| action.get("kind"))
        .and_then(serde_json::Value::as_str)
        != Some("forward")
}

pub(super) fn is_history_message(envelope: &Envelope) -> bool {
    let Some(message) = envelope.message.as_ref() else {
        return false;
    };
    envelope.kind == "group-message"
        && !message.id.trim().is_empty()
        && matches!(message.sender_kind.as_deref(), Some("human" | "agent"))
        && message.delivery_state.as_deref() != Some("processing")
        && message.delivery_state.as_deref() != Some("failed")
        && message.delivery_state.as_deref() != Some("cancelled")
        && message.fork_snapshot != Some(true)
        && action_allows_context(message.message_action.as_ref())
        && !message.text.trim().is_empty()
}

pub(super) fn is_committed_human_message(envelope: &Envelope) -> bool {
    is_history_message(envelope)
        && envelope
            .message
            .as_ref()
            .is_some_and(|message| message.sender_kind.as_deref() == Some("human"))
}

pub(super) fn is_context_trigger(envelope: &Envelope) -> bool {
    if !is_committed_human_message(envelope) {
        return false;
    }
    let Some(message) = envelope.message.as_ref() else {
        return false;
    };
    message.target_cloud_agent_id.is_none()
        && message.target_cloud_agent_owner_account_id.is_none()
        && !message.text.contains('@')
}

pub(super) fn is_human_message(envelope: &Envelope, sender_account_id: &str) -> bool {
    let Some(message) = envelope.message.as_ref() else {
        return false;
    };
    is_context_trigger(envelope)
        && envelope.actor.account_id.trim() == sender_account_id.trim()
        && message.sender_account_id.trim() == sender_account_id.trim()
}

pub(super) fn contains_agent(
    participants: &[Participant],
    owner_account_id: &str,
    agent_id: &str,
) -> bool {
    participants.iter().any(|participant| {
        participant.account_id.trim() == owner_account_id.trim()
            && participant
                .agent_ids
                .iter()
                .any(|candidate| normalized_agent_id(candidate) == normalized_agent_id(agent_id))
    })
}

pub(super) async fn history(
    pool: &PgPool,
    session_id: &str,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<Vec<Message>, sqlx_core::Error> {
    let rows = query_as::<_, (String,)>(
        "SELECT body FROM cloud_messages
         WHERE session_id = $1
         ORDER BY created_at DESC, message_id DESC
         LIMIT 160",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let mut seen = HashSet::new();
    let mut messages = rows
        .into_iter()
        .filter_map(|(body,)| {
            let envelope = parse(&body)?;
            if !is_history_message(&envelope)
                || !contains_agent(&envelope.participants, owner_account_id, agent_id)
            {
                return None;
            }
            envelope.message
        })
        .filter(|message| seen.insert(message.id.clone()))
        .collect::<Vec<_>>();
    messages.truncate(24);
    messages.reverse();
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(text: &str, sender_kind: Option<&str>, fork_snapshot: Option<bool>) -> Envelope {
        let participant = Participant {
            account_id: "acct_human".to_string(),
            agent_ids: vec!["cloud_agent_one".to_string()],
        };
        Envelope {
            kind: "group-message".to_string(),
            group_id: "session:group:test".to_string(),
            actor: participant.clone(),
            participants: vec![participant],
            message: Some(Message {
                id: "msg_1".to_string(),
                sender_account_id: "acct_human".to_string(),
                text: text.to_string(),
                sender_kind: sender_kind.map(ToString::to_string),
                sender_display_name: Some("Human".to_string()),
                delivery_state: Some("complete".to_string()),
                fork_snapshot,
                message_action: None,
                target_cloud_agent_id: None,
                target_cloud_agent_owner_account_id: None,
            }),
        }
    }

    #[test]
    fn trigger_ignores_mentions_agents_delivery_events_and_fork_snapshots() {
        assert!(is_human_message(
            &envelope("We are stuck on the owner.", Some("human"), None),
            "acct_human",
        ));
        for candidate in [
            envelope("@Kordi help", Some("human"), None),
            envelope("Automated reply", Some("agent"), None),
            envelope("Snapshot", Some("human"), Some(true)),
            envelope("Unknown sender", None, None),
        ] {
            assert!(!is_human_message(&candidate, "acct_human"));
        }
    }

    #[test]
    fn settled_agent_messages_are_context_but_not_triggers() {
        let candidate = envelope("I already answered the question.", Some("agent"), None);
        assert!(is_history_message(&candidate));
        assert!(!is_context_trigger(&candidate));
    }
}
