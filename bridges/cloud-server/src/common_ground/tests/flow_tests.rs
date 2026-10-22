//! End-to-end route tests: build a card through a simulated runner, meet in
//! a room and by pairing, and check who can see what.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};

use super::db_fixture::{account, app, pool, send, signed_in};
use super::support::{build_card, claim, free_code, RUNNER};
use crate::common_ground::{complete, fail, RUN_PREFIX};

#[tokio::test]
async fn cards_rooms_and_pairings() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let (priya, priya_token) = signed_in(&pool, "Priya").await;
    let (sam, sam_token) = signed_in(&pool, "Sam").await;
    let card = "/v1/cloud/common-ground/card";
    // Alex picked a public @handle; Priya has none.
    let handle = format!("alex{}", &alex[alex.len() - 20..]);
    query("UPDATE cloud_accounts SET public_handle = $2 WHERE account_id = $1")
        .bind(&alex)
        .bind(&handle)
        .execute(&pool)
        .await
        .unwrap();

    let (status, body) = send(&app, "GET", card, &alex_token, None).await;
    assert_eq!((status, body["card"].clone()), (200, Value::Null));
    assert_eq!(body["handle"], handle.as_str(), "owner card");
    let (_, body) = send(&app, "GET", card, &priya_token, None).await;
    assert_eq!(body["handle"], Value::Null);
    let (status, body) = send(
        &app,
        "POST",
        &format!("{card}/build"),
        &alex_token,
        Some(json!({})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("common_ground_no_sources"))
    );
    let code = free_code();
    query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();
    let join = format!("/v1/cloud/common-ground/rooms/{code}/join");
    let (status, body) = send(&app, "POST", &join, &alex_token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_no_card"))
    );

    // The build runs on the service account's key, with redacted evidence.
    let (status, _) = send(
        &app,
        "POST",
        &format!("{card}/build"),
        &alex_token,
        Some(json!({"notes": "x"})),
    )
    .await;
    assert_eq!(status, 202);
    let (status, body) = send(
        &app,
        "POST",
        &format!("{card}/build"),
        &alex_token,
        Some(json!({"notes": "x"})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_build_in_progress"))
    );
    let run_id = claim(&pool, &alex).await;
    assert!(run_id.starts_with(RUN_PREFIX));
    let (owner, requester): (String, String) = query_as(
        "SELECT owner_account_id, requester_account_id FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((owner, requester), (service.clone(), alex.clone()));
    complete(&pool, &run_id, RUNNER, "not a card")
        .await
        .unwrap();
    let (_, body) = send(&app, "GET", card, &alex_token, None).await;
    assert_eq!(
        body["build"],
        json!({"status": "failed", "errorCode": "invalid_output"})
    );

    build_card(&app, &pool, &alex, &alex_token, &["Agent memory"]).await;
    build_card(&app, &pool, &priya, &priya_token, &["Memory for agents"]).await;
    build_card(&app, &pool, &sam, &sam_token, &["Robot grasping"]).await;
    let (prompt,): (String,) = query_as(
        "SELECT prompt FROM cloud_agent_fallback_runs WHERE requester_account_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&alex)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        prompt.contains("[email]") && !prompt.contains("ada@example.test"),
        "{prompt}"
    );
    let (status, body) = send(&app, "GET", card, &alex_token, None).await;
    assert_eq!(status, 200);
    assert_eq!(body["card"]["workingOn"], json!(["Agent memory"]));
    assert_eq!(body["build"]["status"], "idle");
    assert_eq!(body["card"]["profile"]["evidence"]["e1"]["source"], "Link");
    assert_eq!(
        body["card"]["profile"]["evidence"]["e1"]["url"],
        "https://example.test/papers"
    );

    let (status, body) = send(
        &app,
        "PUT",
        &format!("{card}/hidden"),
        &alex_token,
        Some(json!({"hidden": ["Hidden topic", "Not mine"]})),
    )
    .await;
    assert_eq!(
        (status, body["card"]["hidden"].clone()),
        (200, json!(["Hidden topic"]))
    );

    // Rooms: the first to enter a free code opens and names it.
    let (status, body) = send(
        &app,
        "POST",
        &join,
        &alex_token,
        Some(json!({"name": "Poster   session"})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (body["name"].as_str(), body["openedByYou"].as_bool()),
        (Some("Poster session"), Some(true))
    );
    assert_eq!(body["members"], json!([]));
    let (status, body) = send(
        &app,
        "POST",
        &join,
        &priya_token,
        Some(json!({"name": "Ignored"})),
    )
    .await;
    assert_eq!(
        (status, body["name"].as_str(), body["openedByYou"].as_bool()),
        (200, Some("Poster session"), Some(false))
    );
    assert_eq!(body["members"][0]["accountId"], alex.as_str());
    assert_eq!(body["members"][0]["hasCard"], true);
    assert_eq!(body["members"][0]["handle"], handle.as_str());
    let room = format!("/v1/cloud/common-ground/rooms/{code}");
    let (_, body) = send(&app, "GET", &room, &alex_token, None).await;
    assert_eq!(body["members"][0]["name"], "Priya");
    assert_eq!(body["members"][0]["handle"], Value::Null);
    let (hints,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = 'common_ground.room.updated'")
        .bind(&alex)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(hints, 2, "alex hears both joins");

    // Room members see each other's topics, never hidden ones or references.
    let person = |id: &str| format!("/v1/cloud/common-ground/people/{id}");
    let (status, body) = send(&app, "GET", &person(&alex), &priya_token, None).await;
    assert_eq!(status, 200);
    assert_eq!(body["card"]["workingOn"], json!(["Agent memory"]));
    assert_eq!(body["card"]["canHelp"], json!([]));
    assert_eq!(body["person"]["handle"], handle.as_str());
    assert!(!body.to_string().contains("@example.test"), "no email");
    assert!(body["card"].get("profile").is_none() && !body.to_string().contains("evidence"));
    let (status, _) = send(&app, "GET", &person(&alex), &sam_token, None).await;
    assert_eq!(status, 404, "outsiders see nothing");
    let (status, _) = send(&app, "GET", &room, &sam_token, None).await;
    assert_eq!(status, 404, "the lobby is for members");

    // Pairing: a code works once, and pairs both ways.
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/common-ground/pairings/code",
        &alex_token,
        None,
    )
    .await;
    assert_eq!(status, 201);
    let pair_code = body["code"].as_str().unwrap().to_lowercase();
    let redeem = "/v1/cloud/common-ground/pairings/redeem";
    let (status, _) = send(
        &app,
        "POST",
        redeem,
        &alex_token,
        Some(json!({"code": pair_code})),
    )
    .await;
    assert_eq!(status, 404, "your own code does not pair you with yourself");
    let (status, body) = send(
        &app,
        "POST",
        redeem,
        &sam_token,
        Some(json!({"code": pair_code})),
    )
    .await;
    assert_eq!(
        (status, body["person"]["accountId"].as_str()),
        (200, Some(alex.as_str()))
    );
    let (status, _) = send(
        &app,
        "POST",
        redeem,
        &priya_token,
        Some(json!({"code": pair_code})),
    )
    .await;
    assert_eq!(status, 404, "a code works once");
    let (status, _) = send(&app, "GET", &person(&sam), &alex_token, None).await;
    assert_eq!(status, 200);
    let (_, body) = send(
        &app,
        "GET",
        "/v1/cloud/common-ground/pairings",
        &alex_token,
        None,
    )
    .await;
    assert_eq!(body["people"][0]["accountId"], sam.as_str());

    // Sharing off hides the card everywhere and blocks new meetings.
    let settings = "/v1/cloud/common-ground/settings";
    send(
        &app,
        "PUT",
        settings,
        &alex_token,
        Some(json!({"sharing": false})),
    )
    .await;
    let (status, _) = send(&app, "GET", &person(&alex), &priya_token, None).await;
    assert_eq!(status, 404);
    let (status, body) = send(&app, "POST", &join, &alex_token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_sharing_off"))
    );
    send(
        &app,
        "PUT",
        settings,
        &alex_token,
        Some(json!({"sharing": true})),
    )
    .await;

    // A room closes a day after its last join; the code then opens a new one.
    query("UPDATE cloud_common_ground_rooms SET last_join_at = now() - interval '25 hours' WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(&app, "GET", &room, &priya_token, None).await;
    assert_eq!(
        (status, &body["open"]),
        (200, &json!(false)),
        "members keep a closed room, read-only"
    );
    let (status, _) = send(&app, "GET", &person(&alex), &priya_token, None).await;
    assert_eq!(
        status, 200,
        "members of an expired room still see each other"
    );
    let (status, body) = send(&app, "POST", &join, &priya_token, None).await;
    assert_eq!(
        (
            status,
            body["openedByYou"].as_bool(),
            body["members"].clone()
        ),
        (200, Some(true), json!([]))
    );

    // Editing: typed topics get an "Added by you" reference.
    let (status, body) = send(&app, "PUT", card, &alex_token, Some(json!({
        "workingOn": ["Agent memory", "Eval design"],
        "interests": ["Retrieval", "retrieval", "A typed topic that is far longer than forty characters"],
        "canHelp": [],
        "lookingFor": [],
    }))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["card"]["workingOn"],
        json!(["Agent memory", "Eval design"])
    );
    assert_eq!(body["card"]["interests"], json!(["Retrieval"]));
    assert_eq!(
        body["card"]["hidden"],
        json!([]),
        "a removed topic is no longer hidden"
    );
    let profile = &body["card"]["profile"];
    let added = profile["topics"]["Eval design"]["refs"][0]
        .as_str()
        .unwrap();
    assert_eq!(profile["evidence"][added]["source"], "Added by you");

    // Deleting the card leaves every room.
    let (_, body) = send(&app, "POST", &join, &sam_token, None).await;
    assert_eq!(body["members"][0]["accountId"], priya.as_str());
    let (status, body) = send(&app, "DELETE", card, &sam_token, None).await;
    assert_eq!((status, body["card"].clone()), (200, Value::Null));
    let (_, body) = send(&app, "GET", &room, &priya_token, None).await;
    assert_eq!(body["members"], json!([]));
    let (status, _) = send(&app, "GET", &person(&sam), &alex_token, None).await;
    assert_eq!(status, 404, "a deleted card is gone even for pairings");
}

#[tokio::test]
async fn failed_builds_and_servers_without_the_service_key() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let (status, body) = send(
        &app(&pool, None),
        "POST",
        "/v1/cloud/common-ground/card/build",
        &alex_token,
        Some(json!({"notes": "x"})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (503, Some("common_ground_unavailable"))
    );

    let app = app(&pool, Some(&service));
    let (status, _) = send(
        &app,
        "POST",
        "/v1/cloud/common-ground/card/build",
        &alex_token,
        Some(json!({"notes": "x"})),
    )
    .await;
    assert_eq!(status, 202);
    let run_id = claim(&pool, &alex).await;
    fail(&pool, &run_id, Some(RUNNER), "missing_provider_auth")
        .await
        .unwrap();
    let (_, body) = send(
        &app,
        "GET",
        "/v1/cloud/common-ground/card",
        &alex_token,
        None,
    )
    .await;
    assert_eq!(
        body["build"],
        json!({"status": "failed", "errorCode": "missing_provider_auth"})
    );
    let (status, _) = send(
        &app,
        "POST",
        "/v1/cloud/common-ground/card/build",
        &alex_token,
        Some(json!({"notes": "x"})),
    )
    .await;
    assert_eq!(status, 202, "a failed build can be retried");
}
