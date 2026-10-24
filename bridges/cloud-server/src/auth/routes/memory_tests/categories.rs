//! Memory categories, declaration types and profile fields (#1977).

use super::group_shared::group;
use super::*;

/// Inserts a profile of `kind` for the fixture's account and returns its id.
pub(super) async fn insert_profile(fx: &Fixture, kind: &str, position: i32) -> String {
    let profile_id = format!("cgp_test_{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_common_ground_profiles (profile_id, account_id, kind, name, position) \
         VALUES ($1, $2, $3, 'Test profile', $4)",
    )
    .bind(&profile_id)
    .bind(&fx.account_id)
    .bind(kind)
    .bind(position)
    .execute(&fx.pool)
    .await
    .unwrap();
    profile_id
}

pub(super) async fn save(fx: &Fixture, body: Value) -> (StatusCode, Value) {
    fx.send("POST", "/v1/cloud/memory", Some(body)).await
}

pub(super) fn with(text: &str, fields: Value) -> Value {
    let mut body = memory_body(text);
    for (key, value) in fields.as_object().unwrap() {
        body[key] = value.clone();
    }
    body
}

pub(super) async fn patch(fx: &Fixture, memory_id: &str, body: Value) -> (StatusCode, Value) {
    fx.send(
        "PATCH",
        &format!("/v1/cloud/memory/{memory_id}"),
        Some(body),
    )
    .await
}

