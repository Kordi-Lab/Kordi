//! Nearby people: sign-out and device revocation, room links, Add through
//! nearby, location checks and capabilities.

use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};

use super::db_fixture::{pool, send, signed_in};
use super::nearby_support::{
    listed, locate, located, locations, memory_card, north, participant, setup, spot, NEARBY,
    PEOPLE,
};
use super::support::two_in_a_room;

#[tokio::test]
async fn sign_out_and_device_revocation_forget_locations() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (alex, alex_token) = located(&app, &pool, "Alex", here).await;
    assert_eq!(locations(&pool, &alex).await, 1);
    let (status, _) = send(&app, "POST", "/v1/cloud/auth/logout", &alex_token, None).await;
    assert_eq!(status, 204);
    assert_eq!(
        locations(&pool, &alex).await,
        0,
        "sign-out forgets the device's location"
    );

    // A second device posts a location; revoking it forgets that location.
    let (priya, priya_token) = located(&app, &pool, "Priya", here).await;
    let phone = format!("phone_{priya}");
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) VALUES ($1, $2, 'Phone', $3, $4, $4)")
        .bind(&phone)
        .bind(&priya)
        .bind(format!("legacy:{phone}"))
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    let phone_session = crate::auth::session::issue_session(&pool, &priya, &phone, 30)
        .await
        .unwrap();
    let (status, body) = locate(&app, &phone_session.plaintext_token, north(here, 50.0)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(locations(&pool, &priya).await, 2);
    let revoke = json!({"clientOperationId": uuid::Uuid::new_v4()});
    let path = format!("/v1/cloud/auth/devices/{phone}");
    let (status, body) = send(&app, "DELETE", &path, &priya_token, Some(revoke)).await;
    assert_eq!(status, 200, "{body}");
    let (left,): (String,) = query_as(
        "SELECT device_id FROM cloud_common_ground_nearby_locations WHERE account_id = $1",
    )
    .bind(&priya)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        left,
        format!("dev_{priya}"),
        "only the revoked device's location goes"
    );
    // The app forgets its own location when access is withdrawn.
    let (status, _) = send(
        &app,
        "DELETE",
        &format!("{NEARBY}/location"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 204);
    assert_eq!(locations(&pool, &priya).await, 0);
}

