//! Helpers for the profile tests: create profiles, build a card for one of
//! them, and answer match runs.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::db_fixture::send;
use super::support::{card_reply, claim, claim_open, RUNNER};
use crate::common_ground::complete;

pub(super) const PROFILES: &str = "/v1/cloud/common-ground/profiles";

/// Creates a profile and returns its id.
pub(super) async fn create_profile(
    app: &axum::Router,
    token: &str,
    kind: &str,
    name: Option<&str>,
) -> String {
    let (status, body) = send(
        app,
        "POST",
        PROFILES,
        token,
        Some(json!({"kind": kind, "name": name})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    body["profileId"].as_str().unwrap().to_string()
}

/// Builds `profile_id`'s card from the same notes every time, answering the
/// run with one working-on topic. Returns the run's system prompt.
pub(super) async fn build_profile(
    app: &axum::Router,
    pool: &PgPool,
    (account, token): (&str, &str),
    profile_id: &str,
    working_on: &str,
) -> String {
    let (status, body) = send(
        app,
        "POST",
        "/v1/cloud/common-ground/card/build",
        token,
        Some(json!({"profileId": profile_id, "notes": "I study agent memory and train for a marathon."})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["profile"]["profileId"], profile_id, "{body}");
    let run_id = claim(pool, account).await;
    let (system_prompt,): (String,) =
        query_as("SELECT system_prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(pool)
            .await
            .unwrap();
    let reply = card_reply(&[working_on], &[], &[], &[]);
    complete(pool, &run_id, RUNNER, &reply).await.unwrap();
    system_prompt
}

/// Answers the viewer's open match run with nothing in common for everyone.
/// Returns the run's prompt, which lists the cards it read.
pub(super) async fn answer_empty(pool: &PgPool, viewer: &str) -> String {
    let (run_id, cards) = claim_open(pool, "match", Some(viewer)).await;
    let (prompt,): (String,) =
        query_as("SELECT prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(pool)
            .await
            .unwrap();
    let people: Vec<Value> = (0..cards.len() - 1).map(|i| json!({"person": i})).collect();
    complete(
        pool,
        &run_id,
        RUNNER,
        &json!({ "people": people }).to_string(),
    )
    .await
    .unwrap();
    prompt
}

/// Matches stored between these two profiles, either way.
pub(super) async fn matches_between(pool: &PgPool, a: &str, b: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_matches
         WHERE (viewer_profile_id = $1 AND other_profile_id = $2)
            OR (viewer_profile_id = $2 AND other_profile_id = $1)",
    )
    .bind(a)
    .bind(b)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}
