//! Activity choices belong to the selected card, including across reloads.
use serde_json::json;

use super::db_fixture::{pool, send, signed_in};
use super::nearby_support::{setup, NEARBY};
use super::profile_support::{build_profile, create_profile};

#[tokio::test]
async fn nearby_activities_follow_the_card_and_reject_stale_edits() {
    let Some(pool) = pool().await else { return };
    let (app, _) = setup(&pool).await;
    let (account, token) = signed_in(&pool, "Activities").await;
    let work = create_profile(&app, &token, "work", None).await;
    let health = create_profile(&app, &token, "health", None).await;
    for (id, topic) in [(&work, "AI collaboration"), (&health, "Trail running")] {
        build_profile(&app, &pool, (&account, &token), id, topic).await;
    }
    let (status, body) = send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({
            "enabled": true, "consent": true, "profileId": work, "openTo": ["Hiring"]
        })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["openTo"], json!(["Hiring"]));
    let (status, body) = send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"profileId": health})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["openTo"],
        json!([]),
        "A new card does not inherit Work activities"
    );
    let (status, body) = send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({
            "openToProfileId": health, "openTo": [" Training together ", "Sunday trail run"]
        })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["openTo"],
        json!(["Training together", "Sunday trail run"])
    );

    // A delayed request from another card must not change either card's choices.
    let (status, body) = send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({
            "openToProfileId": work, "openTo": ["Advice"]
        })),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_nearby_card_changed");
    for (id, expected) in [
        (&work, json!(["Hiring"])),
        (&health, json!(["Training together", "Sunday trail run"])),
    ] {
        let (status, body) =
            send(&app, "PUT", NEARBY, &token, Some(json!({"profileId": id}))).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["openTo"], expected);
        let (status, reloaded) = send(&app, "GET", NEARBY, &token, None).await;
        assert_eq!(status, 200);
        assert_eq!(
            reloaded["openTo"], expected,
            "Reload keeps card-specific choices"
        );
    }

    // Older clients still edit the currently shared card; empty is a saved choice.
    let (status, body) = send(&app, "PUT", NEARBY, &token, Some(json!({"openTo": []}))).await;
    assert_eq!(status, 200, "{body}");
    send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"profileId": work})),
    )
    .await;
    let (_, body) = send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"profileId": health})),
    )
    .await;
    assert_eq!(body["openTo"], json!([]));

    let (_, other_token) = signed_in(&pool, "Other activities").await;
    let foreign = create_profile(&app, &other_token, "work", None).await;
    let (status, _) = send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"profileId": foreign, "openTo": ["Hiring"]})),
    )
    .await;
    assert_eq!(
        status, 404,
        "Another account's activities cannot be modified"
    );
}
