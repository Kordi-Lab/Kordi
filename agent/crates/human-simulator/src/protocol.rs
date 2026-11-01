use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::config::ActorConfig;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub id: Uuid,
    pub sequence: i64,
    pub sender: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PendingSend {
    pub client_message_id: Uuid,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ActorState {
    pub status: String,
    pub cursor: Option<String>,
    pub history: Vec<Observation>,
    pub memory: String,
    pub pending: Option<PendingSend>,
    pub wake_at: Option<DateTime<Utc>>,
    pub initialized: bool,
    pub needs_decision: bool,
    #[serde(default)]
    pub failures: u32,
    #[serde(default)]
    pub last_error: Option<String>,
}

impl Default for ActorState {
    fn default() -> Self {
        Self {
            status: "running".into(),
            cursor: None,
            history: Vec::new(),
            memory: String::new(),
            pending: None,
            wake_at: None,
            initialized: false,
            needs_decision: true,
            failures: 0,
            last_error: None,
        }
    }
}

impl ActorState {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            matches!(self.status.as_str(), "running" | "finished" | "stopped"),
            "Invalid actor status"
        );
        anyhow::ensure!(
            self.history.len() <= 40 && self.memory.chars().count() <= 8_000,
            "Actor state exceeds limits"
        );
        anyhow::ensure!(
            self.cursor.as_ref().is_none_or(|s| s.len() <= 4096),
            "Invalid cursor"
        );
        anyhow::ensure!(
            self.history
                .iter()
                .all(|m| m.text.chars().count() <= 8_000 && m.sender.len() <= 128),
            "Observation exceeds limits"
        );
        anyhow::ensure!(
            self.pending
                .as_ref()
                .is_none_or(|p| !p.text.trim().is_empty() && p.text.chars().count() <= 8_000),
            "Invalid pending message"
        );
        Ok(())
    }

    /// Apply a durable sync page, including edits/deletes. Ignore other conversations.
    pub fn apply_events(&mut self, config: &ActorConfig, events: &[Value], cursor: String) {
        for event in events {
            if event["conversation_id"].as_str()
                != Some(config.conversation_id.to_string().as_str())
            {
                continue;
            }
            let kind = event["type"].as_str().unwrap_or_default();
            let message = &event["payload"]["message"];
            if kind == "message.deleted" {
                // Canonical v2 message events carry the tombstone in
                // payload.message; accept the older compact form as well.
                if let Some(id) = message["id"]
                    .as_str()
                    .or_else(|| event["payload"]["message_id"].as_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
                    && let Some(index) = self.history.iter().position(|item| item.id == id)
                {
                    let removed = self.history.remove(index);
                    if removed.sender != config.account_id {
                        self.needs_decision = true;
                    }
                }
                continue;
            }
            if !matches!(kind, "message.created" | "message.updated") {
                continue;
            }
            let Some(id) = message["id"].as_str().and_then(|s| Uuid::parse_str(s).ok()) else {
                continue;
            };
            let sender = message["sender_account_id"].as_str().unwrap_or_default();
            // Only committed textual content is a human-visible observation.
            if message["deleted_at"].as_str().is_some() {
                self.history.retain(|m| m.id != id);
                continue;
            }
            if matches!(
                message["generation_status"].as_str(),
                Some("pending" | "running" | "streaming")
            ) {
                continue;
            }
            let text = message_text(&message["content"]);
            if text.trim().is_empty() {
                continue;
            }
            let observation = Observation {
                id,
                sequence: message["conversation_sequence"].as_i64().unwrap_or(0),
                sender: sender.chars().take(128).collect(),
                text,
            };
            if self.history.iter().any(|m| m == &observation) {
                continue;
            }
            self.history.retain(|m| m.id != id);
            self.history.push(observation);
            if sender != config.account_id {
                self.needs_decision = true;
            }
        }
        self.history.sort_by_key(|m| m.sequence);
        if self.history.len() > 40 {
            self.history.drain(..self.history.len() - 40);
        }
        self.cursor = Some(cursor);
        self.initialized = true;
    }
}

