//! Room results, match detail and Recent.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};

use super::store::{self, Pending, Queued, MAX_THEME_MEMBERS};
use super::{shared_cards, suggestion, MatchResult, SharedCard};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::common_ground::{card, db_error, limited, people, rooms};
use crate::{auth::routes::CloudSession, server::ServerState};

fn person(card: &SharedCard) -> Value {
    people::person(
        &card.account_id,
        Some(&card.name),
        card.avatar_url.as_deref(),
    )
}

fn status(pending: Option<Pending>) -> &'static str {
    match pending {
        None => "ready",
        Some(Pending::Running) => "matching",
        Some(Pending::Failed) => "failed",
    }
}

/// `POST /v1/cloud/common-ground/rooms/:code/results`: everyone in the room
/// ranked by match with you, the themes several people share, and the
/// suggested group. People still being matched are left out until ready;
/// `status` is "matching" until everything is in.
pub(in crate::common_ground) async fn results(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
) -> Response {
    let Some(pip) = state.pip() else {
        return crate::common_ground::unavailable();
    };
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let room_id = match rooms::my_room(pool, &code, account).await {
        Ok(Some(room_id)) => room_id,
        Ok(None) => return rooms::room_not_found(),
        Err(error) => return db_error(error),
    };
    let members: Result<Vec<(String,)>, _> = query_as(
        "SELECT account_id FROM cloud_common_ground_room_members
         WHERE room_id = $1 AND left_at IS NULL ORDER BY joined_at, account_id",
    )
    .bind(room_id)
    .fetch_all(pool)
    .await;
    let members: Vec<String> = match members {
        Ok(rows) => rows.into_iter().map(|(id,)| id).collect(),
        Err(error) => return db_error(error),
    };
    let cards = match shared_cards(pool, &members).await {
        Ok(cards) => cards,
        Err(error) => return db_error(error),
    };
    let Some(viewer) = cards.iter().find(|c| c.account_id == account).cloned() else {
        return card::no_card();
    };
    let others: Vec<SharedCard> = cards
        .iter()
        .filter(|c| c.account_id != account)
        .cloned()
        .collect();
    let fresh = match store::fresh_results(pool, &viewer, &others).await {
        Ok(fresh) => fresh,
        Err(error) => return db_error(error),
    };
    let stale: Vec<SharedCard> = others
        .iter()
        .filter(|o| !fresh.contains_key(&o.account_id))
        .cloned()
        .collect();
    let theme_members: Vec<SharedCard> = cards.iter().take(MAX_THEME_MEMBERS).cloned().collect();
    let key = store::members_key(&theme_members);
    let themes = match store::stored_themes(pool, room_id, &key).await {
        Ok(themes) => themes,
        Err(error) => return db_error(error),
    };
    let needs_themes = themes.is_none() && theme_members.len() >= 2;
    // Each queued run is charged; polling while one works or pauses is free.
    let mut pending = None;
    if !stale.is_empty() {
        let queued = store::queue_matches(
            pool,
            pip.config(),
            &rate_limiter,
            &viewer,
            &stale,
            Some(room_id),
        )
        .await;
        match queued {
            Ok(Queued::Pending(state)) => pending = Some(state),
            Ok(Queued::Limited(retry_after)) => return limited(retry_after),
            Err(error) => return db_error(error),
        }
    }
    if needs_themes {
        let queued = store::queue_themes(
            pool,
            pip.config(),
            &rate_limiter,
            room_id,
            account,
            &theme_members,
        )
        .await;
        match queued {
            Ok(Queued::Pending(state)) => pending = pending.or(Some(state)),
            Ok(Queued::Limited(retry_after)) => return limited(retry_after),
            Err(error) => return db_error(error),
        }
    }

    let mut ranked: Vec<(&SharedCard, &MatchResult)> = others
        .iter()
        .filter_map(|o| fresh.get(&o.account_id).map(|r| (o, r)))
        .collect();
    ranked.sort_by(|a, b| b.1.score.cmp(&a.1.score).then(a.0.name.cmp(&b.0.name)));
    let people: Vec<Value> = ranked
        .iter()
        .map(|(card, result)| json!({ "person": person(card), "score": result.score, "headline": result.headline }))
        .collect();
    let by_id = |id: &String| cards.iter().find(|c| &c.account_id == id);
    let theme_view = |(label, ids): &(String, Vec<String>)| {
        // You come first, then everyone else in join order.
        let mut ids: Vec<&String> = ids.iter().collect();
        ids.sort_by_key(|id| *id != account);
        json!({ "label": label, "people": ids.into_iter().filter_map(by_id).map(person).collect::<Vec<_>>() })
    };
    let themes = themes.unwrap_or_default();
    (
        StatusCode::OK,
        Json(json!({
            "status": status(pending),
            "people": people,
            "topics": themes.iter().map(theme_view).collect::<Vec<_>>(),
            "suggestion": suggestion(&themes, account).map(theme_view),
        })),
    )
        .into_response()
}

