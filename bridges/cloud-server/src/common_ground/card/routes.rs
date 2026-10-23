//! The owner's card routes: read, edit topics, hide topics, sharing, and
//! delete. Each takes the profile whose card it changes; without one it uses
//! the account's default profile.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;

use super::{
    clean_list, empty_view, load, next_evidence_id, no_card, CardRow, Evidence, Topics,
    ADDED_BY_YOU, MAX_TOPIC_CHARS, MAX_TYPED_TOPIC_CHARS,
};
use crate::common_ground::profiles::{self, Profile, ProfileQuery};
use crate::common_ground::{db_error, people, rooms};
use crate::{auth::routes::CloudSession, server::ServerState};

/// The owner's view of `profile`'s card, with the profile and the owner's
/// public @handle (null when none).
pub(in crate::common_ground) async fn owner_view(
    pool: &PgPool,
    account_id: &str,
    profile: Option<&Profile>,
) -> sqlx_core::Result<Value> {
    let card = match profile {
        Some(profile) => load(pool, &profile.profile_id).await?,
        None => None,
    };
    let since = match profile {
        Some(profile) => {
            let built_at = card.as_ref().and_then(|card| card.built_at);
            memories_since_build(pool, profile, built_at).await?
        }
        None => 0,
    };
    let mut view = match card {
        Some(card) => card.owner_view(Utc::now().date_naive()),
        None => empty_view(),
    };
    view["profile"] = profile.map(Profile::summary).unwrap_or(Value::Null);
    view["memoriesSinceBuild"] = json!(since);
    view["handle"] = json!(people::handle(pool, account_id).await?);
    Ok(view)
}

/// Memories routed to the profile that changed after its card was built,
/// or all of them when it never was.
pub(in crate::common_ground) async fn memories_since_build(
    pool: &PgPool,
    profile: &Profile,
    built_at: Option<chrono::DateTime<Utc>>,
) -> sqlx_core::Result<i64> {
    crate::memory_store::count_since(pool, &profile.account_id, profile.memory_target(), built_at)
        .await
}

pub(in crate::common_ground) async fn owner_response(
    pool: &PgPool,
    account_id: &str,
    profile: Option<&Profile>,
    status: StatusCode,
) -> Response {
    match owner_view(pool, account_id, profile).await {
        Ok(view) => (status, Json(view)).into_response(),
        Err(error) => db_error(error),
    }
}

/// `GET /v1/cloud/common-ground/card?profile=<id>`.
pub(in crate::common_ground) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(params): Query<ProfileQuery>,
) -> Response {
    let pool = state.db_pool();
    match profiles::resolve(pool, &session.account_id, params.profile.as_deref()).await {
        Ok(profile) => {
            owner_response(pool, &session.account_id, profile.as_ref(), StatusCode::OK).await
        }
        Err(response) => *response,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::common_ground) struct TopicsRequest {
    working_on: Vec<String>,
    interests: Vec<String>,
    can_help: Vec<String>,
    looking_for: Vec<String>,
}

/// `PUT /v1/cloud/common-ground/card?profile=<id>`: replaces the four lists
/// after the owner removed or added tags. A topic the owner typed gets an
/// "Added by you" reference dated today; existing topics keep their
/// references.
pub(in crate::common_ground) async fn update_topics(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(params): Query<ProfileQuery>,
    Json(body): Json<TopicsRequest>,
) -> Response {
    let pool = state.db_pool();
    let profile =
        match profiles::resolve(pool, &session.account_id, params.profile.as_deref()).await {
            Ok(Some(profile)) => profile,
            Ok(None) => return no_card(),
            Err(response) => return *response,
        };
    let id = profile.profile_id.as_str();
    let result = async {
        let mut tx = pool.begin().await?;
        query("SELECT 1 FROM cloud_common_ground_cards WHERE profile_id = $1 FOR UPDATE")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let Some(card) = load(&mut *tx, id).await?.filter(CardRow::has_card) else {
            return Ok(None);
        };
        let (topics, evidence, hidden) = edited(&card, &body);
        query(
            "UPDATE cloud_common_ground_cards SET topics_json = $2, evidence_json = $3,
                 hidden_json = $4, revision = revision + 1, updated_at = now()
             WHERE profile_id = $1",
        )
        .bind(id)
        .bind(serde_json::to_value(&topics).unwrap_or_default())
        .bind(serde_json::to_value(&evidence).unwrap_or_default())
        .bind(json!(hidden))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(()))
    }
    .await;
    after_edit(pool, &profile, result).await
}

