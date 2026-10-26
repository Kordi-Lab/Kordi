//! Helpers for the nearby database tests. Every test puts its people at a
//! random spot, so people other tests left behind are never in range.

use axum::Router;
use rand::Rng;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, send, signed_in};
use super::support::{build_card_with, card_reply, claim_run, RUNNER};
use crate::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use crate::common_ground::nearby::{distance::round3, sweep_once, Outcome};

pub(super) const NEARBY: &str = "/v1/cloud/common-ground/nearby";
pub(super) const PEOPLE: &str = "/v1/cloud/common-ground/nearby/people";
pub(super) const NEEDS: &str = "/v1/cloud/common-ground/nearby/needs";

/// Meters per degree of latitude on the haversine sphere.
const METERS_PER_DEGREE: f64 = 111_194.93;

/// The app with PiP configured, and the service account it runs as.
pub(super) async fn setup(pool: &PgPool) -> (Router, String) {
    let service = account(pool, "service").await;
    (app(pool, Some(&service)), service)
}

/// A random spot, rounded as stored.
pub(super) fn spot() -> (f64, f64) {
    let mut rng = rand::thread_rng();
    (
        round3(rng.gen_range(-50.0..50.0)),
        round3(rng.gen_range(-170.0..170.0)),
    )
}

/// The point `meters` north of `at`.
pub(super) fn north((lat, lon): (f64, f64), meters: f64) -> (f64, f64) {
    (lat + meters / METERS_PER_DEGREE, lon)
}

/// A signed-in person with a built card who has turned Nearby on.
pub(super) async fn participant(
    app: &Router,
    pool: &PgPool,
    label: &str,
    reply: &str,
) -> (String, String) {
    let (id, token) = signed_in(pool, label).await;
    build_card_with(app, pool, &id, &token, reply).await;
    let (status, body) = send(
        app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"enabled": true, "consent": true, "openTo": ["Coffee chat"]})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    (id, token)
}

pub(super) fn memory_card() -> String {
    card_reply(&["Agent memory"], &["Retrieval"], &["Eval design"], &[])
}

/// Posts the calling device's location, captured now.
pub(super) async fn locate(app: &Router, token: &str, (lat, lon): (f64, f64)) -> (u16, Value) {
    let body = json!({
        "latitude": lat,
        "longitude": lon,
        "accuracy": 25.0,
        "capturedAt": chrono::Utc::now().to_rfc3339(),
    });
    send(
        app,
        "POST",
        &format!("{NEARBY}/location"),
        token,
        Some(body),
    )
    .await
}

/// A participant at `at`.
pub(super) async fn located(
    app: &Router,
    pool: &PgPool,
    label: &str,
    at: (f64, f64),
) -> (String, String) {
    let (id, token) = participant(app, pool, label, &memory_card()).await;
    let (status, body) = locate(app, &token, at).await;
    assert_eq!(status, 200, "{body}");
    (id, token)
}

