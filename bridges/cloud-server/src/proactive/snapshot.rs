//! The bounded snapshot one evaluation sees: the owner, the members, the
//! last messages with `isNew` flags, the agent's name and skills, and `now`.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

/// Messages in one snapshot.
pub(super) const SNAPSHOT_MESSAGES: i64 = 20;
/// Characters kept from one message.
pub(super) const MESSAGE_TEXT_LIMIT: usize = 1200;

/// message_id, sequence, sender, sender display name, content, created_at
type MessageRow = (String, i64, String, Option<String>, Value, String);

/// A conversation the sweep picked for one agent.
#[derive(Debug, Clone)]
pub(super) struct Candidate {
    pub agent_id: String,
    pub conversation_id: Uuid,
    pub session_id: String,
    pub latest_sequence: i64,
    pub seen_sequence: i64,
}

/// The agent as an evaluation needs it.
#[derive(Debug, Clone)]
pub(super) struct Agent {
    pub agent_id: String,
    pub owner_account_id: String,
    pub owner_name: String,
    pub name: String,
    pub system_prompt: String,
    pub skills: Value,
    pub model_routing: Value,
}

/// A decoded chat message.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Decoded {
    /// The id runs use for the message: the group envelope's own id when the
    /// message carries one, else the stored message id.
    pub id: Option<String>,
    pub text: String,
    pub from_agent: bool,
    pub mentions_agent: bool,
}

/// What the sweep learns from a snapshot besides the snapshot itself.
pub(super) struct Snapshot {
    pub value: Value,
    /// Texts of new messages from collaborators (not the owner, not agents).
    pub collaborator_texts: Vec<String>,
    pub mentions_agent: bool,
}

/// `@Handle` for a member: the display name without spaces, which is what
/// the clients' mention parsers match.
pub(super) fn handle(display_name: &str) -> String {
    display_name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn normalized(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Whether `text` holds an `@` handle that names the agent, such as `@Scout`
/// or the group handle `@ScoutMina`.
pub(super) fn text_mentions(text: &str, agent_name: &str) -> bool {
    let name = normalized(agent_name);
    if name.is_empty() {
        return false;
    }
    text.split('@').skip(1).any(|tail| {
        let token: String = tail
            .chars()
            .take_while(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))
            .collect();
        normalized(&token).starts_with(&name)
    })
}

fn envelope(text: &str) -> Option<(Value, bool)> {
    for (prefix, group) in [
        ("kordi-cloud-group:", true),
        ("kordi-cloud-message:", false),
        ("kordi-cloud-agent-response:", false),
    ] {
        if let Some(encoded) = text.strip_prefix(prefix) {
            let value = URL_SAFE_NO_PAD
                .decode(encoded.trim_end_matches('='))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .unwrap_or(Value::Null);
            return Some((value, group));
        }
    }
    None
}

fn names_agent(message: &Value, agent_id: &str) -> bool {
    let target = message.get("targetCloudAgentId").and_then(Value::as_str);
    target == Some(agent_id)
        || message
            .get("mentions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .any(|mention| {
                mention
                    .values()
                    .any(|value| value.as_str() == Some(agent_id))
            })
}

/// Decodes one stored message: its text blocks, the envelope id, whether an
/// agent wrote it, and whether it mentions the agent.
pub(super) fn decode(content: &Value, agent_id: &str, agent_name: &str) -> Decoded {
    let mut decoded = Decoded::default();
    let mut texts = Vec::new();
    for block in content
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
    {
        let Some(raw) = block.get("text").and_then(Value::as_str) else {
            continue;
        };
        let text = match envelope(raw) {
            Some((value, group)) => {
                let message = if group { &value["message"] } else { &value };
                if group {
                    decoded.id = decoded
                        .id
                        .take()
                        .or_else(|| message["id"].as_str().map(str::to_string));
                }
                decoded.from_agent |= message["senderKind"].as_str() == Some("agent")
                    || value["kind"].as_str() == Some("agent-response");
                decoded.mentions_agent |= names_agent(message, agent_id);
                message["text"].as_str().unwrap_or_default().to_string()
            }
            None => raw.to_string(),
        };
        if !text.trim().is_empty() {
            texts.push(text);
        }
    }
    let mut text = texts.join(" ");
    if text.chars().count() > MESSAGE_TEXT_LIMIT {
        text = text.chars().take(MESSAGE_TEXT_LIMIT).collect::<String>() + "\u{2026}";
    }
    decoded.mentions_agent |= text_mentions(&text, agent_name);
    decoded.text = text;
    decoded
}

