//! Matching regressions: stale, unshared and hidden scores in Recent, polling
//! charges, and late run failures.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};

use super::db_fixture::{account, app, pool, send, signed_in};
use super::support::{answer_match, card_reply, claim, claim_open, two_in_a_room, RUNNER};
use crate::common_ground::{complete, fail};

async fn recent_first(app: &axum::Router, token: &str) -> Value {
    let (status, body) = send(app, "GET", "/v1/cloud/common-ground/recent", token, None).await;
    assert_eq!(status, 200, "{body}");
    body["people"][0].clone()
}

#[tokio::test]
async fn recent_hides_scores_that_are_stale_unshared_or_no_longer_visible() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let (priya, priya_token) = signed_in(&pool, "Priya").await;
    let code = two_in_a_room(&app, &pool, [(&alex, &alex_token), (&priya, &priya_token)]).await;
    let detail = format!("/v1/cloud/common-ground/people/{priya}/match");
    let (status, _) = send(&app, "GET", &detail, &alex_token, None).await;
    assert_eq!(status, 202);
    answer_match(&pool, &alex).await;
    let (status, body) = send(&app, "GET", &detail, &alex_token, None).await;
    assert_eq!(status, 200, "{body}");
    let entry = recent_first(&app, &alex_token).await;
    assert_eq!(entry["person"]["accountId"], priya.as_str());
    assert!(entry["score"].as_i64().unwrap() > 0);
    assert_eq!(entry["headline"], "Memory for agents");

    // Sharing off, even without a new revision, hides the stored match.
    let set_sharing = |on: bool| {
        query("UPDATE cloud_common_ground_cards SET sharing_enabled = $2 WHERE account_id = $1")
            .bind(priya.clone())
            .bind(on)
    };
    set_sharing(false).execute(&pool).await.unwrap();
    let entry = recent_first(&app, &alex_token).await;
    assert_eq!(
        entry["person"]["accountId"],
        priya.as_str(),
        "the person stays in Recent"
    );
    assert_eq!(
        (entry["score"].clone(), entry["headline"].clone()),
        (Value::Null, Value::Null)
    );
    set_sharing(true).execute(&pool).await.unwrap();
    assert!(recent_first(&app, &alex_token).await["score"].is_i64());

    // A person you can no longer see keeps their place without the match.
    let (status, _) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/leave"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 204);
    let entry = recent_first(&app, &alex_token).await;
    assert_eq!(
        (entry["score"].clone(), entry["headline"].clone()),
        (Value::Null, Value::Null)
    );
    let (status, _) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/join"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert!(recent_first(&app, &alex_token).await["score"].is_i64());

    // Either card changing makes the stored match stale.
    let (status, _) = send(
        &app,
        "PUT",
        "/v1/cloud/common-ground/card/hidden",
        &alex_token,
        Some(json!({"hidden": ["Retrieval"]})),
    )
    .await;
    assert_eq!(status, 200);
    let entry = recent_first(&app, &alex_token).await;
    assert_eq!(
        (entry["score"].clone(), entry["headline"].clone()),
        (Value::Null, Value::Null)
    );
}

#[tokio::test]
async fn polling_while_a_run_works_or_pauses_is_not_charged() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let (priya, priya_token) = signed_in(&pool, "Priya").await;
    let code = two_in_a_room(&app, &pool, [(&alex, &alex_token), (&priya, &priya_token)]).await;
    // More polls than the hourly budget of 60 queued runs.
    const POLLS: usize = 70;

    // Match detail: open run, then the pause after a failure.
    let detail = format!("/v1/cloud/common-ground/people/{alex}/match");
    for _ in 0..POLLS {
        let (status, body) = send(&app, "GET", &detail, &priya_token, None).await;
        assert_eq!(
            (status, body["status"].as_str()),
            (202, Some("matching")),
            "{body}"
        );
    }
    let (run_id, _) = claim_open(&pool, "match", Some(&priya)).await;
    fail(&pool, &run_id, Some(RUNNER), "provider_error")
        .await
        .unwrap();
    for _ in 0..POLLS {
        let (status, body) = send(&app, "GET", &detail, &priya_token, None).await;
        assert_eq!(
            (status, body["status"].as_str()),
            (202, Some("failed")),
            "{body}"
        );
    }

    // Room results: open runs, then the pause after a failure.
    let results = format!("/v1/cloud/common-ground/rooms/{code}/results");
    for _ in 0..POLLS {
        let (status, body) = send(&app, "POST", &results, &alex_token, None).await;
        assert_eq!(
            (status, body["status"].as_str()),
            (200, Some("matching")),
            "{body}"
        );
    }
    let (match_run, _) = claim_open(&pool, "match", Some(&alex)).await;
    fail(&pool, &match_run, Some(RUNNER), "provider_error")
        .await
        .unwrap();
    let (room_run, _) = claim_open(&pool, "room", None).await;
    fail(&pool, &room_run, Some(RUNNER), "provider_error")
        .await
        .unwrap();
    for _ in 0..POLLS {
        let (status, body) = send(&app, "POST", &results, &alex_token, None).await;
        assert_eq!(
            (status, body["status"].as_str()),
            (200, Some("failed")),
            "{body}"
        );
    }
    // Only the queued runs were charged, so a retry after the pause queues.
    query("UPDATE cloud_common_ground_match_runs SET finished_at = now() - interval '3 minutes' WHERE run_id = ANY($1)")
        .bind(vec![match_run, room_run])
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(&app, "POST", &results, &alex_token, None).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (200, Some("matching")),
        "{body}"
    );
}

