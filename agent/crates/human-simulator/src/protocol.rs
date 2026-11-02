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

/// Worker-attested delivery evidence, not independent verification by the control API.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DeliveryReceipt {
    pub client_message_id: Uuid,
    pub message_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ActorState {
    pub status: String,
    pub cursor: Option<String>,
    pub history: Vec<Observation>,
    pub memory: String,
    pub pending: Option<PendingSend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_delivery: Option<DeliveryReceipt>,
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
            last_delivery: None,
            wake_at: None,
            initialized: false,
            needs_decision: true,
            failures: 0,
            last_error: None,
        }
    }
}

impl ActorState {
    /// A terminal actor must never imply its unconfirmed send can be dispatched again.
    /// The request may already have been accepted by Kordi before ownership was lost.
    pub fn delivery_status(&self) -> &'static str {
        match (&self.pending, self.status.as_str()) {
            (Some(_), "running") => "pending",
            (Some(_), _) => "indeterminate",
            (None, _) if self.last_delivery.is_some() => "confirmed",
            (None, _) => "none",
        }
    }

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
#[path = "protocol_tests.rs"]
mod tests;
