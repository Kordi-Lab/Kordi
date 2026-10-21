//! Card types: one card per profile, with the topics, the evidence only its
//! owner sees, hidden topics and sharing. The owner's routes are in
//! `routes`.

mod routes;

pub(super) use routes::{delete, owner_view, read, update_hidden, update_settings, update_topics};

use std::collections::{BTreeMap, HashSet};

use axum::{http::StatusCode, response::Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::Postgres;

use super::{err, profile};

/// Topics per list and characters per topic.
pub(super) const MAX_TOPICS: usize = 10;
pub(super) const MAX_TOPIC_CHARS: usize = 60;
/// A topic someone types on the card ("+ Add").
pub(super) const MAX_TYPED_TOPIC_CHARS: usize = 40;
pub(super) const ADDED_BY_YOU: &str = "Added by you";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Topics {
    pub working_on: Vec<String>,
    pub interests: Vec<String>,
    pub can_help: Vec<String>,
    pub looking_for: Vec<String>,
    /// Past topics without recent evidence. Shown on the owner's timeline,
    /// never shared or matched.
    pub earlier: Vec<String>,
    /// Evidence ids behind each topic.
    pub refs: BTreeMap<String, Vec<String>>,
}

impl Topics {
    /// The four card lists in display order.
    pub fn lists(&self) -> [&Vec<String>; 4] {
        [
            &self.working_on,
            &self.interests,
            &self.can_help,
            &self.looking_for,
        ]
    }

    pub fn current(&self) -> impl Iterator<Item = &String> {
        self.lists().into_iter().flatten()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Evidence {
    pub id: String,
    pub source: String,
    pub title: String,
    /// `YYYY-MM-DD`, when the source has a date.
    pub date: Option<String>,
    pub url: Option<String>,
    pub snippet: String,
}

pub(super) struct CardRow {
    pub topics: Topics,
    pub evidence: Vec<Evidence>,
    pub hidden: Vec<String>,
    pub sharing: bool,
    pub revision: i64,
    pub built_at: Option<DateTime<Utc>>,
    pub building: bool,
    pub error_code: Option<String>,
}

type RawCardRow = (
    Value,
    Value,
    Value,
    bool,
    i64,
    Option<DateTime<Utc>>,
    bool,
    Option<String>,
);

/// A build counts as in flight while its run is still queued or running.
/// A run the runtime gave up on without reporting back does not block a new
/// build forever.
pub(super) const BUILD_IN_FLIGHT_SQL: &str = "card.active_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM cloud_agent_fallback_runs run
    WHERE run.run_id = card.active_run_id AND run.status IN ('queued', 'leased', 'running'))
    AND card.build_started_at > now() - interval '15 minutes'";

/// The card of this profile.
pub(super) async fn load<'e, E>(executor: E, profile_id: &str) -> sqlx_core::Result<Option<CardRow>>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let sql = format!(
        "SELECT card.topics_json, card.evidence_json, card.hidden_json, card.sharing_enabled,
                card.revision, card.built_at, ({BUILD_IN_FLIGHT_SQL}), card.build_error_code
         FROM cloud_common_ground_cards card WHERE card.profile_id = $1"
    );
    let row: Option<RawCardRow> = query_as(&sql)
        .bind(profile_id)
        .fetch_optional(executor)
        .await?;
    Ok(row.map(
        |(topics, evidence, hidden, sharing, revision, built_at, building, error_code)| CardRow {
            topics: serde_json::from_value(topics).unwrap_or_default(),
            evidence: serde_json::from_value(evidence).unwrap_or_default(),
            hidden: serde_json::from_value(hidden).unwrap_or_default(),
            sharing,
            revision,
            built_at,
            building,
            error_code,
        },
    ))
}

impl CardRow {
    pub fn has_card(&self) -> bool {
        self.built_at.is_some()
    }

    /// Topics others may see: the four lists without hidden topics.
    pub fn shared_topics(&self) -> Topics {
        let hidden: HashSet<&str> = self.hidden.iter().map(String::as_str).collect();
        let keep = |list: &Vec<String>| -> Vec<String> {
            list.iter()
                .filter(|topic| !hidden.contains(topic.as_str()))
                .cloned()
                .collect()
        };
        Topics {
            working_on: keep(&self.topics.working_on),
            interests: keep(&self.topics.interests),
            can_help: keep(&self.topics.can_help),
            looking_for: keep(&self.topics.looking_for),
            earlier: Vec::new(),
            refs: BTreeMap::new(),
        }
    }

    /// The owner's view, with references and the profile.
    pub fn owner_view(&self, today: chrono::NaiveDate) -> Value {
        let build = json!({
            "status": if self.building { "building" } else if self.error_code.is_some() { "failed" } else { "idle" },
            "errorCode": if self.building { None } else { self.error_code.clone() },
        });
        if !self.has_card() {
            return json!({ "card": Value::Null, "sharing": self.sharing, "build": build });
        }
        let topics = &self.topics;
        json!({
            "card": {
                "workingOn": topics.working_on,
                "interests": topics.interests,
                "canHelp": topics.can_help,
                "lookingFor": topics.looking_for,
                "hidden": self.hidden,
                "revision": self.revision,
                "builtAt": self.built_at,
                "profile": profile::build(topics, &self.evidence, &self.hidden, today),
            },
            "sharing": self.sharing,
            "build": build,
        })
    }
}

pub(super) fn empty_view() -> Value {
    json!({ "card": Value::Null, "sharing": true, "build": { "status": "idle", "errorCode": Value::Null } })
}

/// Collapses whitespace, caps the length and drops duplicates (ignoring case)
/// across every list.
pub(super) fn clean_list(
    items: &[String],
    max_chars: usize,
    seen: &mut HashSet<String>,
) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        let text: String = item.split_whitespace().collect::<Vec<_>>().join(" ");
        let text: String = text.chars().take(max_chars).collect();
        if text.is_empty() || !seen.insert(text.to_lowercase()) {
            continue;
        }
        out.push(text);
        if out.len() == MAX_TOPICS {
            break;
        }
    }
    out
}

pub(super) fn next_evidence_id(evidence: &[Evidence]) -> String {
    let taken: HashSet<&str> = evidence.iter().map(|item| item.id.as_str()).collect();
    (evidence.len() + 1..)
        .map(|n| format!("e{n}"))
        .find(|id| !taken.contains(id.as_str()))
        .unwrap_or_default()
}

pub(super) fn no_card() -> Response {
    err(
        "common_ground_no_card",
        "Build your card first.",
        StatusCode::CONFLICT,
    )
}
