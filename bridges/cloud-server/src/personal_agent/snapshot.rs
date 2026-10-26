//! The bounded snapshot one evaluation sees: the owner, the agent, `now`, the
//! new events, the agent's recent messages, and the end of the personal chat.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

/// New events one evaluation takes, the oldest first; the rest wait for
/// the next one.
pub(super) const SNAPSHOT_EVENTS: i64 = 50;
/// An event that happened longer ago than this, or before the setting was
/// turned on, is skipped without an evaluation: a new connector's first poll
/// stores old mail and calendar changes.
pub(super) const MAX_EVENT_AGE_HOURS: i32 = 6;
/// Events received this recently wait for the next sweep, so an insert that
/// is still committing with an earlier `received_at` is never skipped.
pub(super) const SETTLE_SECONDS: i64 = 5;
/// Event kinds with nothing to tell: a Gmail push only says that the mailbox
/// changed, and the poll it starts stores the messages.
pub(super) const IGNORED_KINDS: &[&str] = &["mailbox.changed"];
const RECENT_SHARES: i64 = 30;
const RECENT_CHAT: i64 = 10;
const CHAT_TEXT_LIMIT: usize = 600;
/// A larger event summary is replaced by a marker, as in the digest.
const MAX_SUMMARY_BYTES: usize = 2000;

/// The agent as an evaluation needs it.
#[derive(Debug, Clone)]
pub(super) struct Agent {
    pub agent_id: String,
    pub owner_account_id: String,
    pub owner_name: String,
    pub owner_handle: String,
    pub name: String,
    pub system_prompt: String,
    pub model_routing: Value,
}

/// One new connector event.
#[derive(Debug, Clone)]
pub(super) struct Event {
    pub event_id: String,
    pub provider: String,
    pub kind: String,
    pub occurred_at: DateTime<Utc>,
    pub received_at: DateTime<Utc>,
    pub payload: Value,
    /// It happened before the setting was turned on or more than
    /// [`MAX_EVENT_AGE_HOURS`] ago: it moves the cursor but is not shown.
    pub stale: bool,
}

/// The newest event an agent has looked at: (`received_at`, `event_id`).
/// Events at one `received_at` are ordered by id, so a batch can end
/// between them.
pub(super) type Cursor = (DateTime<Utc>, String);

impl Event {
    fn to_value(&self) -> Value {
        let summary = if self.payload.to_string().len() > MAX_SUMMARY_BYTES {
            json!({"truncated": true})
        } else {
            self.payload.clone()
        };
        json!({
            "eventId": self.event_id,
            "provider": self.provider,
            "kind": self.kind,
            "occurredAt": self.occurred_at.to_rfc3339(),
            "title": super::sources::title(&self.provider, &self.kind, &self.payload),
            "summary": summary,
        })
    }
}

fn handle(public_handle: Option<String>, name: &str) -> String {
    let handle = public_handle
        .map(|handle| handle.trim().trim_start_matches('@').to_string())
        .filter(|handle| !handle.is_empty())
        .unwrap_or_else(|| crate::proactive::snapshot::handle(name));
    format!("@{handle}")
}

/// event_id, provider, kind, occurred_at, received_at, payload, stale
type EventRow = (
    String,
    String,
    String,
    DateTime<Utc>,
    DateTime<Utc>,
    Value,
    bool,
);

type AgentRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    Value,
);

