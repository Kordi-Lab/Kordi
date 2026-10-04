//! One labeling of stored speakers for every run-bound history path.

use std::collections::{HashMap, HashSet};

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::envelopes::{
    cloud_agent_response_text, direct_message_envelope, parse_cloud_group_envelope,
};
use super::RunResult;

/// Display names for stored senders and their agents, read from server
/// records so retrieved history never trusts envelope presentation fields.
#[derive(Default)]
pub(super) struct SpeakerDirectory {
    pub(super) accounts: HashMap<String, (Option<String>, Option<String>)>,
    pub(super) agents: HashMap<(String, String), String>,
}

impl SpeakerDirectory {
    /// Loads names for `(stored sender, body)` rows.
    pub(super) async fn load<'a>(
        pool: &PgPool,
        rows: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> RunResult<Self> {
        let mut senders = HashSet::new();
        let mut agent_ids = HashSet::new();
        for (sender, body) in rows {
            senders.insert(sender.to_string());
            if let Some(agent) = parse_cloud_group_envelope(body)
                .and_then(|envelope| envelope.message?.sender_agent_id)
            {
                agent_ids.insert(agent);
            }
        }
        let senders = senders.into_iter().collect::<Vec<_>>();
        let agent_ids = agent_ids.into_iter().collect::<Vec<_>>();
        let accounts: Vec<(String, Option<String>, Option<String>)> = query_as(
            "SELECT account.account_id, account.display_name, agent.display_name \
             FROM cloud_accounts account \
             LEFT JOIN cloud_default_agent_profiles agent \
               ON agent.owner_account_id = account.account_id \
             WHERE account.account_id = ANY($1)",
        )
        .bind(&senders)
        .fetch_all(pool)
        .await?;
        let agents: Vec<(String, String, String)> = if agent_ids.is_empty() {
            Vec::new()
        } else {
            query_as(
                "SELECT owner_account_id, agent_id, name FROM cloud_agent_definitions \
                 WHERE owner_account_id = ANY($1) AND agent_id = ANY($2)",
            )
            .bind(&senders)
            .bind(&agent_ids)
            .fetch_all(pool)
            .await?
        };
        Ok(Self {
            accounts: accounts
                .into_iter()
                .map(|(account_id, name, agent_name)| (account_id, (name, agent_name)))
                .collect(),
            agents: agents
                .into_iter()
                .map(|(owner, agent_id, name)| ((owner, agent_id), name))
                .collect(),
        })
    }

    pub(super) fn human(&self, account_id: &str) -> String {
        self.accounts
            .get(account_id)
            .and_then(|(name, _)| name.as_deref())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(account_id)
            .to_string()
    }

    /// Returns the agent label only when the agent belongs to the stored sender.
    pub(super) fn agent(&self, account_id: &str, agent_id: Option<&str>) -> Option<String> {
        let agent_id = agent_id.map(str::trim).filter(|value| !value.is_empty());
        let default_agent = agent_id.is_none_or(|agent_id| {
            agent_id == format!("cloud-agent:{account_id}")
                || agent_id == "cloud-local-agent"
                || agent_id == format!("cloud-self:{account_id}")
        });
        let name = if default_agent {
            self.accounts
                .get(account_id)
                .and_then(|(_, agent_name)| agent_name.clone())
                .unwrap_or_else(|| "Kordi".to_string())
        } else {
            self.agents
                .get(&(account_id.to_string(), agent_id?.to_string()))?
                .clone()
        };
        Some(format!("{name} (agent of {})", self.human(account_id)))
    }
}

