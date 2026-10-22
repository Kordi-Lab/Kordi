//! `GET rooms/:code/preview`: what a code opens before you join.

use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{build_profile, create_profile};
use super::support::closed_code;
use crate::system_account::SYSTEM_ACCOUNT_ID;

const CG: &str = "/v1/cloud/common-ground";

/// A signed-in person with a built card per kind, in order:
/// `(token, profile ids)`.
async fn with_cards(
    app: &axum::Router,
    pool: &PgPool,
    label: &str,
    kinds: &[&str],
) -> (String, Vec<String>) {
    let (id, token) = signed_in(pool, label).await;
    let mut profiles = Vec::new();
    for kind in kinds {
        let profile = create_profile(app, &token, kind, None).await;
        build_profile(
            app,
            pool,
            (&id, &token),
            &profile,
            &format!("{label} {kind}"),
        )
        .await;
        profiles.push(profile);
    }
    (token, profiles)
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
    let (alex, alex_cards) = with_cards(&app, &pool, "Alex", &["work"]).await;
    // Priya's first profile is daily; the room suggests work.
    let (priya, priya_cards) = with_cards(&app, &pool, "Priya", &["daily", "work"]).await;
    let (dana, _) = with_cards(&app, &pool, "Dana", &["work"]).await;
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

    // Only the name, suggested kind and head count, with the profile a join
    // would share; nothing about members.
    assert_eq!(
        preview(&app, &code, &priya).await,
        (
            200,
            json!({
                "code": code, "name": "Agents meetup", "kind": "work", "memberCount": 1,
                "member": false, "profileId": null, "suggestedProfileId": priya_cards[1],
            })
        )
    );
    // A member sees the profile they already share, so reopening keeps it.
    assert_eq!(
        preview(&app, &code, &alex).await,
        (
            200,
            json!({
                "code": code, "name": "Agents meetup", "kind": "work", "memberCount": 1,
                "member": true, "profileId": alex_cards[0], "suggestedProfileId": alex_cards[0],
            })
        )
    );
    // The rooms list counts the same people.
    let (_, rooms) = send(&app, "GET", &format!("{CG}/rooms"), &alex, None).await;
    let listed = rooms["rooms"]
        .as_array()
        .unwrap()
        .iter()
        .find(|room| room["code"] == code.as_str())
        .unwrap();
    assert_eq!(listed["memberCount"], 1, "{listed}");
    // Previewing joins nothing.
    let (status, _) = send(&app, "GET", &format!("{CG}/rooms/{code}"), &priya, None).await;
    assert_eq!(status, 404);

    // A preview refuses whoever a join would refuse, the same way.
    let (status, body) = preview(&app, &code, &carol).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_no_card"))
    );
    let (status, body) = send(
        &app,
        "PUT",
        &format!("{CG}/settings"),
        &dana,
        Some(json!({"sharing": false})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    for path in ["preview", "join"] {
        let method = if path == "join" { "POST" } else { "GET" };
        let (status, body) = send(
            &app,
            method,
            &format!("{CG}/rooms/{code}/{path}"),
            &dana,
            None,
        )
        .await;
        assert_eq!(
            (status, body["errorCode"].as_str()),
            (409, Some("common_ground_sharing_off")),
            "{path}"
        );
    }

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

/// Looking up the right code never costs the join; only misses spend the
/// guess budget, and once it is spent every preview and join is refused.
#[tokio::test]
async fn preview_misses_spend_the_join_budget() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, _) = with_cards(&app, &pool, "Alex", &["work"]).await;
    let (dana, _) = with_cards(&app, &pool, "Dana", &["work"]).await;
    let mut misses = Vec::new();
    while misses.len() < 9 {
        let miss = closed_code(&pool).await;
        if !misses.contains(&miss) {
            misses.push(miss);
        }
    }
    let code = loop {
        let code = closed_code(&pool).await;
        if !misses.contains(&code) {
            break code;
        }
    };
    let join = format!("{CG}/rooms/{code}/join");
    let (status, body) = send(&app, "POST", &join, &alex, Some(json!({}))).await;
    assert_eq!(status, 200, "{body}");

    for attempt in 0..12 {
        let (status, body) = preview(&app, &code, &dana).await;
        assert_eq!(status, 200, "preview {attempt}: {body}");
    }
    let (status, body) = send(&app, "POST", &join, &dana, Some(json!({}))).await;
    assert_eq!(status, 200, "{body}");

    // The join and nine misses spend the budget of ten.
    for miss in &misses {
        let (status, body) = preview(&app, miss, &dana).await;
        assert_eq!(status, 404, "{miss}: {body}");
    }
    let (status, body) = preview(&app, &code, &dana).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (429, Some("rate_limited"))
    );
    let (status, _) = send(&app, "POST", &join, &dana, Some(json!({}))).await;
    assert_eq!(status, 429);
}