/// The agent while its Proactive setting is on and it is active: a
/// definition, or the owner's default agent with no persona and the owner's
/// default route.
pub(super) async fn load_agent(
    pool: &PgPool,
    agent_id: &str,
) -> Result<Option<Agent>, sqlx_core::Error> {
    let row: Option<AgentRow> = match crate::proactive::agents::default_owner(agent_id) {
        Some(owner) => {
            query_as(concat!(
                "SELECT account.account_id, account.display_name, account.public_handle, ",
                crate::proactive::agents::default_name_sql!("account", "profile"),
                ", '', 'null'::jsonb
                 FROM cloud_personal_agent_settings setting
                 JOIN cloud_accounts account ON account.account_id = setting.owner_account_id
                 LEFT JOIN cloud_default_agent_profiles profile
                   ON profile.owner_account_id = account.account_id
                 WHERE setting.agent_id = $1 AND setting.owner_account_id = $2
                   AND setting.proactive"
            ))
            .bind(agent_id)
            .bind(owner)
            .fetch_optional(pool)
            .await?
        }
        None => {
            query_as(
                "SELECT agent.owner_account_id, owner.display_name, owner.public_handle,
                        agent.name, agent.system_prompt, agent.model_routing_json
                 FROM cloud_agent_definitions agent
                 JOIN cloud_personal_agent_settings setting
                   ON setting.agent_id = agent.agent_id
                  AND setting.owner_account_id = agent.owner_account_id AND setting.proactive
                 JOIN cloud_accounts owner ON owner.account_id = agent.owner_account_id
                 WHERE agent.agent_id = $1 AND agent.status = 'active'
                   AND agent.is_system_managed = FALSE",
            )
            .bind(agent_id)
            .fetch_optional(pool)
            .await?
        }
    };
    Ok(row.map(
        |(owner_account_id, owner_name, public_handle, name, system_prompt, model_routing)| {
            let owner_name = owner_name.unwrap_or_else(|| "Owner".to_string());
            Agent {
                agent_id: agent_id.to_string(),
                owner_account_id,
                owner_handle: handle(public_handle, &owner_name),
                owner_name,
                name,
                system_prompt,
                model_routing,
            }
        },
    ))
}

/// The events from connectors granted to the agent that the server received
/// after `cursor`, the oldest first and at most [`SNAPSHOT_EVENTS`], each
/// marked `stale` against `enabled_at`. Revoked connectors, expired events,
/// content-free kinds, and events received in the last [`SETTLE_SECONDS`]
/// are left out.
pub(super) async fn new_events(
    pool: &PgPool,
    agent: &Agent,
    cursor: &Cursor,
    enabled_at: DateTime<Utc>,
) -> Result<Vec<Event>, sqlx_core::Error> {
    let rows: Vec<EventRow> = query_as(
        "SELECT e.event_id, e.provider, e.kind, e.occurred_at, e.received_at, e.payload,
                e.occurred_at < GREATEST($7, now() - make_interval(hours => $8))
         FROM cloud_connector_events e
         JOIN cloud_connectors c ON c.connector_id = e.connector_id
         JOIN cloud_connector_agent_grants g
           ON g.connector_id = c.connector_id AND g.agent_id = $2
         WHERE c.account_id = $1 AND c.status <> 'revoked'
           AND e.received_at >= $3 AND (e.received_at, e.event_id) > ($3, $9)
           AND e.received_at <= now() - make_interval(secs => $4)
           AND e.expires_at > now() AND NOT (e.kind = ANY($5))
         ORDER BY e.received_at ASC, e.event_id ASC LIMIT $6",
    )
    .bind(&agent.owner_account_id)
    .bind(&agent.agent_id)
    .bind(cursor.0)
    .bind(SETTLE_SECONDS as f64)
    .bind(IGNORED_KINDS)
    .bind(SNAPSHOT_EVENTS)
    .bind(enabled_at)
    .bind(MAX_EVENT_AGE_HOURS)
    .bind(&cursor.1)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(event_id, provider, kind, occurred_at, received_at, payload, stale)| Event {
                event_id,
                provider,
                kind,
                occurred_at,
                received_at,
                payload,
                stale,
            },
        )
        .collect())
}

fn cut(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let cut: String = text.chars().take(limit).collect();
    format!("{cut}\u{2026}")
}