/// The account ids listed by a search, in order.
pub(super) fn listed(body: &Value) -> Vec<String> {
    body["people"]
        .as_array()
        .map(|people| {
            people
                .iter()
                .map(|p| {
                    p["person"]["accountId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string()
                })
                .collect()
        })
        .unwrap_or_default()
}

/// (profile id, card revision) of the account's only profile.
pub(super) async fn card_of(pool: &PgPool, account: &str) -> (String, i64) {
    query_as("SELECT profile_id, revision FROM cloud_common_ground_cards WHERE account_id = $1")
        .bind(account)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Stores a current match from `viewer` to `other` with this score.
pub(super) async fn store_match(pool: &PgPool, viewer: &str, other: &str, score: i64) {
    let (viewer_profile, viewer_revision) = card_of(pool, viewer).await;
    let (other_profile, other_revision) = card_of(pool, other).await;
    let result = json!({
        "score": score, "headline": format!("Score {score}"), "shared": [],
        "youBring": [], "theyBring": [], "nextStep": "Say hello",
    });
    query(
        "INSERT INTO cloud_common_ground_matches
             (viewer_account_id, other_account_id, viewer_profile_id, other_profile_id,
              viewer_revision, other_revision, result_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (viewer_profile_id, other_profile_id) DO UPDATE SET
             viewer_revision = EXCLUDED.viewer_revision, other_revision = EXCLUDED.other_revision,
             result_json = EXCLUDED.result_json",
    )
    .bind(viewer)
    .bind(other)
    .bind(&viewer_profile)
    .bind(&other_profile)
    .bind(viewer_revision)
    .bind(other_revision)
    .bind(result)
    .execute(pool)
    .await
    .unwrap();
}

/// The newest open check run of `account`'s requests, claimed by the
/// runner, with the account id behind each reference.
pub(super) async fn claim_check(pool: &PgPool, account: &str) -> (String, Vec<(String, String)>) {
    let (run_id, candidates): (String, Value) = query_as(
        "SELECT run_id, candidates_json FROM cloud_common_ground_nearby_need_runs
         WHERE account_id = $1 AND finished_at IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .unwrap();
    let lease = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    claim_run(pool, &run_id, &lease).await;
    let refs = candidates
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["ref"].as_str().unwrap().to_string(),
                c["accountId"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    (run_id, refs)
}

/// Answers `account`'s open check: everyone the run read meets both
/// conditions (an interest on the card and the "Coffee chat" they are open
/// to).
pub(super) async fn answer_check(pool: &PgPool, account: &str) -> Vec<String> {
    let (run_id, refs) = claim_check(pool, account).await;
    let people: Vec<Value> = refs
        .iter()
        .map(|(reference, _)| {
            json!({"ref": reference, "checks": [
                {"condition": 0, "verdict": "met", "kind": "interest", "evidence": "Retrieval"},
                {"condition": 1, "verdict": "met", "kind": "willingness", "evidence": "Coffee chat"},
            ]})
        })
        .collect();
    let reply =
        json!({"conditions": ["Works on retrieval", "Wants a coffee chat"], "people": people});
    crate::common_ground::complete(pool, &run_id, RUNNER, &reply.to_string())
        .await
        .unwrap();
    refs.into_iter().map(|(_, account)| account).collect()
}

/// One sweep with the test service and no push service.
pub(super) async fn sweep(pool: &PgPool, service: &str) -> Vec<(String, Outcome)> {
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::production());
    sweep_once(
        pool,
        &crate::system_agent::test_config(service),
        &limiter,
        None,
    )
    .await
    .unwrap()
}

/// (kind, status, reason) of every alert to `recipient`, oldest first.
pub(super) async fn alerts_to(
    pool: &PgPool,
    recipient: &str,
) -> Vec<(String, String, Option<String>, String)> {
    query_as(
        "SELECT kind, status, reason, other_account_id FROM cloud_common_ground_nearby_alerts
         WHERE recipient_account_id = $1 ORDER BY created_at, alert_id",
    )
    .bind(recipient)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// Creates a request for `token`'s account and returns its id.
pub(super) async fn need(app: &Router, token: &str, body: Value) -> String {
    let (status, created) = send(app, "POST", NEEDS, token, Some(body)).await;
    assert_eq!(status, 201, "{created}");
    created["needId"].as_str().unwrap().to_string()
}

pub(super) async fn mark_dirty(pool: &PgPool, account: &str) {
    query("UPDATE cloud_common_ground_nearby SET dirty_at = now() WHERE account_id = $1")
        .bind(account)
        .execute(pool)
        .await
        .unwrap();
}

/// How many locations the account has stored.
pub(super) async fn locations(pool: &sqlx_postgres::PgPool, account: &str) -> i64 {
    let (count,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_common_ground_nearby_locations WHERE account_id = $1")
            .bind(account)
            .fetch_one(pool)
            .await
            .unwrap();
    count
}

/// Queues an alert directly, as the sweep would, and returns its id.
pub(super) async fn pending(
    pool: &PgPool,
    recipient: &str,
    other: &str,
    need: Option<(&str, i64)>,
) -> String {
    let id = format!("cgna_{}", uuid::Uuid::new_v4().simple());
    let (profile, _) = card_of(pool, other).await;
    query(
        "INSERT INTO cloud_common_ground_nearby_alerts
             (alert_id, recipient_account_id, other_account_id, other_profile_id, kind, need_id,
              need_revision, score, distance_max_m)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 500)",
    )
    .bind(&id)
    .bind(recipient)
    .bind(other)
    .bind(&profile)
    .bind(if need.is_some() { "need" } else { "match" })
    .bind(need.map(|(id, _)| id))
    .bind(need.map(|(_, revision)| revision))
    .bind(need.is_none().then_some(90))
    .execute(pool)
    .await
    .unwrap();
    id
}

pub(super) async fn status_of(pool: &PgPool, alert: &str) -> (String, Option<String>) {
    query_as("SELECT status, reason FROM cloud_common_ground_nearby_alerts WHERE alert_id = $1")
        .bind(alert)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Realtime alert hints the account got.
pub(super) async fn alert_hints(pool: &PgPool, account: &str) -> i64 {
    let (count,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = 'common_ground.nearby.alert'")
        .bind(account)
        .fetch_one(pool)
        .await
        .unwrap();
    count
}

/// Moves the alerts from `recipient` about `other` back in time.
pub(super) async fn backdate(pool: &PgPool, recipient: &str, other: &str, interval: &str) {
    let sql = format!(
        "UPDATE cloud_common_ground_nearby_alerts SET created_at = created_at - interval '{interval}',
             delivered_at = delivered_at - interval '{interval}'
         WHERE recipient_account_id = $1 AND other_account_id = $2"
    );
    query(&sql)
        .bind(recipient)
        .bind(other)
        .execute(pool)
        .await
        .unwrap();
}