pub(super) async fn load_agent(
    pool: &PgPool,
    agent_id: &str,
) -> Result<Option<Agent>, sqlx_core::Error> {
    let row: Option<(String, Option<String>, String, String, Value, Value)> = query_as(
        "SELECT agent.owner_account_id, owner.display_name, agent.name, agent.system_prompt,
                agent.skills_json, agent.model_routing_json
         FROM cloud_agent_definitions agent
         JOIN cloud_accounts owner ON owner.account_id = agent.owner_account_id
         WHERE agent.agent_id = $1 AND agent.status = 'active'
           AND agent.is_system_managed = FALSE
           AND agent.proactive_json @> '{\"enabled\": true}'::jsonb",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(owner_account_id, owner_name, name, system_prompt, skills, model_routing)| Agent {
            agent_id: agent_id.to_string(),
            owner_account_id,
            owner_name: owner_name.unwrap_or_else(|| "Owner".to_string()),
            name,
            system_prompt,
            skills,
            model_routing,
        },
    ))
}

pub(super) async fn build(
    pool: &PgPool,
    agent: &Agent,
    candidate: &Candidate,
) -> Result<Snapshot, sqlx_core::Error> {
    let (title,): (Option<String>,) = query_as(
        "SELECT COALESCE(group_title, shared_title) FROM cloud_chat_conversations
         WHERE conversation_id = $1",
    )
    .bind(candidate.conversation_id)
    .fetch_one(pool)
    .await?;
    let service = crate::system_account::service_account_ids();
    let members: Vec<(String, Option<String>)> = query_as(
        "SELECT member.account_id, account.display_name
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         WHERE member.conversation_id = $1 AND member.membership_state = 'active'
           AND NOT (member.account_id = ANY($2))
         ORDER BY member.joined_at ASC",
    )
    .bind(candidate.conversation_id)
    .bind(&service)
    .fetch_all(pool)
    .await?;
    let mut rows: Vec<MessageRow> = query_as(
        "SELECT message.message_id::text, message.conversation_sequence,
                message.sender_account_id, account.display_name, message.content,
                message.created_at::text
         FROM cloud_chat_messages message
         JOIN cloud_accounts account ON account.account_id = message.sender_account_id
         WHERE message.conversation_id = $1 AND message.deleted_at IS NULL
           AND message.conversation_sequence <= $2
           AND message.message_kind IN ('text', 'voice')
         ORDER BY message.conversation_sequence DESC
         LIMIT $3",
    )
    .bind(candidate.conversation_id)
    .bind(candidate.latest_sequence)
    .bind(SNAPSHOT_MESSAGES)
    .fetch_all(pool)
    .await?;
    rows.reverse();

    let owner = agent.owner_account_id.as_str();
    let mut collaborator_texts = Vec::new();
    let mut mentions_agent = false;
    let mut speakers = BTreeSet::new();
    let mut messages = Vec::new();
    for (message_id, sequence, sender, sender_name, content, created_at) in rows {
        let decoded = decode(&content, &agent.agent_id, &agent.name);
        let is_new = sequence > candidate.seen_sequence;
        let from_owner = sender == owner;
        let from_service = service.contains(&sender);
        if is_new {
            mentions_agent |= decoded.mentions_agent;
            if !from_owner && !from_service && !decoded.from_agent && !decoded.text.is_empty() {
                collaborator_texts.push(decoded.text.clone());
            }
        }
        if decoded.text.trim().is_empty() {
            continue;
        }
        speakers.insert(sender.clone());
        let sender_name = sender_name.unwrap_or_else(|| "Member".to_string());
        messages.push(json!({
            "messageId": decoded.id.unwrap_or(message_id),
            "sequence": sequence,
            "isNew": is_new,
            "senderId": sender,
            "senderName": sender_name,
            "senderHandle": format!("@{}", handle(&sender_name)),
            "fromOwner": from_owner,
            "fromAgent": decoded.from_agent || from_service,
            "text": decoded.text,
            "createdAt": created_at,
        }));
    }
    let listed = crate::pip::context::pick_members(&members, |member| member.0.as_str(), &speakers);
    let skills: Vec<&str> = agent
        .skills
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|skill| skill.get("name").and_then(Value::as_str))
        .collect();
    Ok(Snapshot {
        value: json!({
            "agent": {"agentId": agent.agent_id, "name": agent.name, "skills": skills},
            "owner": {
                "accountId": owner,
                "name": agent.owner_name,
                "handle": format!("@{}", handle(&agent.owner_name)),
            },
            "conversation": {
                "id": candidate.conversation_id.to_string(),
                "sessionId": candidate.session_id,
                "title": title,
            },
            "memberCount": members.len(),
            "members": listed.into_iter().map(|(account_id, name)| {
                let name = name.clone().unwrap_or_else(|| "Member".to_string());
                json!({
                    "accountId": account_id,
                    "name": name,
                    "handle": format!("@{}", handle(&name)),
                    "isOwner": account_id.as_str() == owner,
                })
            }).collect::<Vec<_>>(),
            "messages": messages,
            "sinceSequence": candidate.seen_sequence,
            "now": Utc::now().to_rfc3339(),
        }),
        collaborator_texts,
        mentions_agent,
    })
}

