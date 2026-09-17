//! The bounded snapshot one PiP run sees: members, recent messages, the open
//! card, and the hooks that woke PiP.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

use crate::plan_cards::store::parse_pg_timestamp;

use super::cards::seen_revision;
use super::config::PipConfig;
use super::context;
use super::mentions::mention_handle;

const MESSAGE_TEXT_LIMIT: usize = 1200;
const CLOUD_MESSAGE_PREFIXES: [&str; 2] = ["kordi-cloud-message:", "kordi-cloud-group:"];

/// message_id, sequence, sender, sender display name, kind, content, created_at
type MessageRow = (String, i64, String, Option<String>, String, Value, String);
/// account_id, display name, role, timezone
type MemberRow = (String, Option<String>, String, Option<String>);

pub(super) struct Candidate {
    pub conversation_id: Uuid,
    pub legacy_session_id: String,
    pub latest_sequence: i64,
    pub seen_sequence: i64,
    pub hooks_fired: Value,
}

fn decode_cloud_text(text: &str) -> String {
    for prefix in CLOUD_MESSAGE_PREFIXES {
        if let Some(encoded) = text.strip_prefix(prefix) {
            let value = URL_SAFE_NO_PAD
                .decode(encoded.trim_end_matches('='))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
            return value
                .as_ref()
                .and_then(|value| {
                    value
                        .get("text")
                        .or_else(|| value.get("message").and_then(|message| message.get("text")))
                })
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
    }
    text.to_string()
}

fn message_text(content: &Value) -> String {
    let mut out = String::new();
    for block in content
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&decode_cloud_text(text));
            }
        }
    }
    if out.chars().count() > MESSAGE_TEXT_LIMIT {
        out = out.chars().take(MESSAGE_TEXT_LIMIT).collect::<String>() + "…";
    }
    out
}

/// Reminder hook for a card starting soon, unless it already went out.
fn reminder_hook(candidate: &Candidate, event_id: &str, start_at: Option<&str>) -> Option<Value> {
    let start = start_at.and_then(parse_pg_timestamp)?;
    let remaining = start.with_timezone(&Utc) - Utc::now();
    let name = if remaining <= chrono::Duration::zero() {
        return None;
    } else if remaining <= chrono::Duration::hours(2) {
        "t_minus_2h"
    } else if remaining <= chrono::Duration::hours(24) {
        "t_minus_24h"
    } else {
        return None;
    };
    let key = format!("{name}:{event_id}");
    (candidate.hooks_fired.get(&key).is_none())
        .then(|| json!({"name": name, "key": key, "eventId": event_id}))
}

