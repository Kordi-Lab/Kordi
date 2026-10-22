//! Create a code: the server picks a free four-digit code and opens the room
//! for the creator, who shares the profile they chose.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{build_profile, create_profile};

const ROOMS: &str = "/v1/cloud/common-ground/rooms";

/// A signed-in person with a built work card and a built health card.
async fn person(app: &axum::Router, pool: &PgPool, label: &str) -> (String, String, String) {
    let (id, token) = signed_in(pool, label).await;
    let work = create_profile(app, &token, "work", None).await;
    build_profile(app, pool, (&id, &token), &work, "Agent memory").await;
    let health = create_profile(app, &token, "health", None).await;
    build_profile(app, pool, (&id, &token), &health, "Marathon training").await;
    (id, token, health)
}

async fn create(app: &axum::Router, token: &str, body: Value) -> (u16, Value) {
    send(app, "POST", ROOMS, token, Some(body)).await
}

/// The profile `account` shares in the open room for `code`.
async fn shared_profile(pool: &PgPool, code: &str, account: &str) -> Option<String> {
    query_as::<_, (String,)>(
        "SELECT member.profile_id FROM cloud_common_ground_room_members member
         JOIN cloud_common_ground_rooms room ON room.room_id = member.room_id
         WHERE room.code = $1 AND room.closed_at IS NULL
           AND member.account_id = $2 AND member.left_at IS NULL",
    )
    .bind(code)
    .bind(account)
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|(profile,)| profile)
}

#[tokio::test]
async fn create_opens_a_room_on_a_free_code() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, alex_token, alex_health) = person(&app, &pool, "Alex").await;
    let (status, body) = create(
        &app,
        &alex_token,
        json!({"name": "  Morning   run ", "kind": "health", "profileId": alex_health}),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let code = body["code"].as_str().unwrap().to_string();
    assert!(
        code.len() == 4 && code.bytes().all(|b| b.is_ascii_digit()),
        "{code}"
    );
    assert_eq!(
        (
            &body["name"],
            &body["kind"],
            &body["profileId"],
            &body["openedByYou"],
            &body["open"]
        ),
        (
            &json!("Morning run"),
            &json!("health"),
            &json!(alex_health),
            &json!(true),
            &json!(true)
        )
    );
    assert_eq!(body["members"], json!([]));
    assert_eq!(
        shared_profile(&pool, &code, &alex).await,
        Some(alex_health.clone())
    );

    // A second person joins by that code and sees the creator.
    let (priya, priya_token, priya_health) = person(&app, &pool, "Priya").await;
    let (status, joined) = send(
        &app,
        "POST",
        &format!("{ROOMS}/{code}/join"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["openedByYou"], false);
    assert_eq!(joined["name"], "Morning run");
    assert_eq!(joined["members"][0]["accountId"], alex, "{joined}");
    // The room suggests health, so Priya shares her health card.
    assert_eq!(
        shared_profile(&pool, &code, &priya).await,
        Some(priya_health)
    );
}

#[tokio::test]
async fn two_creates_get_different_codes() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (_, token, health) = person(&app, &pool, "Sam").await;
    let body = json!({"name": "Lab lunch", "profileId": health});
    let (first_status, first) = create(&app, &token, body.clone()).await;
    let (second_status, second) = create(&app, &token, body).await;
    assert_eq!(
        (first_status, second_status),
        (201, 201),
        "{first} {second}"
    );
    assert_ne!(first["code"], second["code"]);
}

#[tokio::test]
async fn create_needs_a_name() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (_, token, health) = person(&app, &pool, "Noor").await;
    for body in [
        json!({"name": "", "profileId": health}),
        json!({"name": "   ", "profileId": health}),
        json!({"profileId": health}),
    ] {
        let (status, response) = create(&app, &token, body).await;
        assert_eq!(status, 400, "{response}");
        assert_eq!(response["errorCode"], "common_ground_room_name_required");
    }
}