/// The collaborator message an offer answers: the newest evidence message
/// that a collaborator wrote, else the newest new collaborator message.
pub(super) fn trigger_message<'a>(snapshot: &'a Value, evidence: &[String]) -> Option<&'a Value> {
    let collaborator = |message: &&Value| {
        message["fromOwner"] != json!(true) && message["fromAgent"] != json!(true)
    };
    let messages: Vec<&Value> = snapshot["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(collaborator)
        .collect();
    messages
        .iter()
        .rev()
        .find(|message| {
            message["messageId"]
                .as_str()
                .is_some_and(|id| evidence.iter().any(|e| e == id))
        })
        .or_else(|| {
            messages
                .iter()
                .rev()
                .find(|message| message["isNew"] == json!(true))
        })
        .copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group_text(message: Value) -> String {
        let envelope = json!({"kind": "group-message", "message": message});
        format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        )
    }

    #[test]
    fn group_envelopes_decode_to_their_id_text_and_sender_kind() {
        let content = json!({"blocks": [{"type": "text", "text": group_text(json!({
            "id": "grp_msg_1", "text": "Can someone check the build?", "senderKind": "human"
        }))}]});
        let decoded = decode(&content, "cloud_agent_x", "Scout");
        assert_eq!(decoded.id.as_deref(), Some("grp_msg_1"));
        assert_eq!(decoded.text, "Can someone check the build?");
        assert!(!decoded.from_agent);
        assert!(!decoded.mentions_agent);
        let reply = json!({"blocks": [{"type": "text", "text": group_text(json!({
            "id": "grp_msg_2", "text": "Done.", "senderKind": "agent"
        }))}]});
        assert!(decode(&reply, "cloud_agent_x", "Scout").from_agent);
        let plain = json!({"blocks": [{"type": "text", "text": "plain words"}]});
        assert_eq!(decode(&plain, "a", "Scout").id, None);
    }

    #[test]
    fn mentions_are_structured_or_textual() {
        let targeted = json!({"blocks": [{"type": "text", "text": group_text(json!({
            "id": "m", "text": "please look", "targetCloudAgentId": "cloud_agent_x"
        }))}]});
        assert!(decode(&targeted, "cloud_agent_x", "Scout").mentions_agent);
        let listed = json!({"blocks": [{"type": "text", "text": group_text(json!({
            "id": "m", "text": "hey", "mentions": [{"targetKind": "agent", "agentId": "cloud_agent_x"}]
        }))}]});
        assert!(decode(&listed, "cloud_agent_x", "Scout").mentions_agent);
        assert!(text_mentions("hey @ScoutMina can you", "Scout"));
        assert!(text_mentions("@scout?", "Scout"));
        assert!(!text_mentions("scout@example.com", "Scout"));
        assert!(!text_mentions("@Riya can you", "Scout"));
        assert!(!text_mentions("no handle", "Scout"));
    }

    #[test]
    fn message_text_is_bounded() {
        let long = "y".repeat(MESSAGE_TEXT_LIMIT + 40);
        let content = json!({"blocks": [{"type": "text", "text": long}, {"type": "voice"}]});
        let decoded = decode(&content, "a", "Scout");
        assert_eq!(decoded.text.chars().count(), MESSAGE_TEXT_LIMIT + 1);
        assert!(decoded.text.ends_with('\u{2026}'));
    }

    #[test]
    fn the_trigger_prefers_collaborator_evidence() {
        let snapshot = json!({"messages": [
            {"messageId": "a", "isNew": false, "fromOwner": false, "fromAgent": false},
            {"messageId": "b", "isNew": true, "fromOwner": false, "fromAgent": false},
            {"messageId": "c", "isNew": true, "fromOwner": true, "fromAgent": false},
        ]});
        let pick = |evidence: &[&str]| {
            let evidence: Vec<String> = evidence.iter().map(|e| e.to_string()).collect();
            trigger_message(&snapshot, &evidence).map(|m| m["messageId"].clone())
        };
        assert_eq!(pick(&["a"]), Some(json!("a")));
        assert_eq!(
            pick(&["c"]),
            Some(json!("b")),
            "the owner is never the trigger"
        );
        assert_eq!(pick(&[]), Some(json!("b")));
    }
}
