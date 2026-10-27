//! School interests must not become affiliation matches or alerts.

use serde_json::json;
use sqlx_core::query::query;

use super::db_fixture::{pool, send};
use super::nearby_support::{
    alert_hints, alerts_to, claim_check, locate, located, need, north, participant, pending, setup,
    spot, status_of, sweep, PEOPLE,
};
use super::support::{card_reply, RUNNER};

#[tokio::test]
async fn school_interest_does_not_match_or_alert_as_affiliation() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, service) = setup(&pool).await;
    let here = spot();
    let (viewer, token) = located(&app, &pool, "Viewer", here).await;
    let (other, other_token) = participant(
        &app,
        &pool,
        "SchoolEnthusiast",
        &card_reply(&[], &["Fudan"], &[], &[]),
    )
    .await;
    assert_eq!(locate(&app, &other_token, north(here, 200.0)).await.0, 200);
    let need_id = need(&app, &token, json!({"text": "Coffee with a Fudan alum"})).await;
    sweep(&pool, &service).await;
    let (run, candidates) = claim_check(&pool, &viewer).await;
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].1, other);
    let checks = json!({
        "conditions": ["Is a Fudan alum", "Wants a coffee chat"],
        "checks": [
            {"condition": 0, "verdict": "met", "kind": "affiliation", "evidence": "Fudan"},
            {"condition": 1, "verdict": "met", "kind": "willingness", "evidence": "Coffee chat"},
        ],
    });
    let reply = json!({
        "conditions": checks["conditions"],
        "people": [{"ref": candidates[0].0, "checks": checks["checks"]}],
    });
    crate::common_ground::complete(&pool, &run, RUNNER, &reply.to_string())
        .await
        .unwrap();
    let (status, person) = send(&app, "GET", &format!("{PEOPLE}/{other}"), &token, None).await;
    assert_eq!(status, 200, "{person}");
    assert_eq!(person["requests"][0]["met"], false, "{person}");
    assert_eq!(person["requests"][0]["checks"][0]["verdict"], "unknown");
    sweep(&pool, &service).await;
    assert!(alerts_to(&pool, &viewer).await.is_empty());
    assert_eq!(alert_hints(&pool, &viewer).await, 0);

    // A verdict stored before the stricter rule must be revalidated at read
    // and delivery time, even when the card and request revisions still match.
    query(
        "UPDATE cloud_common_ground_nearby_verdicts SET met = true, checks_json = $2
         WHERE need_id = $1",
    )
    .bind(&need_id)
    .bind(&checks)
    .execute(&pool)
    .await
    .unwrap();
    let alert = pending(&pool, &viewer, &other, Some((&need_id, 1))).await;
    let (status, person) = send(&app, "GET", &format!("{PEOPLE}/{other}"), &token, None).await;
    assert_eq!(status, 200, "{person}");
    assert_eq!(person["requests"][0]["met"], false, "{person}");
    sweep(&pool, &service).await;
    assert_eq!(
        status_of(&pool, &alert).await,
        ("invalidated".into(), Some("verdict".into()))
    );
    assert_eq!(alert_hints(&pool, &viewer).await, 0);
}