/// The snapshot for `events`, which must be non-empty and newest first.
pub(super) async fn build(
    pool: &PgPool,
    agent: &Agent,
    conversation_id: Uuid,
    events: &[Event],
) -> Result<Value, sqlx_core::Error> {
    let shares: Vec<(DateTime<Utc>, String)> = query_as(
        "SELECT created_at, text FROM cloud_personal_agent_messages
         WHERE agent_id = $1 AND owner_account_id = $2 AND created_at > now() - interval '7 days'
         ORDER BY created_at DESC LIMIT $3",
    )
    .bind(&agent.agent_id)
    .bind(&agent.owner_account_id)
    .bind(RECENT_SHARES)
    .fetch_all(pool)
    .await?;
    let mut chat: Vec<(Value, DateTime<Utc>)> = query_as(
        "SELECT content, created_at FROM cloud_chat_messages
         WHERE conversation_id = $1 AND deleted_at IS NULL AND message_kind IN ('text', 'voice')
         ORDER BY conversation_sequence DESC LIMIT $2",
    )
    .bind(conversation_id)
    .bind(RECENT_CHAT)
    .fetch_all(pool)
    .await?;
    chat.reverse();
    let recent_chat: Vec<Value> = chat
        .into_iter()
        .filter_map(|(content, at)| {
            let decoded =
                crate::proactive::snapshot::decode(&content, &agent.agent_id, &agent.name);
            let text = decoded.text.trim();
            (!text.is_empty()).then(|| {
                json!({
                    "from": if decoded.from_agent { "agent" } else { "owner" },
                    "at": at.to_rfc3339(),
                    "text": cut(text, CHAT_TEXT_LIMIT),
                })
            })
        })
        .collect();
    Ok(json!({
        "owner": {"name": agent.owner_name, "handle": agent.owner_handle},
        "agent": {"agentId": agent.agent_id, "name": agent.name},
        "now": Utc::now().to_rfc3339(),
        "events": events.iter().map(Event::to_value).collect::<Vec<_>>(),
        "recentShares": shares
            .into_iter()
            .map(|(at, text)| json!({"at": at.to_rfc3339(), "text": text}))
            .collect::<Vec<_>>(),
        "recentChat": recent_chat,
    }))
}

/// The event ids a snapshot shows.
pub(super) fn event_ids(snapshot: &Value) -> Vec<&str> {
    snapshot["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|event| event["eventId"].as_str())
        .collect()
}

/// The source chip of one snapshot event: `{eventId, provider, title}`.
pub(super) fn source(snapshot: &Value, event_id: &str) -> Option<Value> {
    let event = snapshot["events"]
        .as_array()?
        .iter()
        .find(|event| event["eventId"].as_str() == Some(event_id))?;
    Some(json!({
        "eventId": event_id,
        "provider": event["provider"],
        "title": event["title"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, payload: Value) -> Event {
        Event {
            event_id: id.into(),
            provider: "gmail".into(),
            kind: "message.received".into(),
            occurred_at: Utc::now(),
            received_at: Utc::now(),
            payload,
            stale: false,
        }
    }

    #[test]
    fn events_carry_a_title_and_a_bounded_summary() {
        let value = event(
            "cnevt_1",
            json!({"from": "Sam <sam@example.com>", "subject": "Lunch?"}),
        )
        .to_value();
        assert_eq!(value["eventId"], "cnevt_1");
        assert_eq!(value["title"], "Sam · Lunch?");
        assert_eq!(value["summary"]["subject"], "Lunch?");
        let big = event(
            "cnevt_2",
            json!({"from": "Sam", "snippet": "x".repeat(3_000)}),
        )
        .to_value();
        assert_eq!(big["summary"], json!({"truncated": true}));
        assert_eq!(big["title"], "Sam", "the title is read before the cut");
    }

    #[test]
    fn sources_follow_the_snapshot() {
        let snapshot = json!({"events": [
            event("cnevt_a", json!({"subject": "Invoice"})).to_value(),
            event("cnevt_b", json!({"from": "Riya"})).to_value(),
        ]});
        assert_eq!(event_ids(&snapshot), vec!["cnevt_a", "cnevt_b"]);
        assert_eq!(
            source(&snapshot, "cnevt_b"),
            Some(json!({"eventId": "cnevt_b", "provider": "gmail", "title": "Riya"}))
        );
        assert_eq!(source(&snapshot, "cnevt_x"), None);
    }

    #[test]
    fn handles_prefer_the_public_handle() {
        assert_eq!(handle(Some("@mina".into()), "Mina Park"), "@mina");
        assert_eq!(handle(Some(" ".into()), "Mina Park"), "@MinaPark");
        assert_eq!(handle(None, "Mina"), "@Mina");
        assert_eq!(cut("abcdef", 3), "abc\u{2026}");
    }
}
