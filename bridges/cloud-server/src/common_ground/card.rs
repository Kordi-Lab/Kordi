//! Card types and the owner's card routes: read, edit topics, hide topics,
//! sharing, and delete.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::Response, Extension, Json};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::{PgPool, Postgres};

use super::{db_error, err, profile};
use crate::{auth::routes::CloudSession, server::ServerState};

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

pub(super) async fn load<'e, E>(executor: E, account: &str) -> sqlx_core::Result<Option<CardRow>>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let sql = format!(
        "SELECT card.topics_json, card.evidence_json, card.hidden_json, card.sharing_enabled,
                card.revision, card.built_at, ({BUILD_IN_FLIGHT_SQL}), card.build_error_code
         FROM cloud_common_ground_cards card WHERE card.account_id = $1"
    );
    let row: Option<RawCardRow> = query_as(&sql)
        .bind(account)
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

pub(super) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    owner_response(state.db_pool(), &session.account_id, StatusCode::OK).await
}

pub(super) async fn owner_response(pool: &PgPool, account: &str, status: StatusCode) -> Response {
    use axum::response::IntoResponse;
    match load(pool, account).await {
        Ok(Some(card)) => (status, Json(card.owner_view(Utc::now().date_naive()))).into_response(),
        Ok(None) => (status, Json(empty_view())).into_response(),
        Err(error) => db_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TopicsRequest {
    working_on: Vec<String>,
    interests: Vec<String>,
    can_help: Vec<String>,
    looking_for: Vec<String>,
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

/// Replaces the four lists after the owner removed or added tags. A topic the
/// owner typed gets an "Added by you" reference dated today; existing topics
/// keep their references.
pub(super) async fn update_topics(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(body): Json<TopicsRequest>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let result = async {
        let mut tx = pool.begin().await?;
        query("SELECT 1 FROM cloud_common_ground_cards WHERE account_id = $1 FOR UPDATE")
            .bind(account)
            .execute(&mut *tx)
            .await?;
        let Some(card) = load(&mut *tx, account).await?.filter(CardRow::has_card) else {
            return Ok(None);
        };
        let before: HashSet<String> = card.topics.current().cloned().collect();
        let mut seen = HashSet::new();
        let mut list = |items: &[String]| {
            let mut out = Vec::new();
            for topic in clean_list(items, MAX_TOPIC_CHARS, &mut seen) {
                // Typed topics are held to the shorter "+ Add" limit.
                if before.contains(&topic) || topic.chars().count() <= MAX_TYPED_TOPIC_CHARS {
                    out.push(topic);
                }
            }
            out
        };
        let mut topics = Topics {
            working_on: list(&body.working_on),
            interests: list(&body.interests),
            can_help: list(&body.can_help),
            looking_for: list(&body.looking_for),
            earlier: card.topics.earlier.clone(),
            refs: BTreeMap::new(),
        };
        let mut evidence = card.evidence.clone();
        let today = Utc::now().date_naive().to_string();
        let added: Vec<String> = topics
            .current()
            .filter(|topic| !before.contains(*topic))
            .cloned()
            .collect();
        let kept: Vec<String> = topics
            .current()
            .chain(topics.earlier.iter())
            .cloned()
            .collect();
        for label in kept {
            if let Some(ids) = card.topics.refs.get(&label) {
                topics.refs.insert(label, ids.clone());
            }
        }
        for label in added {
            if topics.refs.get(&label).is_some_and(|ids| !ids.is_empty()) {
                continue;
            }
            let id = next_evidence_id(&evidence);
            evidence.push(Evidence {
                id: id.clone(),
                source: ADDED_BY_YOU.into(),
                title: label.clone(),
                date: Some(today.clone()),
                url: None,
                snippet: label.clone(),
            });
            topics.refs.insert(label, vec![id]);
        }
        let cited: HashSet<&String> = topics.refs.values().flatten().collect();
        evidence.retain(|item| cited.contains(&item.id));
        let current: HashSet<&String> = topics.current().collect();
        let hidden: Vec<&String> = card.hidden.iter().filter(|h| current.contains(h)).collect();
        query(
            "UPDATE cloud_common_ground_cards SET topics_json = $2, evidence_json = $3,
                 hidden_json = $4, revision = revision + 1, updated_at = now()
             WHERE account_id = $1",
        )
        .bind(account)
        .bind(serde_json::to_value(&topics).unwrap_or_default())
        .bind(serde_json::to_value(&evidence).unwrap_or_default())
        .bind(json!(hidden))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(()))
    }
    .await;
    after_edit(pool, account, result).await
}

fn next_evidence_id(evidence: &[Evidence]) -> String {
    let taken: HashSet<&str> = evidence.iter().map(|item| item.id.as_str()).collect();
    (evidence.len() + 1..)
        .map(|n| format!("e{n}"))
        .find(|id| !taken.contains(id.as_str()))
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub(super) struct HiddenRequest {
    hidden: Vec<String>,
}

/// Hidden topics stay on the owner's card but are never shared or matched.
pub(super) async fn update_hidden(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(body): Json<HiddenRequest>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let result = async {
        let mut tx = pool.begin().await?;
        let Some(card) = load(&mut *tx, account).await?.filter(CardRow::has_card) else {
            return Ok(None);
        };
        let current: HashSet<&String> = card.topics.current().collect();
        let mut hidden: Vec<&String> = Vec::new();
        for topic in body.hidden.iter().filter(|topic| current.contains(topic)) {
            if !hidden.contains(&topic) {
                hidden.push(topic);
            }
        }
        query(
            "UPDATE cloud_common_ground_cards SET hidden_json = $2, revision = revision + 1,
                 updated_at = now()
             WHERE account_id = $1",
        )
        .bind(account)
        .bind(json!(hidden))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(()))
    }
    .await;
    after_edit(pool, account, result).await
}

async fn after_edit(
    pool: &PgPool,
    account: &str,
    result: sqlx_core::Result<Option<()>>,
) -> Response {
    match result {
        Ok(Some(())) => owner_response(pool, account, StatusCode::OK).await,
        Ok(None) => no_card(),
        Err(error) => db_error(error),
    }
}

pub(super) fn no_card() -> Response {
    err(
        "common_ground_no_card",
        "Build your card first.",
        StatusCode::CONFLICT,
    )
}

#[derive(Debug, Deserialize)]
pub(super) struct SettingsRequest {
    sharing: bool,
}

/// Sharing off hides the card from new rooms and pairings and from people
/// who could already see it.
pub(super) async fn update_settings(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(body): Json<SettingsRequest>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let result = query(
        "INSERT INTO cloud_common_ground_cards (account_id, sharing_enabled) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET sharing_enabled = EXCLUDED.sharing_enabled,
             revision = cloud_common_ground_cards.revision + 1, updated_at = now()",
    )
    .bind(account)
    .bind(body.sharing)
    .execute(pool)
    .await;
    match result {
        Ok(_) => owner_response(pool, account, StatusCode::OK).await,
        Err(error) => db_error(error),
    }
}

/// Deletes the card, its references and cached matches, and leaves every
/// room. Pairings stay so the people already met remain listed, but with no
/// card there is nothing to show them.
pub(super) async fn delete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let result = async {
        let mut tx = pool.begin().await?;
        query("DELETE FROM cloud_common_ground_cards WHERE account_id = $1")
            .bind(account)
            .execute(&mut *tx)
            .await?;
        query(
            "DELETE FROM cloud_common_ground_matches
             WHERE viewer_account_id = $1 OR other_account_id = $1",
        )
        .bind(account)
        .execute(&mut *tx)
        .await?;
        let rooms = super::rooms::leave_all(&mut tx, account).await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(rooms)
    }
    .await;
    match result {
        Ok(rooms) => {
            for room in rooms {
                super::rooms::announce(pool, room).await;
            }
            use axum::response::IntoResponse;
            (StatusCode::OK, Json(empty_view())).into_response()
        }
        Err(error) => db_error(error),
    }
}