#[tokio::test]
async fn room_links_never_stand_in_for_nearby() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let (priya, priya_token) = signed_in(&pool, "Priya").await;
    two_in_a_room(&app, &pool, [(&alex, &alex_token), (&priya, &priya_token)]).await;
    let here = spot();
    for (token, at) in [(&alex_token, here), (&priya_token, north(here, 100.0))] {
        let on = json!({"enabled": true, "consent": true});
        assert_eq!(send(&app, "PUT", NEARBY, token, Some(on)).await.0, 200);
        assert_eq!(locate(&app, token, at).await.0, 200);
    }
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert_eq!(listed(&body), vec![alex.clone()]);
    send(
        &app,
        "PUT",
        NEARBY,
        &alex_token,
        Some(json!({"enabled": false})),
    )
    .await;
    // The room still links them, but nearby does not use it.
    let (status, _) = send(&app, "GET", &format!("{PEOPLE}/{priya}"), &alex_token, None).await;
    assert_eq!(status, 409);
    let (status, _) = send(&app, "GET", PEOPLE, &alex_token, None).await;
    assert_eq!(status, 409);
    let (status, _) = send(&app, "GET", &format!("{PEOPLE}/{alex}"), &priya_token, None).await;
    assert_eq!(status, 404);
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert!(listed(&body).is_empty());
    // The room itself still works as before.
    let (status, _) = send(
        &app,
        "GET",
        &format!("/v1/cloud/common-ground/people/{alex}"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn add_works_through_nearby_only_while_both_take_part() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (alex, alex_token) = located(&app, &pool, "Alex", here).await;
    let (priya, priya_token) = participant(&app, &pool, "Priya", &memory_card()).await;
    let add = |id: &str| format!("/v1/cloud/common-ground/people/{id}/contact");
    // Priya has no location yet: not visible, so Add fails.
    let (status, _) = send(&app, "POST", &add(&priya), &alex_token, None).await;
    assert_eq!(status, 404);
    assert_eq!(locate(&app, &priya_token, north(here, 120.0)).await.0, 200);
    let (status, body) = send(&app, "POST", &add(&priya), &alex_token, None).await;
    assert_eq!(status, 201, "{body}");
    // Alex turns off: Alex can no longer act on Priya through nearby, nor
    // Priya on Alex.
    send(
        &app,
        "PUT",
        NEARBY,
        &alex_token,
        Some(json!({"enabled": false})),
    )
    .await;
    let (status, _) = send(&app, "POST", &add(&alex), &priya_token, None).await;
    assert_eq!(status, 404);
    let (status, _) = send(&app, "POST", &add(&priya), &alex_token, None).await;
    assert_eq!(status, 404);
    let chat = format!("/v1/cloud/common-ground/people/{priya}/chat");
    let (status, _) = send(&app, "POST", &chat, &alex_token, None).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn locations_are_checked_rounded_and_capabilities_advertise_nearby() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let (alex, token) = participant(&app, &pool, "Alex", &memory_card()).await;
    let path = format!("{NEARBY}/location");
    let now = chrono::Utc::now();
    let post = |lat: f64, accuracy: f64, at: chrono::DateTime<chrono::Utc>| json!({"latitude": lat, "longitude": 121.473_701, "accuracy": accuracy, "capturedAt": at.to_rfc3339()});
    for (body, code) in [
        (
            post(91.0, 10.0, now),
            "common_ground_nearby_invalid_location",
        ),
        (post(31.2, 2_500.0, now), "common_ground_nearby_inaccurate"),
        (
            post(31.2, 10.0, now - chrono::Duration::minutes(11)),
            "common_ground_nearby_invalid_location",
        ),
        (
            post(31.2, 10.0, now + chrono::Duration::minutes(2)),
            "common_ground_nearby_invalid_location",
        ),
        (
            json!({"latitude": "north"}),
            "common_ground_nearby_invalid_location",
        ),
    ] {
        let (status, reply) = send(&app, "POST", &path, &token, Some(body)).await;
        assert_eq!((status, reply["errorCode"].as_str()), (422, Some(code)));
    }
    let (status, reply) = send(
        &app,
        "POST",
        &path,
        &token,
        Some(post(31.230_416_7, 30.0, now)),
    )
    .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["location"]["fresh"], true);
    let (lat, lon): (f64, f64) = query_as("SELECT latitude, longitude FROM cloud_common_ground_nearby_locations WHERE account_id = $1")
        .bind(&alex)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((lat, lon), (31.23, 121.474), "stored rounded to 3 decimals");
    // An older reading does not replace a newer one.
    let older = post(10.0, 30.0, now - chrono::Duration::minutes(5));
    assert_eq!(send(&app, "POST", &path, &token, Some(older)).await.0, 200);
    let (lat,): (f64,) =
        query_as("SELECT latitude FROM cloud_common_ground_nearby_locations WHERE account_id = $1")
            .bind(&alex)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(lat, 31.23);

    let (_, caps) = send(&app, "GET", "/v1/cloud/auth/capabilities", &token, None).await;
    assert_eq!(
        (
            caps["commonGroundVersion"].clone(),
            caps["commonGroundNearbyVersion"].clone()
        ),
        (json!(3), json!(1))
    );
    let plain = super::db_fixture::app(&pool, None);
    let (_, caps) = send(&plain, "GET", "/v1/cloud/auth/capabilities", &token, None).await;
    assert!(
        caps.get("commonGroundVersion").is_none()
            && caps.get("commonGroundNearbyVersion").is_none(),
        "{caps}"
    );
}
