//! Several Grounding cards per memory (#2035): `addProfileId`,
//! `removeProfileId`, the legacy `profileId`, and the list row fields.

use super::categories::{insert_profile, patch, save, with};
use super::group_shared::group;
use super::*;

/// `(profileIds, excludedProfileIds, profileId)` of a memory response.
fn cards(memory: &Value) -> (Value, Value, Value) {
    (
        memory["profileIds"].clone(),
        memory["excludedProfileIds"].clone(),
        memory["profileId"].clone(),
    )
}

async fn updated_at(fx: &Fixture, memory_id: &str) -> chrono::DateTime<Utc> {
    let (at,): (chrono::DateTime<Utc>,) =
        query_as("SELECT updated_at FROM cloud_account_memories WHERE memory_id = $1")
            .bind(memory_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    at
}

async fn legacy_column(fx: &Fixture, memory_id: &str) -> Option<String> {
    let (pin,): (Option<String>,) =
        query_as("SELECT profile_id FROM cloud_account_memories WHERE memory_id = $1")
            .bind(memory_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    pin
}

#[tokio::test]
async fn add_and_remove_cards() {
    let Some(fx) = fixture().await else { return };
    let Some(other) = fixture().await else { return };
    let work = insert_profile(&fx, "work", 0).await;
    let health = insert_profile(&fx, "health", 1).await;
    let daily = insert_profile(&fx, "daily", 2).await;
    let custom = insert_profile(&fx, "custom", 3).await;

    let (_, saved) = save(
        &fx,
        with(
            "Leads the Atlas pipeline",
            json!({ "category": "work_context" }),
        ),
    )
    .await;
    let memory = &saved["memory"];
    let id = memory["memoryId"].as_str().unwrap().to_string();
    assert_eq!(cards(memory), (json!([work]), json!([]), Value::Null));
    assert_eq!(memory["profileKind"], "work");

    // An extra card: the category card stays, the custom one joins.
    let before = updated_at(&fx, &id).await;
    let (status, edited) = patch(&fx, &id, json!({ "addProfileId": custom })).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        cards(&edited["memory"]),
        (json!([work, custom]), json!([]), json!(custom))
    );
    assert!(
        updated_at(&fx, &id).await > before,
        "memoriesSinceBuild sees it"
    );
    assert_eq!(legacy_column(&fx, &id).await, Some(custom.clone()));
    // Adding a card it is already on changes nothing but the time.
    let (status, again) = patch(&fx, &id, json!({ "addProfileId": work })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cards(&again["memory"]), cards(&edited["memory"]));

    // The default card removed, then re-added.
    let (status, edited) = patch(&fx, &id, json!({ "removeProfileId": work })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        cards(&edited["memory"]),
        (json!([custom]), json!([work]), json!(custom))
    );
    let (status, error) = patch(&fx, &id, json!({ "removeProfileId": work })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["errorCode"], "memory_profile_not_found");
    let (status, error) = patch(&fx, &id, json!({ "removeProfileId": health })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["errorCode"], "memory_profile_not_found");
    let (_, edited) = patch(&fx, &id, json!({ "addProfileId": work })).await;
    assert_eq!(
        cards(&edited["memory"]),
        (json!([work, custom]), json!([]), json!(custom))
    );

    // Two added cards: no single legacy pin.
    let (_, edited) = patch(&fx, &id, json!({ "addProfileId": daily })).await;
    assert_eq!(
        cards(&edited["memory"]),
        (json!([work, daily, custom]), json!([]), Value::Null)
    );
    assert_eq!(edited["memory"]["profileKind"], "work");
    assert_eq!(legacy_column(&fx, &id).await, None);
    let (_, edited) = patch(&fx, &id, json!({ "removeProfileId": custom })).await;
    assert_eq!(
        cards(&edited["memory"]),
        (json!([work, daily]), json!([]), json!(daily))
    );
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"][0], edited["memory"]);

    // Another account's profile is not found.
    let foreign = insert_profile(&other, "work", 0).await;
    for field in ["addProfileId", "removeProfileId"] {
        let (status, error) = patch(&fx, &id, json!({ field: foreign })).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{field}");
        assert_eq!(error["errorCode"], "profile_not_found");
    }
    other.cleanup().await;
    fx.cleanup().await;
}

#[tokio::test]
async fn legacy_profile_id_replaces_every_card() {
    let Some(fx) = fixture().await else { return };
    let work = insert_profile(&fx, "work", 0).await;
    let health = insert_profile(&fx, "health", 1).await;
    let daily = insert_profile(&fx, "daily", 2).await;
    let custom = insert_profile(&fx, "custom", 3).await;

    // Coordination memories feed every fixed-kind card.
    let (_, saved) = save(
        &fx,
        with(
            "Free on Tuesday mornings",
            json!({ "category": "coordination_context" }),
        ),
    )
    .await;
    let id = saved["memory"]["memoryId"].as_str().unwrap().to_string();
    assert_eq!(
        cards(&saved["memory"]),
        (json!([work, health, daily]), json!([]), Value::Null)
    );
    let (_, edited) = patch(&fx, &id, json!({ "addProfileId": custom })).await;
    assert_eq!(
        cards(&edited["memory"]),
        (
            json!([work, health, daily, custom]),
            json!([]),
            json!(custom)
        )
    );

    // A legacy pin keeps feeding only the pinned card.
    let (status, edited) = patch(&fx, &id, json!({ "profileId": health })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        cards(&edited["memory"]),
        (json!([health]), json!([work, daily]), json!(health))
    );
    assert_eq!(edited["memory"]["profileKind"], "health");
    assert_eq!(legacy_column(&fx, &id).await, Some(health.clone()));
    // Removing the pinned card leaves no card at all.
    let (_, edited) = patch(&fx, &id, json!({ "removeProfileId": health })).await;
    assert_eq!(
        cards(&edited["memory"]),
        (json!([]), json!([work, health, daily]), Value::Null)
    );
    assert_eq!(legacy_column(&fx, &id).await, None);

    // null clears every choice: the category decides again.
    let (status, edited) = patch(&fx, &id, json!({ "profileId": null })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        cards(&edited["memory"]),
        (json!([work, health, daily]), json!([]), Value::Null)
    );
    assert_eq!(edited["memory"]["profileKind"], "all");

    // A prompt-only memory has no cards until one is added.
    let (_, saved) = save(&fx, memory_body("Prefers short replies")).await;
    assert_eq!(cards(&saved["memory"]), (json!([]), json!([]), Value::Null));
    let pref = saved["memory"]["memoryId"].as_str().unwrap().to_string();
    let (_, edited) = patch(&fx, &pref, json!({ "profileId": work })).await;
    assert_eq!(
        cards(&edited["memory"]),
        (json!([work]), json!([]), json!(work))
    );
    fx.cleanup().await;
}

#[tokio::test]
async fn group_memories_refuse_every_card_change() {
    let Some(g) = group().await else { return };
    let mut work = g.body("Ship the beta on Friday");
    work["category"] = json!("work_context");
    let (status, saved) = g.a.send("POST", "/v1/cloud/memory", Some(work)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(cards(&saved["memory"]), (json!([]), json!([]), Value::Null));
    let id = saved["memory"]["memoryId"].as_str().unwrap().to_string();
    let profile = insert_profile(&g.a, "work", 0).await;
    for body in [
        json!({ "profileId": profile }),
        json!({ "profileId": null }),
        json!({ "addProfileId": profile }),
        json!({ "removeProfileId": profile }),
    ] {
        let (status, error) = patch(&g.a, &id, body.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(error["errorCode"], "memory_profile_not_allowed");
    }
    g.cleanup().await;
}