/// Labels a retrieved message from its stored sender. An envelope can mark an
/// agent message only for an agent owned by that same stored sender.
/// Returns `(label, "human" | "agent", text)`.
pub(super) fn visible_message(
    speakers: &SpeakerDirectory,
    sender: &str,
    body: &str,
) -> Option<(String, String, String)> {
    if let Some(envelope) = parse_cloud_group_envelope(body) {
        let message = envelope.message?;
        if message.delivery_state.as_deref() == Some("processing") {
            return None;
        }
        let agent = (message.sender_kind.as_deref() == Some("agent")
            && message.sender_account_id == sender)
            .then(|| speakers.agent(sender, message.sender_agent_id.as_deref()))
            .flatten();
        return Some(match agent {
            Some(label) => (label, "agent".to_string(), message.text),
            None => (speakers.human(sender), "human".to_string(), message.text),
        });
    }
    if let Some(text) = cloud_agent_response_text(body) {
        let label = speakers
            .agent(sender, None)
            .unwrap_or_else(|| speakers.human(sender));
        return Some((label, "agent".to_string(), text));
    }
    if let Some(envelope) = direct_message_envelope(body) {
        return Some((
            speakers.human(sender),
            "human".to_string(),
            envelope["text"].as_str()?.to_string(),
        ));
    }
    // Unknown encoded control payloads are not conversation evidence.
    if body.starts_with("kordi-") {
        return None;
    }
    Some((
        speakers.human(sender),
        "human".to_string(),
        body.to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use serde_json::{json, Value};

    fn speakers() -> SpeakerDirectory {
        SpeakerDirectory {
            accounts: HashMap::from([
                (
                    "sender".to_string(),
                    (Some("Sender".to_string()), Some("Sender Kordi".to_string())),
                ),
                (
                    "owner".to_string(),
                    (Some("Owner".to_string()), Some("Owner Kordi".to_string())),
                ),
            ]),
            agents: HashMap::from([(
                ("owner".to_string(), "cloud_agent_research".to_string()),
                "Research".to_string(),
            )]),
        }
    }

    fn group_body(message: Value) -> String {
        let envelope = json!({
            "kind": "group-message", "groupId": "group-a", "groupTitle": null,
            "createdByAccountId": "owner", "actor": {"accountId": "owner", "displayName": "Owner"},
            "participants": [{"accountId": "unrelated", "displayName": "Unrelated Member"}],
            "message": message
        });
        format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        )
    }

    #[test]
    fn retrieval_exposes_message_text_without_control_payloads_or_the_roster() {
        let speakers = speakers();
        assert!(visible_message(&speakers, "sender", "kordi-private-control:payload").is_none());
        let mut message = json!({"id": "message-a", "senderAccountId": "sender",
            "senderDisplayName": "Sender", "senderKind": "human", "text": "Relevant evidence",
            "createdAtMs": 1});
        assert_eq!(
            visible_message(&speakers, "sender", &group_body(message.clone())),
            Some((
                "Sender".to_string(),
                "human".to_string(),
                "Relevant evidence".to_string()
            ))
        );
        message["deliveryState"] = json!("processing");
        assert!(visible_message(&speakers, "sender", &group_body(message)).is_none());
    }

    #[test]
    fn retrieval_labels_speakers_from_the_stored_sender() {
        let speakers = speakers();
        // An envelope stored from "sender" that names the owner's agent.
        let names_owner_agent = group_body(json!({"id": "m1", "senderAccountId": "owner",
            "senderKind": "agent", "senderAgentId": "cloud_agent_research",
            "senderDisplayName": "Owner", "text": "hello", "createdAtMs": 1}));
        assert_eq!(
            visible_message(&speakers, "sender", &names_owner_agent),
            Some((
                "Sender".to_string(),
                "human".to_string(),
                "hello".to_string()
            ))
        );
        // An envelope naming a custom agent that the stored sender does not own.
        let unowned_agent = group_body(json!({"id": "m2", "senderAccountId": "sender",
            "senderKind": "agent", "senderAgentId": "cloud_agent_research",
            "senderDisplayName": "Research", "text": "hi", "createdAtMs": 1}));
        assert_eq!(
            visible_message(&speakers, "sender", &unowned_agent),
            Some(("Sender".to_string(), "human".to_string(), "hi".to_string()))
        );
        let owned_agent = group_body(json!({"id": "m3", "senderAccountId": "owner",
            "senderKind": "agent", "senderAgentId": "cloud_agent_research",
            "senderDisplayName": "Anything", "text": "done", "createdAtMs": 1}));
        assert_eq!(
            visible_message(&speakers, "owner", &owned_agent),
            Some((
                "Research (agent of Owner)".to_string(),
                "agent".to_string(),
                "done".to_string()
            ))
        );
        let default_agent = group_body(json!({"id": "m4", "senderAccountId": "owner",
            "senderKind": "agent", "text": "ok", "createdAtMs": 1}));
        assert_eq!(
            visible_message(&speakers, "owner", &default_agent),
            Some((
                "Owner Kordi (agent of Owner)".to_string(),
                "agent".to_string(),
                "ok".to_string()
            ))
        );
        assert_eq!(
            visible_message(&speakers, "unknown", "plain"),
            Some((
                "unknown".to_string(),
                "human".to_string(),
                "plain".to_string()
            ))
        );
    }
}
