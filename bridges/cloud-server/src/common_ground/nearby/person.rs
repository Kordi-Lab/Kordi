//! `GET /v1/cloud/common-ground/nearby/people/:account_id`: one nearby
//! person with their shared card, the viewer's request checks and the match
//! between the two nearby profiles. The pair rule is checked live; nothing
//! here adds a room, a pairing or a Recent entry.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};

use super::distance::{within, MAX_RANGE_M};
use super::participation;
use super::results::{self, entry, Evaluated, Viewer};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::common_ground::actions::relationship;
use crate::common_ground::{db_error, people, unavailable};
use crate::{auth::routes::CloudSession, server::ServerState};

/// Each active request in range with a current verdict, with its checks.
fn requests(evaluated: &Evaluated, viewer: &Viewer, person: &participation::Present) -> Vec<Value> {
    viewer
        .needs
        .iter()
        .filter(|need| within(person.distance_m, need.range_m))
        .filter_map(|need| {
            let checked = evaluated
                .verdicts
                .get(&(need.need_id.clone(), person.profile_id.clone()))?;
            let checks: Vec<Value> = checked
                .checks
                .iter()
                .map(|check| {
                    json!({
                        "condition": check.condition,
                        "label": checked.conditions.get(check.condition),
                        "verdict": check.verdict,
                        "kind": check.kind,
                        "evidence": check.evidence,
                    })
                })
                .collect();
            Some(json!({
                "needId": need.need_id,
                "text": need.text,
                "met": checked.met(),
                "checks": checks,
            }))
        })
        .collect()
}

pub(super) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Path(other): Path<String>,
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
    let mut person = match participation::present(pool, &other).await {
        Ok(Some(person)) if other != account => person,
        Ok(_) => return people::not_found(),
        Err(error) => return db_error(error),
    };
    person.distance_m = viewer.me.distance_to(&person);
    if !within(person.distance_m, MAX_RANGE_M) {
        return people::not_found();
    }
    let evaluated = match results::evaluate(
        pool,
        pip.config(),
        &rate_limiter,
        &viewer,
        std::slice::from_ref(&person),
    )
    .await
    {
        Ok(evaluated) => evaluated,
        Err(error) => return db_error(error),
    };
    let mut body = entry(&evaluated, &viewer, &person);
    match relationship(pool, account, &other).await {
        Ok(relationship) => body["relationship"] = relationship,
        Err(error) => return db_error(error),
    }
    body["profileId"] = json!(viewer.me.profile_id);
    let topics = &person.topics;
    body["card"] = json!({
        "workingOn": topics.working_on,
        "interests": topics.interests,
        "canHelp": topics.can_help,
        "lookingFor": topics.looking_for,
    });
    body["requests"] = json!(requests(&evaluated, &viewer, &person));
    // Recent lists every opened match, so opening one here does not mark
    // it: nearby alone never puts a person in Recent.
    if let Some(result) = evaluated.matches.get(&person.profile_id) {
        body["shared"] = json!(result.shared);
        body["youBring"] = json!(result.you_bring);
        body["theyBring"] = json!(result.they_bring);
        body["nextStep"] = json!(result.next_step);
    }
    (StatusCode::OK, Json(body)).into_response()
}
