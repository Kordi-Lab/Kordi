//! `GET /v1/cloud/common-ground/nearby/people?range=&minScore=`: present
//! participants around the viewer, filtered by the viewer's own range and
//! minimum score.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};

use super::distance::valid_range;
use super::invalid_settings;
use super::participation::{self, Present};
use super::results::{self, entry, order_key};
use super::settings::MIN_SCORES;
use crate::auth::rate_limit::CloudRateLimiter;
use crate::common_ground::actions::{attach, relationships};
use crate::common_ground::{db_error, unavailable};
use crate::{auth::routes::CloudSession, server::ServerState};

/// People listed at most.
const MAX_LISTED: usize = 50;
/// Candidates read around the viewer, nearest first.
const MAX_CANDIDATES: i64 = 500;

/// A query parameter, or `default` when it is left out. `None` when it is
/// present but not valid.
fn parameter(
    params: &HashMap<String, String>,
    name: &str,
    valid: impl Fn(i64) -> bool,
    default: i32,
) -> Option<i32> {
    match params.get(name) {
        None => Some(default),
        Some(value) => match value.trim().parse::<i64>() {
            Ok(value) if valid(value) => Some(value as i32),
            _ => None,
        },
    }
}

/// `GET /v1/cloud/common-ground/nearby/people`. Parameters left out use the
/// stored settings; parameters never change them.
pub(super) async fn search(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(pip) = state.system_agent() else {
        return unavailable();
    };
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let viewer = match results::viewer(pool, account).await {
        Ok(Ok(viewer)) => viewer,
        Ok(Err(response)) => return response,
        Err(error) => return db_error(error),
    };
    let valid_score = |score: i64| MIN_SCORES.contains(&score);
    let (Some(range), Some(min_score)) = (
        parameter(&params, "range", valid_range, viewer.settings.range_m),
        parameter(&params, "minScore", valid_score, viewer.settings.min_score),
    ) else {
        return invalid_settings("Pick one of the distances and match scores.");
    };
    let min_score = i64::from(min_score);
    let people = match participation::around(pool, &viewer.me, range, MAX_CANDIDATES).await {
        Ok(people) => people,
        Err(error) => return db_error(error),
    };
    let evaluated =
        match results::evaluate(pool, pip.config(), &rate_limiter, &viewer, &people).await {
            Ok(evaluated) => evaluated,
            Err(error) => return db_error(error),
        };
    // Unmatched people are counted; they are listed only without a minimum.
    let matching = people
        .iter()
        .filter(|person| !evaluated.matches.contains_key(&person.profile_id))
        .count();
    let mut listed: Vec<&Present> = people
        .iter()
        .filter(|person| match evaluated.matches.get(&person.profile_id) {
            Some(result) => result.score >= min_score,
            None => min_score == 0,
        })
        .collect();
    listed.sort_by_cached_key(|person| order_key(&evaluated, &viewer, person));
    listed.truncate(MAX_LISTED);
    let ids: Vec<String> = listed.iter().map(|p| p.account_id.clone()).collect();
    let relationships = match relationships(pool, account, &ids).await {
        Ok(relationships) => relationships,
        Err(error) => return db_error(error),
    };
    let entries: Vec<Value> = listed
        .iter()
        .map(|person| {
            let mut value = entry(&evaluated, &viewer, person);
            attach(&mut value, &person.account_id, &relationships);
            value
        })
        .collect();
    (
        StatusCode::OK,
        Json(json!({
            "people": entries,
            "matching": matching,
            "location": viewer.me.location_view(),
        })),
    )
        .into_response()
}
