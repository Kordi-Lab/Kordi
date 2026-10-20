//! Helpers shared by the Common ground database tests: build a card through
//! a simulated runner, and pick a room code.

use rand::Rng;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::db_fixture::send;
use crate::common_ground::complete;

pub(super) const RUNNER: &str = "cg-test-runner";

/// Claims the account's queued build as the runner would.
pub(super) async fn claim(pool: &PgPool, account: &str) -> String {
    let (run_id,): (String,) =
        query_as("SELECT active_run_id FROM cloud_common_ground_cards WHERE account_id = $1")
            .bind(account)
            .fetch_one(pool)
            .await
            .unwrap();
    let lease = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    claim_run(pool, &run_id, &lease).await;
    run_id
}

/// Marks a queued run as claimed by [`RUNNER`].
pub(super) async fn claim_run(pool: &PgPool, run_id: &str, lease: &str) {
    query("UPDATE cloud_agent_fallback_runs SET status = 'running', claimed_by = $2, lease_expires_at = $3 WHERE run_id = $1")
        .bind(run_id)
        .bind(RUNNER)
        .bind(lease)
        .execute(pool)
        .await
        .unwrap();
}

pub(super) fn reply(working_on: &[&str], can_help: &[&str]) -> String {
    card_reply(working_on, &["Retrieval"], can_help, &[])
}

/// A card build reply citing the first piece of evidence for every topic.
pub(super) fn card_reply(
    working_on: &[&str],
    interests: &[&str],
    can_help: &[&str],
    looking_for: &[&str],
) -> String {
    let cite = |labels: &[&str]| -> Value {
        json!(labels
            .iter()
            .map(|label| json!({"label": label, "evidence": [0]}))
            .collect::<Vec<_>>())
    };
    json!({
        "working_on": cite(working_on),
        "interests": cite(interests),
        "can_help": cite(can_help),
        "looking_for": cite(looking_for),
        "earlier": [],
    })
    .to_string()
}

/// Builds a card with exactly these topics.
pub(super) async fn build_card_with(
    app: &axum::Router,
    pool: &PgPool,
    account: &str,
    token: &str,
    reply: &str,
) {
    let (status, body) = send(
        app,
        "POST",
        "/v1/cloud/common-ground/card/build",
        token,
        Some(json!({"notes": "My work."})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    let run_id = claim(pool, account).await;
    complete(pool, &run_id, RUNNER, reply).await.unwrap();
}

pub(super) async fn build_card(
    app: &axum::Router,
    pool: &PgPool,
    account: &str,
    token: &str,
    working_on: &[&str],
) {
    let (status, body) = send(
        app,
        "POST",
        "/v1/cloud/common-ground/card/build",
        token,
        Some(json!({"notes": "I study agent memory. Mail me at ada@example.test", "links": "example.test/papers"})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["build"]["status"], "building");
    assert_eq!(body["used"], json!(["Links", "Notes"]));
    let run_id = claim(pool, account).await;
    complete(pool, &run_id, RUNNER, &reply(working_on, &["Hidden topic"]))
        .await
        .unwrap();
}

pub(super) fn free_code() -> String {
    format!("{:04}", rand::thread_rng().gen_range(0..10_000))
}

/// The open run of `kind` for this viewer or room, claimed by the runner,
/// with the account ids of the cards it read, in prompt order.
pub(super) async fn claim_open(
    pool: &PgPool,
    kind: &str,
    viewer: Option<&str>,
) -> (String, Vec<String>) {
    let (run_id, cards): (String, Value) = query_as(
        "SELECT run_id, cards_json FROM cloud_common_ground_match_runs
         WHERE kind = $1 AND ($2::text IS NULL OR viewer_account_id = $2) AND finished_at IS NULL
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(kind)
    .bind(viewer)
    .fetch_one(pool)
    .await
    .unwrap();
    let lease = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    claim_run(pool, &run_id, &lease).await;
    let ids = cards
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["accountId"].as_str().unwrap().to_string())
        .collect();
    (run_id, ids)
}

pub(super) async fn open_runs(pool: &PgPool, account: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_agent_fallback_runs WHERE requester_account_id = $1 AND run_id LIKE 'cg\\_%' AND run_id NOT LIKE 'cg\\_card\\_%' AND status = 'queued'",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}