/// The card's topics, evidence and hidden topics after the owner's edit.
fn edited(card: &CardRow, body: &TopicsRequest) -> (Topics, Vec<Evidence>, Vec<String>) {
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
    let hidden: Vec<String> = card
        .hidden
        .iter()
        .filter(|h| current.contains(h))
        .cloned()
        .collect();
    (topics, evidence, hidden)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::common_ground) struct HiddenRequest {
    #[serde(default)]
    profile_id: Option<String>,
    hidden: Vec<String>,
}

/// `PUT /v1/cloud/common-ground/card/hidden`: hidden topics stay on the
/// owner's card but are never shared or matched.
pub(in crate::common_ground) async fn update_hidden(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(body): Json<HiddenRequest>,
) -> Response {
    let pool = state.db_pool();
    let profile =
        match profiles::resolve(pool, &session.account_id, body.profile_id.as_deref()).await {
            Ok(Some(profile)) => profile,
            Ok(None) => return no_card(),
            Err(response) => return *response,
        };
    let id = profile.profile_id.as_str();
    let result = async {
        let mut tx = pool.begin().await?;
        let Some(card) = load(&mut *tx, id).await?.filter(CardRow::has_card) else {
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
             WHERE profile_id = $1",
        )
        .bind(id)
        .bind(json!(hidden))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(()))
    }
    .await;
    after_edit(pool, &profile, result).await
}

async fn after_edit(
    pool: &PgPool,
    profile: &Profile,
    result: sqlx_core::Result<Option<()>>,
) -> Response {
    match result {
        Ok(Some(())) => {
            owner_response(pool, &profile.account_id, Some(profile), StatusCode::OK).await
        }
        Ok(None) => no_card(),
        Err(error) => db_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::common_ground) struct SettingsRequest {
    #[serde(default)]
    profile_id: Option<String>,
    sharing: bool,
}

/// `PUT /v1/cloud/common-ground/settings`: sharing off hides the profile's
/// card from new rooms and pairings and from people who could already see
/// it. An account without a profile gets its work profile here.
pub(in crate::common_ground) async fn update_settings(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(body): Json<SettingsRequest>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let profile = match profiles::resolve_or_create(pool, account, body.profile_id.as_deref()).await
    {
        Ok(profile) => profile,
        Err(response) => return *response,
    };
    let result = query(
        "INSERT INTO cloud_common_ground_cards (profile_id, account_id, sharing_enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (profile_id) DO UPDATE SET sharing_enabled = EXCLUDED.sharing_enabled,
             revision = cloud_common_ground_cards.revision + 1, updated_at = now()",
    )
    .bind(&profile.profile_id)
    .bind(account)
    .bind(body.sharing)
    .execute(pool)
    .await;
    match result {
        Ok(_) => owner_response(pool, account, Some(&profile), StatusCode::OK).await,
        Err(error) => db_error(error),
    }
}

/// `DELETE /v1/cloud/common-ground/card?profile=<id>`: deletes the card, its
/// references and cached matches, and leaves every room where the profile
/// is shared. The profile and its pairings stay, but with no card there is
/// nothing to show.
pub(in crate::common_ground) async fn delete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(params): Query<ProfileQuery>,
) -> Response {
    let pool = state.db_pool();
    let profile = match profiles::resolve(pool, &session.account_id, params.profile.as_deref())
        .await
    {
        Ok(Some(profile)) => profile,
        Ok(None) => return owner_response(pool, &session.account_id, None, StatusCode::OK).await,
        Err(response) => return *response,
    };
    let id = profile.profile_id.as_str();
    let result = async {
        let mut tx = pool.begin().await?;
        query("DELETE FROM cloud_common_ground_cards WHERE profile_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        query(
            "DELETE FROM cloud_common_ground_matches
             WHERE viewer_profile_id = $1 OR other_profile_id = $1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let rooms = rooms::leave_profile(&mut tx, id).await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(rooms)
    }
    .await;
    match result {
        Ok(rooms) => {
            for room in rooms {
                rooms::announce(pool, room).await;
            }
            owner_response(pool, &session.account_id, Some(&profile), StatusCode::OK).await
        }
        Err(error) => db_error(error),
    }
}
