//! Your rooms: the list, read-only access to closed rooms, removing one, and
//! groups started for a topic.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::db_fixture::{pool, send, signed_in};
use super::support::{answer_match, claim_open, people_in_a_room, RUNNER};
use crate::common_ground::complete;

async fn call(app: &axum::Router, method: &str, path: &str, token: &str) -> (u16, Value) {
    send(
        app,
        method,
        &format!("/v1/cloud/common-ground/{path}"),
        token,
        None,
    )
    .await
}

async fn my_rooms(app: &axum::Router, token: &str) -> Vec<Value> {
    let (status, body) = call(app, "GET", "rooms", token).await;
    assert_eq!(status, 200, "{body}");
    body["rooms"].as_array().unwrap().clone()
}

async fn close(pool: &PgPool, code: &str) {
    query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(code)
        .execute(pool)
        .await
        .unwrap();
}

/// Match and theme runs ever queued for this viewer or room.
async fn runs(pool: &PgPool, viewer: &str, code: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_match_runs
         WHERE viewer_account_id = $1
            OR room_id IN (SELECT room_id FROM cloud_common_ground_rooms WHERE code = $2)",
    )
    .bind(viewer)
    .bind(code)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn the_list_shows_your_rooms_until_you_leave() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(_, alex_token), (_, priya_token)] = [people[0].clone(), people[1].clone()];
    query("UPDATE cloud_common_ground_rooms SET name = 'Poster session' WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();
    let rooms = my_rooms(&app, &alex_token).await;
    assert_eq!(rooms.len(), 1, "{rooms:?}");
    let room = &rooms[0];
    assert_eq!(
        (
            &room["code"],
            &room["name"],
            &room["open"],
            &room["memberCount"],
            &room["themeCount"]
        ),
        (
            &json!(code),
            &json!("Poster session"),
            &json!(true),
            &json!(2),
            &json!(0)
        )
    );
    assert!(room["joinedAt"].is_string() && room["lastActivityAt"].is_string());

    let (status, _) = call(&app, "POST", &format!("rooms/{code}/leave"), &priya_token).await;
    assert_eq!(status, 204);
    assert_eq!(my_rooms(&app, &priya_token).await, Vec::<Value>::new());
    assert_eq!(my_rooms(&app, &alex_token).await[0]["memberCount"], 1);
}

#[tokio::test]
async fn a_closed_room_keeps_its_results_for_members() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, priya_token), (_, sam_token)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let (_, outsider_token) = signed_in(&pool, "Outsider").await;
    let results = format!("rooms/{code}/results");
    let (status, body) = call(&app, "POST", &results, &alex_token).await;
    assert_eq!((status, body["status"].as_str()), (200, Some("matching")));
    answer_match(&pool, &alex).await;
    let (room_run, members) = claim_open(&pool, "room", None).await;
    let themes = json!({"themes": [{"label": "Agent memory", "people": (0..members.len()).collect::<Vec<_>>()}]});
    complete(&pool, &room_run, RUNNER, &themes.to_string())
        .await
        .unwrap();
    let (_, open_body) = call(&app, "POST", &results, &alex_token).await;
    assert_eq!(open_body["status"], "ready", "{open_body}");

    close(&pool, &code).await;
    let before = (
        runs(&pool, &alex, &code).await,
        runs(&pool, &priya, &code).await,
    );
    let (status, body) = call(&app, "POST", &results, &alex_token).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "ready");
    assert_eq!(body["people"], open_body["people"], "stored matches");
    assert_eq!(body["topics"], open_body["topics"], "stored themes");
    assert_eq!(body["people"].as_array().unwrap().len(), 2);
    assert_eq!(body["topics"][0]["label"], "Agent memory");
    // Priya never asked: nothing stored for her, and nothing is queued.
    let (status, body) = call(&app, "POST", &results, &priya_token).await;
    assert_eq!((status, &body["status"]), (200, &json!("ready")), "{body}");
    assert_eq!(body["people"], json!([]));
    assert_eq!(body["topics"][0]["label"], "Agent memory");
    let after = (
        runs(&pool, &alex, &code).await,
        runs(&pool, &priya, &code).await,
    );
    assert_eq!(after, before, "no run for a closed room");

    let (status, view) = call(&app, "GET", &format!("rooms/{code}"), &alex_token).await;
    assert_eq!((status, &view["open"]), (200, &json!(false)), "{view}");
    assert!(view["expiresAt"].is_string());
    assert_eq!(view["members"].as_array().unwrap().len(), 2);
    let rooms = my_rooms(&app, &alex_token).await;
    assert_eq!(
        (&rooms[0]["open"], &rooms[0]["themeCount"]),
        (&json!(false), &json!(1))
    );

    for path in [format!("rooms/{code}"), results.clone()] {
        let method = if path == results { "POST" } else { "GET" };
        let (status, _) = call(&app, method, &path, &outsider_token).await;
        assert_eq!(status, 404, "{path} is for members");
    }
    // Leaving a closed room removes it.
    let (status, _) = call(&app, "POST", &format!("rooms/{code}/leave"), &sam_token).await;
    assert_eq!(status, 204);
    assert_eq!(my_rooms(&app, &sam_token).await, Vec::<Value>::new());
    let (status, _) = call(&app, "GET", &format!("rooms/{code}"), &sam_token).await;
    assert_eq!(status, 404, "a removed room is gone");
    assert_eq!(my_rooms(&app, &alex_token).await[0]["memberCount"], 2);
}

