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

/// Two people with cards in a fresh room. Returns the room code.
pub(super) async fn two_in_a_room(
    app: &axum::Router,
    pool: &PgPool,
    people: [(&str, &str); 2],
) -> String {
    let cards = [
        card_reply(&["Agent memory"], &["Retrieval"], &["Eval design"], &[]),
        card_reply(&["Memory for agents"], &["Retrieval"], &[], &[]),
    ];
    for ((account, token), reply) in people.iter().zip(&cards) {
        build_card_with(app, pool, account, token, reply).await;
    }
    let tokens: Vec<&str> = people.iter().map(|(_, token)| *token).collect();
    join_fresh_room(app, pool, &tokens).await
}

/// Opens a fresh room and joins everyone, in order. Each needs a shared card.
pub(super) async fn join_fresh_room(app: &axum::Router, pool: &PgPool, tokens: &[&str]) -> String {
    let code = free_code();
    query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(pool)
        .await
        .unwrap();
    for token in tokens {
        let (status, _) = send(
            app,
            "POST",
            &format!("/v1/cloud/common-ground/rooms/{code}/join"),
            token,
            None,
        )
        .await;
        assert_eq!(status, 200);
    }
    code
}

/// Answers the viewer's open match run with one shared topic for everyone.
pub(super) async fn answer_match(pool: &PgPool, viewer: &str) -> String {
    let (run_id, cards) = claim_open(pool, "match", Some(viewer)).await;
    let people: Vec<Value> = (0..cards.len() - 1)
        .map(|i| json!({"person": i, "shared": [{"mine": "Agent memory", "theirs": "Memory for agents", "why": "Same area"}], "next_step": "Meet"}))
        .collect();
    complete(
        pool,
        &run_id,
        RUNNER,
        &json!({ "people": people }).to_string(),
    )
    .await
    .unwrap();
    run_id
}

/// Signed-in people with cards in one fresh room, in join order, with the
/// app (PiP configured) and the room code.
pub(super) async fn people_in_a_room(
    pool: &PgPool,
    labels: &[&str],
) -> (axum::Router, String, Vec<(String, String)>) {
    use super::db_fixture::{account, app, signed_in};
    // PiP's account is process-wide once set, and member counts leave it out;
    // settle it first so a group's PiP is never counted as a person, even
    // when tests run in parallel.
    if crate::pip::service_account_id().is_none() {
        let candidate = account(pool, "service").await;
        crate::pip::PipService::new(crate::pip::test_config(&candidate));
    }
    let service = crate::pip::service_account_id().unwrap().to_string();
    let app = app(pool, Some(&service));
    let mut people = Vec::new();
    for label in labels {
        let (id, token) = signed_in(pool, label).await;
        let reply = card_reply(&["Agent memory"], &["Retrieval"], &[], &[]);
        build_card_with(&app, pool, &id, &token, &reply).await;
        people.push((id, token));
    }
    let tokens: Vec<&str> = people.iter().map(|(_, token)| token.as_str()).collect();
    let code = join_fresh_room(&app, pool, &tokens).await;
    (app, code, people)
}

/// Makes two accounts contacts directly, both ways.
pub(super) async fn make_contacts(pool: &PgPool, a: &str, b: &str) {
    for (owner, peer) in [(a, b), (b, a)] {
        query("INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3)")
            .bind(owner)
            .bind(peer)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(pool)
            .await
            .unwrap();
    }
}