#[tokio::test]
async fn save_carries_category_declaration_and_confidence() {
    let Some(fx) = fixture().await else { return };

    let (status, saved) = save(
        &fx,
        with(
            "Leads the Atlas migration",
            json!({ "category": "work_context", "confidence": "high" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let memory = &saved["memory"];
    assert_eq!(memory["category"], "work_context");
    assert_eq!(memory["declarationType"], "model-inferred");
    assert_eq!(memory["confidence"], "high");
    assert_eq!(memory["profileId"], Value::Null);
    assert_eq!(memory["profileKind"], "work");
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"][0], *memory);

    // An old client sends no category: the default, inferred at medium.
    let (_, saved) = save(&fx, memory_body("Prefers short replies")).await;
    assert_eq!(saved["memory"]["category"], "general_preferences");
    assert_eq!(saved["memory"]["declarationType"], "model-inferred");
    assert_eq!(saved["memory"]["confidence"], "medium");
    assert_eq!(saved["memory"]["profileKind"], Value::Null);

    // Typed by the person: declared, without a confidence.
    let (_, saved) = save(
        &fx,
        with(
            "Free on Tuesday mornings",
            json!({ "source": "manual", "category": "coordination_context", "confidence": "low" }),
        ),
    )
    .await;
    assert_eq!(saved["memory"]["declarationType"], "user-declared");
    assert_eq!(saved["memory"]["confidence"], Value::Null);
    assert_eq!(saved["memory"]["profileKind"], "all");

    for (field, value, code) in [
        ("category", "diary", "invalid_category"),
        ("confidence", "certain", "invalid_confidence"),
        ("declaredBy", "robot", "invalid_declared_by"),
    ] {
        let (status, error) = save(&fx, with("Refused", json!({ field: value }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}");
        assert_eq!(error["errorCode"], code);
    }

    assert_eq!(
        fx.audit_metadata("memory_saved").await[0]["category"],
        "work_context"
    );
    fx.cleanup().await;
}

#[tokio::test]
async fn group_memories_keep_to_shared_categories_and_no_profile() {
    let Some(g) = group().await else { return };

    let mut health = g.body("Runs 5k on Tuesdays");
    health["category"] = json!("health_context");
    let (status, error) = g.a.send("POST", "/v1/cloud/memory", Some(health)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["errorCode"], "memory_category_not_shared");
    let (_, list) = g.a.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"], json!([]), "nothing was written");

    let mut work = g.body("Ship the beta on Friday");
    work["category"] = json!("work_context");
    let (status, saved) = g.a.send("POST", "/v1/cloud/memory", Some(work)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(saved["memory"]["category"], "work_context");
    assert_eq!(saved["memory"]["profileKind"], Value::Null);
    let memory_id = saved["memory"]["memoryId"].as_str().unwrap().to_string();

    let profile_id = insert_profile(&g.a, "work", 0).await;
    let (status, error) = patch(&g.a, &memory_id, json!({ "profileId": profile_id })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["errorCode"], "memory_profile_not_allowed");
    let (status, error) = patch(&g.b, &memory_id, json!({ "category": "location_context" })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["errorCode"], "memory_category_not_shared");
    let (status, edited) = patch(
        &g.b,
        &memory_id,
        json!({ "category": "coordination_context" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["memory"]["category"], "coordination_context");
    assert_eq!(edited["memory"]["profileKind"], Value::Null);
    g.cleanup().await;
}

#[tokio::test]
async fn patch_changes_category_text_and_profile() {
    let Some(fx) = fixture().await else { return };
    let Some(other) = fixture().await else { return };
    let (_, saved) = save(
        &fx,
        with(
            "Plays tennis on Sundays",
            json!({ "category": "health_context" }),
        ),
    )
    .await;
    let memory_id = saved["memory"]["memoryId"].as_str().unwrap().to_string();
    assert_eq!(saved["memory"]["profileKind"], "health");

    // A category change keeps the declaration and confidence.
    let (status, edited) = patch(&fx, &memory_id, json!({ "category": "location_context" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["memory"]["category"], "location_context");
    assert_eq!(edited["memory"]["profileKind"], "daily");
    assert_eq!(edited["memory"]["declarationType"], "model-inferred");
    assert_eq!(edited["memory"]["confidence"], "medium");
    assert_eq!(edited["memory"]["text"], "Plays tennis on Sundays");

    // A text edit is the person's own words.
    let (status, edited) = patch(
        &fx,
        &memory_id,
        json!({ "text": "Plays tennis on Saturdays" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["memory"]["text"], "Plays tennis on Saturdays");
    assert_eq!(edited["memory"]["declarationType"], "user-declared");
    assert_eq!(edited["memory"]["confidence"], Value::Null);
    assert_eq!(edited["memory"]["category"], "location_context");
    let audits = fx.audit_metadata("memory_updated").await;
    assert_eq!(audits.last().unwrap()["declarationType"], "user-declared");

    // Filed to one of the owner's profiles, then cleared again.
    let custom = insert_profile(&fx, "custom", 3).await;
    let (status, edited) = patch(&fx, &memory_id, json!({ "profileId": custom })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["memory"]["profileId"], custom.as_str());
    assert_eq!(edited["memory"]["profileKind"], "custom");
    let (status, edited) = patch(&fx, &memory_id, json!({ "profileId": null })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["memory"]["profileId"], Value::Null);
    assert_eq!(edited["memory"]["profileKind"], "daily");

    // Another account's profile, an unknown category and an empty edit.
    let foreign = insert_profile(&other, "work", 0).await;
    let (status, error) = patch(&fx, &memory_id, json!({ "profileId": foreign })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["errorCode"], "profile_not_found");
    let (status, error) = patch(&fx, &memory_id, json!({ "category": "diary" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errorCode"], "invalid_category");
    let (status, error) = patch(&fx, &memory_id, json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errorCode"], "invalid_update");

    // Deleting the profile leaves the memory routed by its category.
    let (_, edited) = patch(&fx, &memory_id, json!({ "profileId": custom })).await;
    assert_eq!(edited["memory"]["profileId"], custom.as_str());
    query("DELETE FROM cloud_common_ground_profiles WHERE profile_id = $1")
        .bind(&custom)
        .execute(&fx.pool)
        .await
        .unwrap();
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"][0]["profileId"], Value::Null);
    assert_eq!(list["memories"][0]["profileKind"], "daily");
    other.cleanup().await;
    fx.cleanup().await;
}

#[tokio::test]
async fn runner_saves_are_always_inferred() {
    let Some(fx) = fixture().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    let runner_id = format!("runner_{}", uuid::Uuid::new_v4().simple());
    let run_id = fx.leased_run(&runner_id).await;
    let body = with(
        "Deploys need a green smoke test",
        json!({
            "scopeId": "memory-test-session",
            "source": "manual",
            "declaredBy": "user",
            "category": "hcp-custom:task_lessons",
            "runnerId": runner_id,
        }),
    );
    let (status, saved) = fx
        .send_with_auth(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/memory"),
            Some(body),
            &format!("Bearer {RUNNER_TOKEN}"),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(saved["memory"]["declarationType"], "model-inferred");
    assert_eq!(saved["memory"]["confidence"], "medium");
    assert_eq!(saved["memory"]["category"], "hcp-custom:task_lessons");
    let audits = fx.audit_metadata("memory_saved").await;
    assert_eq!(audits.last().unwrap()["declarationType"], "model-inferred");
    assert_eq!(
        audits.last().unwrap()["category"],
        "hcp-custom:task_lessons"
    );
    fx.cleanup().await;
}