#[tokio::test]
async fn a_closed_room_without_results_is_ready_and_empty() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    close(&pool, &code).await;
    let (status, body) = call(&app, "POST", &format!("rooms/{code}/results"), &people[0].1).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (&body["status"], &body["people"], &body["topics"]),
        (&json!("ready"), &json!([]), &json!([]))
    );
    assert_eq!(runs(&pool, &people[0].0, &code).await, 0);
}

#[tokio::test]
async fn groups_keep_their_topic() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(_, alex_token), (priya, _), (sam, _)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let group = format!("/v1/cloud/common-ground/rooms/{code}/group");
    let start = |body: Value| send(&app, "POST", &group, &alex_token, Some(body));
    let (status, body) = start(json!({"memberIds": [priya], "topic": "  Agent   memory "})).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["group"]["topic"], "Agent memory");
    let (status, _) = start(json!({"memberIds": [sam], "topic": "x".repeat(81)})).await;
    assert_eq!(status, 400, "topics are short");

    // A closed room still lets its members start a group.
    close(&pool, &code).await;
    let (status, body) = start(json!({"memberIds": [sam]})).await;
    assert_eq!(
        (status, &body["group"]["topic"]),
        (201, &Value::Null),
        "{body}"
    );
    let (_, results) = call(&app, "POST", &format!("rooms/{code}/results"), &alex_token).await;
    let (_, view) = call(&app, "GET", &format!("rooms/{code}"), &alex_token).await;
    for body in [results, view] {
        let topics: Vec<&Value> = body["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| &g["topic"])
            .collect();
        assert_eq!(topics, vec![&json!("Agent memory"), &Value::Null], "{body}");
    }
}

#[tokio::test]
async fn a_closed_code_opens_a_fresh_room() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(_, alex_token), (_, priya_token)] = [people[0].clone(), people[1].clone()];
    let (_, old) = call(&app, "GET", &format!("rooms/{code}"), &alex_token).await;
    close(&pool, &code).await;
    let (status, fresh) = call(&app, "POST", &format!("rooms/{code}/join"), &alex_token).await;
    assert_eq!(status, 200, "{fresh}");
    assert_ne!(fresh["roomId"], old["roomId"], "a new room");
    assert_eq!(
        (&fresh["open"], fresh["members"].as_array().unwrap().len()),
        (&json!(true), 0)
    );
    // The code opens the open room for Alex, the closed one for Priya.
    let (_, view) = call(&app, "GET", &format!("rooms/{code}"), &alex_token).await;
    assert_eq!(view["roomId"], fresh["roomId"]);
    let (_, view) = call(&app, "GET", &format!("rooms/{code}"), &priya_token).await;
    assert_eq!(
        (&view["roomId"], &view["open"]),
        (&old["roomId"], &json!(false))
    );
    let rooms = my_rooms(&app, &alex_token).await;
    assert_eq!(rooms.len(), 1, "one entry per code: {rooms:?}");
    assert_eq!(
        (&rooms[0]["open"], &rooms[0]["memberCount"]),
        (&json!(true), &json!(1))
    );
}

#[tokio::test]
async fn closed_room_members_see_each_other_until_one_leaves() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, priya_token)] = [people[0].clone(), people[1].clone()];
    let (status, _) = call(&app, "POST", &format!("rooms/{code}/results"), &alex_token).await;
    assert_eq!(status, 200);
    answer_match(&pool, &alex).await;
    close(&pool, &code).await;
    let before = runs(&pool, &priya, &code).await;

    let (status, body) = call(&app, "GET", &format!("people/{priya}"), &alex_token).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["card"]["workingOn"], json!(["Agent memory"]));
    let (status, body) = call(&app, "GET", &format!("people/{priya}/match"), &alex_token).await;
    assert_eq!((status, &body["status"]), (200, &json!("ready")), "{body}");
    assert!(body["score"].is_i64());
    // Priya never matched: nothing stored, and nothing runs for her.
    let (status, body) = call(&app, "GET", &format!("people/{alex}/match"), &priya_token).await;
    assert_eq!(
        (status, &body["errorCode"]),
        (404, &json!("common_ground_match_not_found"))
    );
    assert_eq!(runs(&pool, &priya, &code).await, before, "no run");

    let (status, _) = call(&app, "POST", &format!("rooms/{code}/leave"), &priya_token).await;
    assert_eq!(status, 204);
    for (token, other) in [(&alex_token, &priya), (&priya_token, &alex)] {
        for path in [format!("people/{other}"), format!("people/{other}/match")] {
            let (status, _) = call(&app, "GET", &path, token).await;
            assert_eq!(status, 404, "{path} after leaving");
        }
    }
}