pub fn message_text(content: &Value) -> String {
    let text = content["blocks"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_else(|| content["text"].as_str().unwrap_or_default().to_owned());
    text.chars().take(8_000).collect()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ActorView {
    pub config: ActorConfig,
    pub state: ActorState,
    pub revision: i64,
    pub generation: i64,
    pub model_calls: i32,
    pub messages_sent: i32,
    pub kordi_api_base: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseRequest {
    pub owner: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedRequest {
    pub owner: Uuid,
    pub generation: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointRequest {
    pub owner: Uuid,
    pub generation: i64,
    pub revision: i64,
    pub state: ActorState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionRequest {
    pub owner: Uuid,
    pub generation: i64,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfirmRequest {
    pub owner: Uuid,
    pub generation: i64,
    pub revision: i64,
    pub client_message_id: Uuid,
    pub message_id: Uuid,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CONVERSATION_ID: Uuid = Uuid::from_u128(1);
    const OTHER_CONVERSATION_ID: Uuid = Uuid::from_u128(2);
    const ACTOR_ACCOUNT_ID: &str = "account-actor";
    const OTHER_ACCOUNT_ID: &str = "account-other";

    fn config() -> ActorConfig {
        ActorConfig {
            actor_id: "actor_test".into(),
            account_id: ACTOR_ACCOUNT_ID.into(),
            conversation_id: CONVERSATION_ID,
            objective: "Reach the objective".into(),
            persona: "Friendly".into(),
            private_facts: Vec::new(),
            skill: "human-requester@1".into(),
            max_model_calls: 10,
            max_messages: 20,
            poll_seconds: 5,
            max_wait_seconds: 60,
        }
    }

    /// The canonical v2 event envelope emitted by chat_sync::store::message::fanout.
    #[allow(clippy::too_many_arguments)]
    fn v2_message_event(
        conversation_id: Uuid,
        event_type: &str,
        message_id: Uuid,
        sender_account_id: &str,
        sequence: i64,
        text: &str,
        generation_status: Option<&str>,
        deleted_at: Option<&str>,
    ) -> Value {
        json!({
            "stream_seq": sequence,
            "event_id": Uuid::from_u128(sequence as u128 + 100),
            "protocol_version": 2,
            "type": event_type,
            "critical": false,
            "conversation_id": conversation_id,
            "entity_id": message_id,
            "entity_version": 1,
            "occurred_at": "2026-11-01T12:00:00Z",
            "payload": {
                "message": {
                    "id": message_id,
                    "client_message_id": Uuid::from_u128(sequence as u128 + 200),
                    "conversation_id": conversation_id,
                    "conversation_sequence": sequence,
                    "sender_account_id": sender_account_id,
                    "kind": "text",
                    "content": {"schema": 1, "blocks": [{"type":"text", "text":text}]},
                    "reply_to_message_id": null,
                    "attachment_ids": [],
                    "version": 1,
                    "generation_status": generation_status,
                    "provider_response_id": null,
                    "created_at": "2026-11-01T12:00:00Z",
                    "edited_at": null,
                    "deleted_at": deleted_at,
                    "reactions": []
                },
                "conversation": {"id": conversation_id}
            }
        })
    }

    #[test]
    fn consumes_v2_message_payload_and_ignores_other_conversations_and_own_messages() {
        let config = config();
        let own_id = Uuid::from_u128(10);
        let other_id = Uuid::from_u128(11);
        let mut state = ActorState {
            needs_decision: false,
            ..ActorState::default()
        };
        state.apply_events(
            &config,
            &[
                v2_message_event(
                    OTHER_CONVERSATION_ID,
                    "message.created",
                    other_id,
                    OTHER_ACCOUNT_ID,
                    1,
                    "Do not include this other conversation.",
                    None,
                    None,
                ),
                v2_message_event(
                    CONVERSATION_ID,
                    "message.created",
                    own_id,
                    ACTOR_ACCOUNT_ID,
                    2,
                    "My own message.",
                    None,
                    None,
                ),
            ],
            "cursor-after-own-message".into(),
        );

        assert_eq!(state.history.len(), 1);
        assert_eq!(state.history[0].id, own_id);
        assert_eq!(state.history[0].text, "My own message.");
        assert!(
            !state.needs_decision,
            "an actor's own send must not trigger another decision"
        );
        assert_eq!(state.cursor.as_deref(), Some("cursor-after-own-message"));
        assert!(state.initialized);
    }

    #[test]
    fn ignores_streaming_message_updates_until_content_is_committed() {
        let config = config();
        let id = Uuid::from_u128(20);
        let mut state = ActorState {
            needs_decision: false,
            ..ActorState::default()
        };
        state.apply_events(
            &config,
            &[v2_message_event(
                CONVERSATION_ID,
                "message.created",
                id,
                OTHER_ACCOUNT_ID,
                1,
                "Partial generated text.",
                Some("streaming"),
                None,
            )],
            "streaming-cursor".into(),
        );

        assert!(state.history.is_empty());
        assert!(!state.needs_decision);
    }

    #[test]
    fn applies_edits_and_actual_v2_delete_payloads() {
        let config = config();
        let id = Uuid::from_u128(30);
        let mut state = ActorState {
            needs_decision: false,
            ..ActorState::default()
        };
        state.apply_events(
            &config,
            &[v2_message_event(
                CONVERSATION_ID,
                "message.created",
                id,
                OTHER_ACCOUNT_ID,
                1,
                "Original wording.",
                None,
                None,
            )],
            "created".into(),
        );
        assert!(state.needs_decision);

        state.needs_decision = false;
        state.apply_events(
            &config,
            &[v2_message_event(
                CONVERSATION_ID,
                "message.updated",
                id,
                OTHER_ACCOUNT_ID,
                1,
                "Edited wording.",
                None,
                None,
            )],
            "edited".into(),
        );
        assert_eq!(state.history.len(), 1);
        assert_eq!(state.history[0].text, "Edited wording.");
        assert!(state.needs_decision);

        state.needs_decision = false;
        state.apply_events(
            &config,
            &[v2_message_event(
                CONVERSATION_ID,
                "message.deleted",
                id,
                OTHER_ACCOUNT_ID,
                1,
                "",
                None,
                Some("2026-11-01T12:05:00Z"),
            )],
            "deleted".into(),
        );
        assert!(
            state.history.is_empty(),
            "v2 deletion carries message.id inside payload.message"
        );
        assert!(
            state.needs_decision,
            "deleting another participant's message changes observed context"
        );
    }

    #[test]
    fn bounds_history_and_observation_fields() {
        let config = config();
        let events = (1..=45)
            .map(|sequence| {
                v2_message_event(
                    CONVERSATION_ID,
                    "message.created",
                    Uuid::from_u128(sequence as u128 + 1000),
                    OTHER_ACCOUNT_ID,
                    sequence,
                    &"x".repeat(8_100),
                    None,
                    None,
                )
            })
            .collect::<Vec<_>>();
        let mut state = ActorState::default();
        state.apply_events(&config, &events, "bounded".into());

        assert_eq!(state.history.len(), 40);
        assert_eq!(state.history.first().unwrap().sequence, 6);
        assert_eq!(state.history.last().unwrap().sequence, 45);
        assert!(
            state
                .history
                .iter()
                .all(|observation| observation.text.chars().count() == 8_000)
        );
        state.validate().expect("bounded history validates");
    }
}
