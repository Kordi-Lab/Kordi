//! Room results and match detail, per pair of shared profiles.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};

use super::store::{self, Pending, Queued, MAX_THEME_MEMBERS};
use super::{shared_cards, suggestion, visible_themes, MatchResult, SharedCard};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::common_ground::actions::{attach, relationship, relationships, room_extras};
use crate::common_ground::profiles::{self, ProfileQuery};
use crate::common_ground::{card, db_error, limited, people, rooms};
use crate::{auth::routes::CloudSession, server::ServerState};

/// A person with the profile they share with the viewer.
pub(super) fn person(card: &SharedCard) -> Value {
    let mut person = people::person(
        &card.account_id,
        Some(&card.name),
        card.handle.as_deref(),
        card.avatar_url.as_deref(),
    );
    person["profile"] = card.profile_tag();
    person
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
/// `status` is "matching" until everything is in. A closed room shows what
/// was stored for it and never queues a run.
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
    let (room_id, open) = match rooms::my_room(pool, &code, account).await {
        Ok(Some(room)) => room,
        Ok(None) => return rooms::room_not_found(),
        Err(error) => return db_error(error),
    };
    let members: Result<Vec<(String, String)>, _> = query_as(
        "SELECT account_id, profile_id FROM cloud_common_ground_room_members
         WHERE room_id = $1 AND left_at IS NULL ORDER BY joined_at, account_id",
    )
    .bind(room_id)
    .fetch_all(pool)
    .await;
    let members = match members {
        Ok(rows) => rows,
        Err(error) => return db_error(error),
    };
    let cards = match shared_cards(pool, &members).await {
        Ok(cards) => cards,
        Err(error) => return db_error(error),
    };
    let Some(viewer) = cards.iter().find(|c| c.account_id == account).cloned() else {
        // Your card here is not shared or not built: nobody shows.
        let mine = members.iter().find(|(id, _)| id == account);
        return match mine {
            Some((_, profile_id)) => profiles::require_shared_card(pool, profile_id)
                .await
                .unwrap_or_else(card::no_card),
            None => card::no_card(),
        };
    };
    let others: Vec<SharedCard> = cards
        .iter()
        .filter(|c| c.account_id != account)
        .cloned()
        .collect();
    let fresh = if open {
        store::fresh_results(pool, &viewer, &others).await
    } else {
        store::stored_results(pool, &viewer, &others).await
    };
    let fresh = match fresh {
        Ok(fresh) => fresh,
        Err(error) => return db_error(error),
    };
    let stale: Vec<SharedCard> = others
        .iter()
        .filter(|o| !fresh.contains_key(&o.profile_id))
        .cloned()
        .collect();
    let theme_members: Vec<SharedCard> = cards.iter().take(MAX_THEME_MEMBERS).cloned().collect();
    let key = store::members_key(&theme_members);
    let themes = if open {
        store::stored_themes(pool, room_id, &key).await
    } else {
        store::latest_themes(pool, room_id).await
    };
    let themes = match themes {
        Ok(themes) => themes,
        Err(error) => return db_error(error),
    };
    // A closed room keeps themes computed with people who no longer share.
    let visible = themes.map(|themes| visible_themes(themes, &cards));
    let needs_themes = open && visible.is_none() && theme_members.len() >= 2;
    // Each queued run is charged; polling while one works or pauses is free.
    let mut pending = None;
    if open && !stale.is_empty() {
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
        .filter_map(|o| fresh.get(&o.profile_id).map(|r| (o, r)))
        .collect();
    ranked.sort_by(|a, b| b.1.score.cmp(&a.1.score).then(a.0.name.cmp(&b.0.name)));
    let ranked_ids: Vec<String> = ranked.iter().map(|(c, _)| c.account_id.clone()).collect();
    let relationships = match relationships(pool, account, &ranked_ids).await {
        Ok(relationships) => relationships,
        Err(error) => return db_error(error),
    };
    let people: Vec<Value> = ranked
        .iter()
        .map(|(card, result)| {
            let mut entry = json!({ "person": person(card), "score": result.score, "headline": result.headline });
            attach(&mut entry, &card.account_id, &relationships);
            entry
        })
        .collect();
    let (groups, invitations) = match room_extras(pool, room_id, account).await {
        Ok(extras) => extras,
        Err(error) => return db_error(error),
    };
    let by_id = |id: &String| cards.iter().find(|c| &c.account_id == id);
    let theme_view = |(label, ids): &(String, Vec<String>)| {
        // You come first, then everyone else in join order.
        let mut ids: Vec<&String> = ids.iter().collect();
        ids.sort_by_key(|id| *id != account);
        json!({ "label": label, "people": ids.into_iter().filter_map(by_id).map(person).collect::<Vec<_>>() })
    };
    let themes = visible.unwrap_or_default();
    (
        StatusCode::OK,
        Json(json!({
            "status": status(pending),
            "profileId": viewer.profile_id,
            "people": people,
            "topics": themes.iter().map(theme_view).collect::<Vec<_>>(),
            "suggestion": suggestion(&themes, account).map(theme_view),
            "groups": groups,
            "invitations": invitations,
        })),
    )
        .into_response()
}

/// `GET /v1/cloud/common-ground/people/:account_id/match?profile=<id>`:
/// what you share with someone you may see, between the profile you share
/// with them and the one they share with you. `profile` picks your profile;
/// by default the most recent room or pairing decides. Opening a ready
/// match adds it to Recent. Someone you only share a closed room with shows
/// the stored match; nothing new runs.
pub(in crate::common_ground) async fn match_detail(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Path(other): Path<String>,
    Query(params): Query<ProfileQuery>,
) -> Response {
    let Some(pip) = state.pip() else {
        return crate::common_ground::unavailable();
    };
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let requested = params.profile.as_deref().filter(|id| !id.is_empty());
    let link = match people::link(pool, account, &other, requested).await {
        Ok(Some(link)) => link,
        Ok(None) => return people::hidden(pool, account, &other, requested).await,
        Err(error) => return db_error(error),
    };
    let pair = [
        (account.to_string(), link.viewer_profile.clone()),
        (other.clone(), link.other_profile.clone()),
    ];
    let cards = match shared_cards(pool, &pair).await {
        Ok(cards) => cards,
        Err(error) => return db_error(error),
    };
    // A card that stopped sharing since the link was read hides it.
    let (Some(viewer), Some(other_card)) = (
        cards.iter().find(|c| c.account_id == account),
        cards.iter().find(|c| c.account_id == other),
    ) else {
        return people::hidden(pool, account, &other, requested).await;
    };
    let fresh = if link.live {
        store::fresh_results(pool, viewer, std::slice::from_ref(other_card)).await
    } else {
        store::stored_results(pool, viewer, std::slice::from_ref(other_card)).await
    };
    let fresh = match fresh {
        Ok(fresh) => fresh,
        Err(error) => return db_error(error),
    };
    if let Some(result) = fresh.get(&other_card.profile_id) {
        if let Err(error) = query(
            "UPDATE cloud_common_ground_matches SET opened_at = now()
             WHERE viewer_profile_id = $1 AND other_profile_id = $2",
        )
        .bind(&viewer.profile_id)
        .bind(&other_card.profile_id)
        .execute(pool)
        .await
        {
            return db_error(error);
        }
        let mut body = json!(result);
        body["status"] = json!("ready");
        body["person"] = person(other_card);
        body["profileId"] = json!(viewer.profile_id);
        match relationship(pool, account, &other).await {
            Ok(relationship) => body["relationship"] = relationship,
            Err(error) => return db_error(error),
        }
        return (StatusCode::OK, Json(body)).into_response();
    }
    if !link.live {
        return crate::common_ground::err(
            "common_ground_match_not_found",
            "No match was saved for this person.",
            StatusCode::NOT_FOUND,
        );
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
        Ok(Queued::Pending(pending)) => match relationship(pool, account, &other).await {
            Ok(relationship) => (
                StatusCode::ACCEPTED,
                Json(json!({
                    "status": status(Some(pending)),
                    "person": person(other_card),
                    "profileId": viewer.profile_id,
                    "relationship": relationship,
                })),
            )
                .into_response(),
            Err(error) => db_error(error),
        },
        Ok(Queued::Limited(retry_after)) => limited(retry_after),
        Err(error) => db_error(error),
    }
}