/// `GET /v1/cloud/common-ground/people/:account_id/match`: what you share
/// with someone you may see. Opening a ready match adds it to Recent.
pub(in crate::common_ground) async fn match_detail(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Path(other): Path<String>,
) -> Response {
    let Some(pip) = state.pip() else {
        return crate::common_ground::unavailable();
    };
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    match people::can_see(pool, account, &other).await {
        Ok(true) if other != account => {}
        Ok(_) => return people::not_found(),
        Err(error) => return db_error(error),
    }
    let cards = match shared_cards(pool, &[account.to_string(), other.clone()]).await {
        Ok(cards) => cards,
        Err(error) => return db_error(error),
    };
    let (Some(viewer), Some(other_card)) = (
        cards.iter().find(|c| c.account_id == account),
        cards.iter().find(|c| c.account_id == other),
    ) else {
        return if cards.iter().any(|c| c.account_id == account) {
            people::not_found()
        } else {
            card::no_card()
        };
    };
    let fresh = match store::fresh_results(pool, viewer, std::slice::from_ref(other_card)).await {
        Ok(fresh) => fresh,
        Err(error) => return db_error(error),
    };
    if let Some(result) = fresh.get(&other) {
        if let Err(error) = query(
            "UPDATE cloud_common_ground_matches SET opened_at = now()
             WHERE viewer_account_id = $1 AND other_account_id = $2",
        )
        .bind(account)
        .bind(&other)
        .execute(pool)
        .await
        {
            return db_error(error);
        }
        let mut body = json!(result);
        body["status"] = json!("ready");
        body["person"] = person(other_card);
        return (StatusCode::OK, Json(body)).into_response();
    }
    match store::queue_matches(
        pool,
        pip.config(),
        &rate_limiter,
        viewer,
        std::slice::from_ref(other_card),
        None,
    )
    .await
    {
        Ok(Queued::Pending(pending)) => (
            StatusCode::ACCEPTED,
            Json(json!({ "status": status(Some(pending)), "person": person(other_card) })),
        )
            .into_response(),
        Ok(Queued::Limited(retry_after)) => limited(retry_after),
        Err(error) => db_error(error),
    }
}

type RecentRow = (
    String,
    Option<String>,
    Option<String>,
    Value,
    DateTime<Utc>,
    bool,
);

/// `GET /v1/cloud/common-ground/recent`: people whose match you opened,
/// newest first. The score and headline are shown only while the match is
/// still current: both cards are at the revisions it was computed from, the
/// other person still shares, and you may still see them. Otherwise the
/// person stays in your history without them.
pub(in crate::common_ground) async fn recent(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let sql = format!(
        "SELECT account.account_id, account.display_name, account.avatar_url, m.result_json, m.opened_at,
                COALESCE(viewer_card.built_at IS NOT NULL
                    AND viewer_card.revision = m.viewer_revision
                    AND other_card.built_at IS NOT NULL
                    AND other_card.sharing_enabled
                    AND other_card.revision = m.other_revision
                    AND {}, false)
         FROM cloud_common_ground_matches m
         JOIN cloud_accounts account ON account.account_id = m.other_account_id
         LEFT JOIN cloud_common_ground_cards viewer_card ON viewer_card.account_id = m.viewer_account_id
         LEFT JOIN cloud_common_ground_cards other_card ON other_card.account_id = m.other_account_id
         WHERE m.viewer_account_id = $1 AND m.opened_at IS NOT NULL
         ORDER BY m.opened_at DESC LIMIT 50",
        people::visible_sql("m.viewer_account_id", "m.other_account_id"),
    );
    let rows: Result<Vec<RecentRow>, _> = query_as(&sql)
        .bind(&session.account_id)
        .fetch_all(state.db_pool())
        .await;
    match rows {
        Ok(rows) => {
            let people: Vec<Value> = rows
                .into_iter()
                .map(|(id, name, avatar_url, value, opened_at, current)| {
                    let result = current
                        .then(|| serde_json::from_value::<MatchResult>(value).ok())
                        .flatten();
                    json!({
                        "person": people::person(&id, name.as_deref(), avatar_url.as_deref()),
                        "score": result.as_ref().map(|r| r.score),
                        "headline": result.as_ref().map(|r| &r.headline),
                        "openedAt": opened_at,
                    })
                })
                .collect();
            (StatusCode::OK, Json(json!({ "people": people }))).into_response()
        }
        Err(error) => db_error(error),
    }
}