#[tokio::test]
async fn a_late_failure_does_not_undo_or_block_a_run() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let (priya, priya_token) = signed_in(&pool, "Priya").await;
    two_in_a_room(&app, &pool, [(&alex, &alex_token), (&priya, &priya_token)]).await;
    let detail = format!("/v1/cloud/common-ground/people/{priya}/match");
    let error_code = |run_id: String| {
        let pool = pool.clone();
        async move {
            let (finished, error): (bool, Option<String>) = query_as(
                "SELECT finished_at IS NOT NULL, error_code FROM cloud_common_ground_match_runs WHERE run_id = $1",
            )
            .bind(run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            (finished, error)
        }
    };

    // A failure reported after the run completed changes nothing.
    send(&app, "GET", &detail, &alex_token, None).await;
    let done = answer_match(&pool, &alex).await;
    fail(&pool, &done, Some(RUNNER), "provider_error")
        .await
        .unwrap();
    fail(&pool, &done, None, "provider_error").await.unwrap();
    assert_eq!(error_code(done).await, (true, None));
    let (status, _) = send(&app, "GET", &detail, &alex_token, None).await;
    assert_eq!(status, 200, "the completed match stands");

    // A runner that lost its lease cannot fail the run its successor holds.
    send(
        &app,
        "PUT",
        "/v1/cloud/common-ground/card/hidden",
        &priya_token,
        Some(json!({"hidden": ["Retrieval"]})),
    )
    .await;
    let (status, _) = send(&app, "GET", &detail, &alex_token, None).await;
    assert_eq!(status, 202);
    let (run_id, _) = claim_open(&pool, "match", Some(&alex)).await;
    fail(&pool, &run_id, Some("cg-old-runner"), "lease_lost")
        .await
        .unwrap();
    assert_eq!(error_code(run_id.clone()).await, (false, None));
    let reply = json!({"people": [{"person": 0, "shared": [{"mine": "Agent memory", "theirs": "Memory for agents", "why": "Same area"}]}]});
    complete(&pool, &run_id, RUNNER, &reply.to_string())
        .await
        .unwrap();
    assert_eq!(error_code(run_id).await, (true, None));

    // The same holds for card builds.
    let (status, _) = send(
        &app,
        "POST",
        "/v1/cloud/common-ground/card/build",
        &alex_token,
        Some(json!({"notes": "My work."})),
    )
    .await;
    assert_eq!(status, 202);
    let build = claim(&pool, &alex).await;
    fail(&pool, &build, Some("cg-old-runner"), "lease_lost")
        .await
        .unwrap();
    complete(
        &pool,
        &build,
        RUNNER,
        &card_reply(&["Agent memory"], &["Retrieval"], &[], &[]),
    )
    .await
    .unwrap();
    fail(&pool, &build, Some(RUNNER), "provider_error")
        .await
        .unwrap();
    let (status, body) = send(
        &app,
        "GET",
        "/v1/cloud/common-ground/card",
        &alex_token,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["build"]["errorCode"], Value::Null, "{body}");
    assert_eq!(body["card"]["workingOn"], json!(["Agent memory"]));
}
