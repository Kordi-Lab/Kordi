//! Nearby requests: validation, revisions, and checks through a simulated
//! runner.

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};

use super::db_fixture::{pool, send, signed_in};
use super::nearby_support::{
    answer_check, claim_check, located, need, north, setup, spot, store_match, NEEDS, PEOPLE,
};
use super::support::{open_runs, RUNNER};

fn iso(offset: Duration) -> String {
    (Utc::now() + offset).to_rfc3339()
}

#[tokio::test]
async fn requests_are_validated_and_revised() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let (_, token) = signed_in(&pool, "Ada").await;
    let (_, other_token) = signed_in(&pool, "Ben").await;
    let invalid = Some("common_ground_nearby_invalid_need");
    for bad in [
        json!({}),
        json!({"text": "  "}),
        json!({"text": "x".repeat(201)}),
        json!({"text": "Coffee", "range": 300}),
        json!({"text": "Coffee", "endsAt": iso(-Duration::minutes(5))}),
        json!({"text": "Coffee", "endsAt": iso(Duration::days(8))}),
        json!({"text": "Coffee", "startsAt": iso(Duration::hours(2)), "endsAt": iso(Duration::hours(1))}),
        json!({"text": 7}),
    ] {
        let (status, body) = send(&app, "POST", NEEDS, &token, Some(bad.clone())).await;
        assert_eq!(
            (status, body["errorCode"].as_str()),
            (422, invalid),
            "{bad}"
        );
    }
    let window = json!({
        "text": "  Coffee with a Fudan or SJTU alum ", "range": 1000,
        "startsAt": iso(Duration::hours(1)), "endsAt": iso(Duration::hours(4)),
    });
    let (status, created) = send(&app, "POST", NEEDS, &token, Some(window)).await;
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["text"], "Coffee with a Fudan or SJTU alum");
    assert_eq!(
        (created["status"].clone(), created["revision"].clone()),
        (json!("scheduled"), json!(1))
    );
    let id = created["needId"].as_str().unwrap().to_string();
    assert!(id.starts_with("cgn_") && id.len() == 36);
    let path = format!("{NEEDS}/{id}");
    // The default range is the account's.
    let open = need(&app, &token, json!({"text": "Someone founding a startup"})).await;

    let (status, body) = send(&app, "PUT", &path, &token, Some(json!({"startsAt": null}))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (body["status"].clone(), body["revision"].clone()),
        (json!("active"), json!(2))
    );
    let (_, body) = send(&app, "PUT", &path, &token, Some(json!({"paused": true}))).await;
    assert_eq!(
        (body["status"].clone(), body["revision"].clone()),
        (json!("paused"), json!(2)),
        "pausing is no new revision"
    );
    let (_, body) = send(
        &app,
        "PUT",
        &path,
        &token,
        Some(json!({"paused": false, "endsAt": null})),
    )
    .await;
    assert_eq!(
        (body["endsAt"].clone(), body["revision"].clone()),
        (json!(null), json!(3))
    );
    let (status, body) = send(
        &app,
        "PUT",
        &path,
        &token,
        Some(json!({"endsAt": iso(Duration::days(9))})),
    )
    .await;
    assert_eq!((status, body["errorCode"].as_str()), (422, invalid));
    let (status, body) = send(
        &app,
        "PUT",
        &path,
        &other_token,
        Some(json!({"paused": true})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (404, Some("common_ground_nearby_need_not_found"))
    );
    let (status, _) = send(&app, "DELETE", &path, &other_token, None).await;
    assert_eq!(status, 404);

    let (_, list) = send(&app, "GET", NEEDS, &token, None).await;
    let ids: Vec<&str> = list["needs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["needId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [open.as_str(), id.as_str()], "newest first");
    assert_eq!(list["needs"][0]["range"], 2000);
    let (_, list) = send(&app, "GET", NEEDS, &other_token, None).await;
    assert_eq!(list["needs"], json!([]));

    for n in 2..10 {
        need(&app, &token, json!({"text": format!("Request {n}")})).await;
    }
    let (status, body) = send(
        &app,
        "POST",
        NEEDS,
        &token,
        Some(json!({"text": "One too many"})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_nearby_too_many_needs"))
    );
    assert_eq!(send(&app, "DELETE", &path, &token, None).await.0, 204);
    assert_eq!(send(&app, "DELETE", &path, &token, None).await.0, 404);
    assert_eq!(
        send(
            &app,
            "POST",
            NEEDS,
            &token,
            Some(json!({"text": "Fits again"}))
        )
        .await
        .0,
        201
    );
}

async fn verdict_revisions(pool: &sqlx_postgres::PgPool, need_id: &str) -> Vec<(i64, bool)> {
    query_as(
        "SELECT need_revision, met FROM cloud_common_ground_nearby_verdicts WHERE need_id = $1",
    )
    .bind(need_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn checks_store_validated_verdicts_for_the_current_revision() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&app, &pool, "Viewer", here).await;
    let (maya, _) = located(&app, &pool, "Maya", north(here, 250.0)).await;
    let (sam, _) = located(&app, &pool, "Sam", north(here, 900.0)).await;
    let need_id = need(
        &app,
        &token,
        json!({"text": "Retrieval people up for coffee", "range": 500}),
    )
    .await;
    let (_, body) = send(&app, "GET", PEOPLE, &token, None).await;
    assert_eq!(body["people"].as_array().unwrap().len(), 2);
    // Only Maya is in the request's range, so only Maya is checked.
    let (run_id, refs) = claim_check(&pool, &me).await;
    assert!(run_id.starts_with("cg_need_"));
    assert_eq!(refs, vec![("p1".to_string(), maya.clone())]);
    let (prompt, system): (String, String) =
        query_as("SELECT prompt, system_prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        prompt.contains("Request: Retrieval people up for coffee")
            && prompt.contains("Open to: Coffee chat")
    );
    assert!(
        !prompt.contains(&maya) && !prompt.contains("Maya"),
        "no ids or names: {prompt}"
    );
    assert!(system.contains("at most 4 short conditions"));
    // An interest cannot prove willingness: that check is downgraded.
    let reply = json!({"conditions": ["Works on retrieval", "Wants a coffee chat"], "people": [{"ref": "p1", "checks": [
        {"condition": 0, "verdict": "met", "kind": "interest", "evidence": "Retrieval"},
        {"condition": 1, "verdict": "met", "kind": "willingness", "evidence": "Retrieval"},
    ]}]});
    crate::common_ground::complete(&pool, &run_id, RUNNER, &reply.to_string())
        .await
        .unwrap();
    assert_eq!(verdict_revisions(&pool, &need_id).await, vec![(1, false)]);
    let (_, run): (Option<chrono::DateTime<Utc>>, Value) = query_as(
        "SELECT finished_at, candidates_json FROM cloud_common_ground_nearby_need_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        run,
        json!([]),
        "the material is dropped when the run finishes"
    );
    let (hints,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = 'common_ground.nearby.updated'")
        .bind(&me)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(hints >= 1);
    let person = format!("{PEOPLE}/{maya}");
    let (_, body) = send(&app, "GET", &person, &token, None).await;
    let checks = &body["requests"][0];
    assert_eq!(
        (checks["needId"].clone(), checks["met"].clone()),
        (json!(need_id), json!(false))
    );
    assert_eq!(
        checks["checks"][0],
        json!({"condition": 0, "label": "Works on retrieval", "verdict": "met", "kind": "interest", "evidence": "Retrieval"})
    );
    assert_eq!(checks["checks"][1]["verdict"], "unknown");

    // A new revision makes the verdict obsolete and checks again.
    let path = format!("{NEEDS}/{need_id}");
    send(
        &app,
        "PUT",
        &path,
        &token,
        Some(json!({"text": "Retrieval people for coffee", "range": 1000})),
    )
    .await;
    send(&app, "GET", PEOPLE, &token, None).await;
    let (_, body) = send(&app, "GET", &person, &token, None).await;
    assert_eq!(body["requests"], json!([]));
    let checked = answer_check(&pool, &me).await;
    assert_eq!(checked.len(), 2, "both are in the new range");
    let mut revisions = verdict_revisions(&pool, &need_id).await;
    revisions.sort();
    assert_eq!(revisions, vec![(2, true), (2, true)]);
    let (_, body) = send(&app, "GET", PEOPLE, &token, None).await;
    let first = &body["people"][0];
    assert_eq!(first["requests"][0]["needId"], need_id);
    let (_, body) = send(&app, "GET", &person, &token, None).await;
    assert_eq!(body["requests"][0]["met"], true);
    assert_eq!(body["requests"][0]["checks"][1]["evidence"], "Coffee chat");

    // Maya stops being open to a coffee chat: the stored verdict no longer
    // holds, though her card did not change.
    query("UPDATE cloud_common_ground_nearby SET open_to_json = '[]'::jsonb WHERE account_id = $1")
        .bind(&maya)
        .execute(&pool)
        .await
        .unwrap();
    let (_, body) = send(&app, "GET", &person, &token, None).await;
    assert_eq!(body["requests"][0]["met"], false);
    let (_, body) = send(&app, "GET", &format!("{PEOPLE}/{sam}"), &token, None).await;
    assert_eq!(body["requests"][0]["met"], true);
}

#[tokio::test]
async fn ended_and_paused_requests_are_not_checked() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&app, &pool, "Viewer", here).await;
    let (maya, _) = located(&app, &pool, "Maya", north(here, 100.0)).await;
    let ended = need(
        &app,
        &token,
        json!({"text": "Founders", "endsAt": iso(Duration::hours(1))}),
    )
    .await;
    let paused = need(&app, &token, json!({"text": "Investors", "paused": true})).await;
    query("UPDATE cloud_common_ground_nearby_needs SET ends_at = now() - interval '1 minute', starts_at = NULL WHERE need_id = $1")
        .bind(&ended)
        .execute(&pool)
        .await
        .unwrap();
    store_match(&pool, &me, &maya, 70).await;
    let (_, body) = send(&app, "GET", PEOPLE, &token, None).await;
    assert_eq!(body["people"][0]["requests"], json!([]));
    let (runs,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_common_ground_nearby_need_runs WHERE account_id = $1")
            .bind(&me)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(runs, 0);
    let (_, list) = send(&app, "GET", NEEDS, &token, None).await;
    let statuses: Vec<&str> = list["needs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["paused", "ended"], "ended requests stay listed");
    assert_eq!(open_runs(&pool, &me).await, 0, "nothing was queued");
    let path = format!("{NEEDS}/{paused}");
    send(&app, "PUT", &path, &token, Some(json!({"paused": false}))).await;
    send(&app, "GET", PEOPLE, &token, None).await;
    assert_eq!(open_runs(&pool, &me).await, 1, "resumed, it is checked");
}

#[tokio::test]
async fn a_reply_that_is_not_a_check_fails_the_run() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&app, &pool, "Viewer", here).await;
    located(&app, &pool, "Maya", north(here, 100.0)).await;
    need(&app, &token, json!({"text": "Founders"})).await;
    send(&app, "GET", PEOPLE, &token, None).await;
    let (run_id, _) = claim_check(&pool, &me).await;
    crate::common_ground::complete(&pool, &run_id, RUNNER, "I could not decide.")
        .await
        .unwrap();
    let (failed,): (Option<chrono::DateTime<Utc>>,) =
        query_as("SELECT failed_at FROM cloud_common_ground_nearby_need_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(failed.is_some());
    // A failed check blocks a new one for two minutes.
    send(&app, "GET", PEOPLE, &token, None).await;
    let (open,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_common_ground_nearby_need_runs WHERE account_id = $1")
            .bind(&me)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(open, 1);
}