pub(super) async fn build_input(
    pool: &PgPool,
    config: &PipConfig,
    candidate: &Candidate,
) -> Result<Value, sqlx_core::Error> {
    let conversation: Option<(String, Option<String>, Option<String>)> = query_as(
        "SELECT kind, shared_title, group_title FROM cloud_chat_conversations
         WHERE conversation_id = $1",
    )
    .bind(candidate.conversation_id)
    .fetch_optional(pool)
    .await?;
    let (kind, shared_title, group_title) = conversation.unwrap_or_default();

    let members: Vec<MemberRow> = query_as(
        "SELECT member.account_id, account.display_name, member.role, digest.timezone
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         LEFT JOIN cloud_account_digests digest ON digest.account_id = member.account_id
         WHERE member.conversation_id = $1 AND member.membership_state = 'active'
         ORDER BY member.joined_at ASC",
    )
    .bind(candidate.conversation_id)
    .fetch_all(pool)
    .await?;

    let rows: Vec<MessageRow> = query_as(
        "SELECT message.message_id::text, message.conversation_sequence, message.sender_account_id,
                account.display_name, message.message_kind, message.content,
                message.created_at::text
         FROM cloud_chat_messages message
         JOIN cloud_accounts account ON account.account_id = message.sender_account_id
         WHERE message.conversation_id = $1 AND message.deleted_at IS NULL
           AND message.message_kind IN ('text', 'voice')
         ORDER BY message.conversation_sequence DESC
         LIMIT $2",
    )
    .bind(candidate.conversation_id)
    .bind(context::CONTEXT_MESSAGE_FETCH)
    .fetch_all(pool)
    .await?;
    let messages = context::budget_messages(
        rows.into_iter()
            .map(
                |(id, sequence, sender, display_name, kind, content, created_at)| {
                    context::ContextMessage {
                        id,
                        sequence,
                        sender_id: sender,
                        sender_name: display_name.unwrap_or_else(|| "Member".to_string()),
                        kind,
                        text: message_text(&content),
                        created_at,
                    }
                },
            )
            .collect(),
        candidate.seen_sequence,
        &config.account_id,
    );

    // The card PiP manages: the most recently changed one that is not canceled.
    // The sweep's card and reminder conditions look at this same card.
    let open_event: Option<(String,)> = query_as(
        "SELECT event_id FROM cloud_plan_cards
         WHERE conversation_id = $1 AND state <> 'canceled'
         ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(candidate.conversation_id)
    .fetch_optional(pool)
    .await?;
    let card = match open_event {
        Some((event_id,)) => crate::plan_cards::store::load(pool, &event_id).await?,
        None => None,
    };

    let mut hooks: Vec<Value> = Vec::new();
    // PiP's own messages are never news to PiP.
    if messages
        .iter()
        .any(|message| message["isNew"] == json!(true) && message["fromPip"] != json!(true))
    {
        hooks.push(json!({
            "name": "new_messages",
            "sinceSequence": candidate.seen_sequence,
        }));
    }
    let mut open_card = Value::Null;
    let mut featured: BTreeSet<String> = messages
        .iter()
        .filter_map(|message| message["senderId"].as_str().map(str::to_string))
        .collect();
    let mut organizer_account_id: Option<String> = None;
    if let Some(row) = card {
        if row.revision > seen_revision(&candidate.hooks_fired, &row.event_id) {
            hooks.push(json!({
                "name": "card_changed",
                "eventId": row.event_id,
                "revision": row.revision,
                "detail": "Members responded or voted on the card since your last look.",
            }));
        }
        hooks.extend(reminder_hook(
            candidate,
            &row.event_id,
            row.start_at.as_deref(),
        ));
        organizer_account_id = row
            .participants
            .iter()
            .find(|participant| participant.organizer)
            .map(|participant| participant.account_id.clone());
        open_card = context::compact_card(&row);
        if let Some(listed) = open_card["participants"].as_array() {
            featured.extend(listed.iter().filter_map(|participant| {
                participant["participantId"].as_str().map(str::to_string)
            }));
        }
    }

    // Prefer the open card's organizer's timezone, since that's whose "now"
    // the plan is really being scheduled around; fall back to whichever
    // member happens to have one on file.
    let timezone_of = |account_id: &str| {
        members
            .iter()
            .find(|member| member.0 == account_id)
            .and_then(|member| member.3.clone())
    };
    let organizer_timezone = organizer_account_id
        .and_then(|account_id| timezone_of(&account_id))
        .or_else(|| members.iter().find_map(|member| member.3.clone()));

    let listed_members = context::pick_members(&members, |member| member.0.as_str(), &featured);
    Ok(json!({
        "pip": {"accountId": config.account_id, "name": config.name},
        "conversation": {
            "id": candidate.conversation_id.to_string(),
            "kind": kind,
            "title": group_title.or(shared_title),
        },
        "memberCount": members.len(),
        "members": listed_members.into_iter().map(|(account_id, display_name, role, timezone)| {
            let display_name = display_name.clone().unwrap_or_else(|| "Member".to_string());
            json!({
                "participantId": account_id,
                "displayName": display_name,
                "handle": format!("@{}", mention_handle(&display_name)),
                "role": role,
                "isPip": *account_id == config.account_id,
                "timezone": timezone,
            })
        }).collect::<Vec<_>>(),
        "organizerTimezone": organizer_timezone,
        "openCard": open_card,
        "messages": messages,
        "hooks": hooks,
        "now": Utc::now().to_rfc3339(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pip::mentions::encode_pip_message_with_mentions;

    fn candidate(hooks_fired: Value) -> Candidate {
        Candidate {
            conversation_id: Uuid::nil(),
            legacy_session_id: String::new(),
            latest_sequence: 0,
            seen_sequence: 0,
            hooks_fired,
        }
    }

    #[test]
    fn cloud_envelopes_decode_to_their_text() {
        let encoded = encode_pip_message_with_mentions("Ramen at 12:30 works", Vec::new());
        assert_eq!(decode_cloud_text(&encoded), "Ramen at 12:30 works");
        assert_eq!(decode_cloud_text("plain"), "plain");
        assert_eq!(decode_cloud_text("kordi-cloud-message:!!notbase64"), "");
    }

    #[test]
    fn message_text_joins_text_blocks_and_bounds_length() {
        let long = "x".repeat(MESSAGE_TEXT_LIMIT + 50);
        let content = json!({"blocks": [{"type": "text", "text": "a"}, {"type": "voice"}, {"type": "text", "text": long}]});
        let text = message_text(&content);
        assert!(text.starts_with("a x"));
        assert!(text.ends_with('…'));
        assert!(text.chars().count() <= MESSAGE_TEXT_LIMIT + 3);
    }

    #[test]
    fn reminders_pick_one_window_and_fire_once() {
        let soon = (Utc::now() + chrono::Duration::minutes(90)).to_rfc3339();
        let tomorrow = (Utc::now() + chrono::Duration::hours(20)).to_rfc3339();
        let fresh = candidate(json!({}));
        assert_eq!(
            reminder_hook(&fresh, "e1", Some(&soon)).unwrap()["name"],
            "t_minus_2h"
        );
        assert_eq!(
            reminder_hook(&fresh, "e1", Some(&tomorrow)).unwrap()["name"],
            "t_minus_24h"
        );
        let fired = candidate(json!({"t_minus_2h:e1": true}));
        assert!(reminder_hook(&fired, "e1", Some(&soon)).is_none());
        assert!(reminder_hook(&fresh, "e1", Some("2020-01-01T00:00:00Z")).is_none());
    }
}
