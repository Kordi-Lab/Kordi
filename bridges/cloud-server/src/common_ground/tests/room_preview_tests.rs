//! `GET rooms/:code/preview`: what a code opens before you join.

use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{build_profile, create_profile};
use super::support::free_code;
use crate::system_account::SYSTEM_ACCOUNT_ID;

const CG: &str = "/v1/cloud/common-ground";

/// A signed-in person with a built work card: `(account, token)`.
async fn with_card(app: &axum::Router, pool: &PgPool, label: &str) -> (String, String) {
    let (id, token) = signed_in(pool, label).await;
    let work = create_profile(app, &token, "work", None).await;
    build_profile(app, pool, (&id, &token), &work, &format!("{label} topic")).await;
    (id, token)
}

async fn preview(app: &axum::Router, code: &str, token: &str) -> (u16, Value) {
    send(
        app,
        "GET",
        &format!("{CG}/rooms/{code}/preview"),
        token,
        None,
    )
    .await
}

/// A code with no open room.
async fn closed_code(pool: &PgPool) -> String {
    let code = free_code();
    query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(pool)
        .await
        .unwrap();
    code
}

/// Puts System in the room as a service member, which is never counted.
async fn add_system_member(pool: &PgPool, code: &str) {
    crate::system_account::ensure_account(pool).await.unwrap();
    query(
        "INSERT INTO cloud_common_ground_profiles (profile_id, account_id, kind, name, position)
         VALUES ('cgp_system_preview', $1, 'custom', 'System', 0) ON CONFLICT DO NOTHING",
    )
    .bind(SYSTEM_ACCOUNT_ID)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_common_ground_room_members (room_id, account_id, profile_id)
         SELECT room_id, $2, 'cgp_system_preview' FROM cloud_common_ground_rooms
         WHERE code = $1 AND closed_at IS NULL",
    )
    .bind(code)
    .bind(SYSTEM_ACCOUNT_ID)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn preview_shows_an_open_room_before_joining() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (_, alex) = with_card(&app, &pool, "Alex").await;
    let (_, priya) = with_card(&app, &pool, "Priya").await;
    let (_, carol) = signed_in(&pool, "Carol").await;
    let code = closed_code(&pool).await;
    let not_found =
        json!({"errorCode": "common_ground_room_not_found", "message": "Room not found."});

    // A free code and a malformed one look the same as joining them.
    assert_eq!(preview(&app, &code, &priya).await, (404, not_found.clone()));
    assert_eq!(
        preview(&app, "12a4", &priya).await,
        (404, not_found.clone())
    );
    // Without a card there is nothing to join with.
    let (status, body) = preview(&app, &code, &carol).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_no_card"))
    );

    let (status, body) = send(
        &app,
        "POST",
        &format!("{CG}/rooms/{code}/join"),
        &alex,
        Some(json!({"name": "  Agents   meetup ", "kind": "work"})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    add_system_member(&pool, &code).await;

    // Only the name, suggested kind and head count; nothing about members.
    assert_eq!(
        preview(&app, &code, &priya).await,
        (
            200,
            json!({"code": code, "name": "Agents meetup", "kind": "work", "memberCount": 1, "member": false})
        )
    );
    assert_eq!(
        preview(&app, &code, &alex).await,
        (
            200,
            json!({"code": code, "name": "Agents meetup", "kind": "work", "memberCount": 1, "member": true})
        )
    );
    // Previewing joins nothing.
    let (status, _) = send(&app, "GET", &format!("{CG}/rooms/{code}"), &priya, None).await;
    assert_eq!(status, 404);

    // A room past its 24 hours is gone, and so is a closed one.
    query("UPDATE cloud_common_ground_rooms SET last_join_at = now() - interval '25 hours' WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(preview(&app, &code, &alex).await, (404, not_found.clone()));
    query("UPDATE cloud_common_ground_rooms SET last_join_at = now(), closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(preview(&app, &code, &priya).await, (404, not_found));
}

#[tokio::test]
async fn previews_share_the_join_rate_limit() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (_, dana) = with_card(&app, &pool, "Dana").await;
    for attempt in 0..10 {
        let code = format!("{:04}", (attempt * 7 + 13) % 10_000);
        let (status, body) = preview(&app, &code, &dana).await;
        assert!(status == 200 || status == 404, "preview {attempt}: {body}");
    }
    let (status, body) = preview(&app, "0001", &dana).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (429, Some("rate_limited"))
    );
    // Joining draws on the same budget.
    let (status, _) = send(
        &app,
        "POST",
        &format!("{CG}/rooms/0001/join"),
        &dana,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 429);
}
