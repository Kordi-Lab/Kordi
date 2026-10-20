//! Matching: room results, match detail and Recent through the routes, with
//! a simulated runner answering the match and room-theme runs.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};

use super::db_fixture::{account, app, pool, send, signed_in};
use super::support::{build_card_with, card_reply, claim_open, free_code, open_runs, RUNNER};
use crate::common_ground::{complete, fail};

#[tokio::test]
async fn room_results_match_detail_and_recent() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let (priya, priya_token) = signed_in(&pool, "Priya").await;
    let (sam, sam_token) = signed_in(&pool, "Sam").await;
    let (_, outsider_token) = signed_in(&pool, "Outsider").await;
    build_card_with(
        &app,
        &pool,
        &alex,
        &alex_token,
        &card_reply(
            &["Agent memory"],
            &["Retrieval"],
            &["Eval design"],
            &["GPU access"],
        ),
    )
    .await;
    build_card_with(
        &app,
        &pool,
        &priya,
        &priya_token,
        &card_reply(
            &["Memory for agents"],
            &["Retrieval"],
            &["GPU clusters"],
            &["Eval design help"],
        ),
    )
    .await;
    build_card_with(
        &app,
        &pool,
        &sam,
        &sam_token,
        &card_reply(&["Robot grasping"], &["Control"], &[], &[]),
    )
    .await;
    let code = free_code();
    query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();
    for token in [&alex_token, &priya_token, &sam_token] {
        let (status, _) = send(
            &app,
            "POST",
            &format!("/v1/cloud/common-ground/rooms/{code}/join"),
            token,
            None,
        )
        .await;
        assert_eq!(status, 200);
    }
    let results = format!("/v1/cloud/common-ground/rooms/{code}/results");

    // The first request queues one match run for alex and one theme run for
    // the room; polling while they work queues nothing more.
    let (status, body) = send(&app, "POST", &results, &alex_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (body["status"].as_str(), body["people"].clone()),
        (Some("matching"), json!([]))
    );
    let (status, body) = send(&app, "POST", &results, &alex_token, None).await;
    assert_eq!((status, body["status"].as_str()), (200, Some("matching")));
    assert_eq!(
        open_runs(&pool, &alex).await,
        2,
        "one match run and one theme run"
    );
    let (status, _) = send(&app, "POST", &results, &outsider_token, None).await;
    assert_eq!(status, 404, "results are for members");

    let (run_id, cards) = claim_open(&pool, "match", Some(&alex)).await;
    let (owner,): (String,) =
        query_as("SELECT owner_account_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, service, "matching runs on the service key");
    assert_eq!(cards[0], alex, "the viewer's card comes first");
    let index = |id: &str| cards[1..].iter().position(|c| c == id).unwrap();
    let reply = json!({"people": [
        {"person": index(&priya),
         "shared": [
            {"mine": "agent  MEMORY", "theirs": "Memory for agents", "why": "Both study memory for agents"},
            {"mine": "Made up", "theirs": "Retrieval", "why": "Not on the card"},
            {"mine": "Retrieval", "theirs": "Retrieval", "why": "Both care about retrieval"}],
         "you_bring": [{"topic": "Eval design", "for": "Eval design help", "why": "Priya needs evals"},
                       {"topic": "Robot grasping", "for": "Retrieval", "why": "Not your skill"}],
         "they_bring": [{"topic": "GPU clusters", "for": "GPU access", "why": "You need compute"}],
         "next_step": "Compare memory benchmarks over coffee"},
        {"person": 99, "shared": [{"mine": "Agent memory", "theirs": "Memory for agents", "why": "x"}]}
    ]});
    complete(&pool, &run_id, RUNNER, &reply.to_string())
        .await
        .unwrap();

    let (room_run, members) = claim_open(&pool, "room", None).await;
    let at = |id: &str| members.iter().position(|m| m == id).unwrap();
    let themes = json!({"themes": [
        {"label": "Solo", "people": [at(&sam)]},
        {"label": "Agent memory", "people": [at(&priya), at(&alex), at(&alex)]},
    ]});
    complete(&pool, &room_run, RUNNER, &themes.to_string())
        .await
        .unwrap();
    let (cards_left,): (Value,) =
        query_as("SELECT cards_json FROM cloud_common_ground_match_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(cards_left, json!([]), "a finished run keeps no cards");

    // Sam was not mentioned: matched, with nothing in common.
    let (status, body) = send(&app, "POST", &results, &alex_token, None).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (200, Some("ready")),
        "{body}"
    );
    assert_eq!(body["people"][0]["person"]["accountId"], priya.as_str());
    assert_eq!(body["people"][0]["headline"], "Memory for agents");
    let priya_score = body["people"][0]["score"].as_i64().unwrap();
    assert!(priya_score > 50 && priya_score <= 100, "{priya_score}");
    assert_eq!(body["people"][1]["person"]["accountId"], sam.as_str());
    assert_eq!(
        (
            body["people"][1]["score"].as_i64(),
            body["people"][1]["headline"].as_str()
        ),
        (Some(0), Some("Different area"))
    );
    assert_eq!(
        body["topics"].as_array().unwrap().len(),
        1,
        "a theme needs two people"
    );
    assert_eq!(
        body["topics"][0]["people"][0]["accountId"],
        alex.as_str(),
        "you come first"
    );
    assert_eq!(body["suggestion"]["label"], "Agent memory");
    let (hints,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = 'common_ground.matches.updated'")
        .bind(&alex)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(hints, 1);

    // Match detail shows only checked pairs, and opening it adds to Recent.
    let (status, body) = send(
        &app,
        "GET",
        "/v1/cloud/common-ground/recent",
        &alex_token,
        None,
    )
    .await;
    assert_eq!((status, body["people"].clone()), (200, json!([])));
    let (status, body) = send(
        &app,
        "GET",
        &format!("/v1/cloud/common-ground/people/{priya}/match"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(
        (status, body["status"].as_str()),
        (200, Some("ready")),
        "{body}"
    );
    assert_eq!(
        body["shared"],
        json!([
            {"topic": "Agent memory", "theirTopic": "Memory for agents", "why": "Both study memory for agents"},
            {"topic": "Retrieval", "theirTopic": "Retrieval", "why": "Both care about retrieval"},
        ])
    );
    assert_eq!(
        body["youBring"],
        json!([{"topic": "Eval design", "for": "Eval design help", "why": "Priya needs evals"}])
    );
    assert_eq!(body["theyBring"][0]["topic"], "GPU clusters");
    assert_eq!(body["nextStep"], "Compare memory benchmarks over coffee");
    let (_, body) = send(
        &app,
        "GET",
        "/v1/cloud/common-ground/recent",
        &alex_token,
        None,
    )
    .await;
    assert_eq!(body["people"][0]["person"]["accountId"], priya.as_str());
    assert_eq!(body["people"][0]["score"].as_i64(), Some(priya_score));
    let (status, _) = send(
        &app,
        "GET",
        &format!("/v1/cloud/common-ground/people/{alex}/match"),
        &outsider_token,
        None,
    )
    .await;
    assert_eq!(
        status, 404,
        "only people who may see each other are matched"
    );

    // Each viewer gets their own match; a failure is reported, then retried.
    let detail = format!("/v1/cloud/common-ground/people/{alex}/match");
    let (status, body) = send(&app, "GET", &detail, &priya_token, None).await;
    assert_eq!((status, body["status"].as_str()), (202, Some("matching")));
    let (priya_run, _) = claim_open(&pool, "match", Some(&priya)).await;
    complete(&pool, &priya_run, RUNNER, "Sorry, I can't.")
        .await
        .unwrap();
    let (error,): (Option<String>,) =
        query_as("SELECT error_code FROM cloud_common_ground_match_runs WHERE run_id = $1")
            .bind(&priya_run)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(error.as_deref(), Some("invalid_output"));
    let (status, body) = send(&app, "GET", &detail, &priya_token, None).await;
    assert_eq!((status, body["status"].as_str()), (202, Some("failed")));
    query("UPDATE cloud_common_ground_match_runs SET finished_at = now() - interval '3 minutes' WHERE run_id = $1")
        .bind(&priya_run)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(&app, "GET", &detail, &priya_token, None).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (202, Some("matching")),
        "retried after the pause"
    );
    let (retry, _) = claim_open(&pool, "match", Some(&priya)).await;
    fail(&pool, &retry, Some(RUNNER), "provider_error")
        .await
        .unwrap();

    // A changed card makes its matches stale; sharing off leaves the results.
    let (status, _) = send(
        &app,
        "PUT",
        "/v1/cloud/common-ground/card/hidden",
        &priya_token,
        Some(json!({"hidden": ["GPU clusters"]})),
    )
    .await;
    assert_eq!(status, 200);
    send(
        &app,
        "PUT",
        "/v1/cloud/common-ground/settings",
        &sam_token,
        Some(json!({"sharing": false})),
    )
    .await;
    let (_, body) = send(&app, "POST", &results, &alex_token, None).await;
    assert_eq!(body["status"], "matching");
    assert_eq!(
        body["people"],
        json!([]),
        "priya is matched again; sam no longer shares"
    );
    let (_, cards) = claim_open(&pool, "match", Some(&alex)).await;
    assert_eq!(cards, vec![alex.clone(), priya.clone()]);
}
