//! Which scopes runs may save into, former group members, the group
//! sensitive filter, and edits that repeat another memory.

use super::group_shared::{group, ids};
use super::*;

fn scoped(scope: &str, scope_id: &str, runner_id: &str) -> Value {
    json!({
        "scope": scope,
        "scopeId": scope_id,
        "source": "outcome",
        "text": format!("Saved into {scope} {}", uuid::Uuid::new_v4().simple()),
        "runnerId": runner_id,
    })
}

#[tokio::test]
async fn runner_saves_only_into_the_runs_own_scopes() {
    let Some(g) = group().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    let runner_auth = format!("Bearer {RUNNER_TOKEN}");
    let runner_id = format!("runner_{}", uuid::Uuid::new_v4().simple());
    // A asks B's agent in the group: the run is B's, the request is A's.
    let run_id =
        g.b.leased_run_in(&runner_id, &g.session_id(), &g.a.account_id)
            .await;
    let uri = format!("/v1/cloud/agent-runs/{run_id}/memory");
    let session_id = g.session_id();
    let other_group = uuid::Uuid::new_v4().to_string();

    for (scope, scope_id) in [
        ("conversation", session_id.as_str()),
        ("group", g.group_id.as_str()),
    ] {
        let (status, saved) =
            g.b.send_with_auth(
                "POST",
                &uri,
                Some(scoped(scope, scope_id, &runner_id)),
                &runner_auth,
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{scope}: {saved}");
        assert_eq!(saved["memory"]["ownerAccountId"], g.b.account_id.as_str());
    }
    for (scope, scope_id) in [
        ("conversation", "session:direct-person:someone-else"),
        ("group", other_group.as_str()),
        ("project", "proj_1"),
        ("global", "account"),
    ] {
        let (status, error) =
            g.b.send_with_auth(
                "POST",
                &uri,
                Some(scoped(scope, scope_id, &runner_id)),
                &runner_auth,
            )
            .await;
        assert_eq!(
            (status, error["errorCode"].clone()),
            (StatusCode::FORBIDDEN, json!("memory_scope_not_allowed")),
            "{scope} {scope_id}"
        );
    }

    // B's own request may save a global memory.
    let own_runner = format!("runner_{}", uuid::Uuid::new_v4().simple());
    let own_run =
        g.b.leased_run_in(&own_runner, &g.session_id(), &g.b.account_id)
            .await;
    let (status, _) =
        g.b.send_with_auth(
            "POST",
            &format!("/v1/cloud/agent-runs/{own_run}/memory"),
            Some(scoped("global", "account", &own_runner)),
            &runner_auth,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);

    g.cleanup().await;
}

#[tokio::test]
async fn former_member_can_delete_but_not_edit_group_memories() {
    let Some(g) = group().await else { return };
    let (_, from_a) =
        g.a.send("POST", "/v1/cloud/memory", Some(g.body("A's group note")))
            .await;
    let a_id = from_a["memory"]["memoryId"].as_str().unwrap().to_string();
    let (_, from_b) =
        g.b.send("POST", "/v1/cloud/memory", Some(g.body("B's group note")))
            .await;
    let b_id = from_b["memory"]["memoryId"].as_str().unwrap().to_string();

    query(
        "UPDATE cloud_chat_conversation_members SET membership_state = 'left' \
         WHERE conversation_id = $1::uuid AND account_id = $2",
    )
    .bind(&g.group_id)
    .bind(&g.b.account_id)
    .execute(&g.a.pool)
    .await
    .unwrap();

    let (status, error) =
        g.b.send(
            "PATCH",
            &format!("/v1/cloud/memory/{b_id}"),
            Some(json!({ "text": "Changed after leaving" })),
        )
        .await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::FORBIDDEN, json!("not_a_group_member"))
    );
    let (status, error) =
        g.b.send("DELETE", &format!("/v1/cloud/memory/{a_id}"), None)
            .await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::FORBIDDEN, json!("not_a_group_member"))
    );
    let (status, _) =
        g.b.send("DELETE", &format!("/v1/cloud/memory/{b_id}"), None)
            .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, list) = g.a.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(ids(&list), vec![a_id]);
    g.cleanup().await;
}

#[tokio::test]
async fn group_memories_always_use_the_sensitive_filter() {
    let Some(g) = group().await else { return };
    let sensitive = "Remember my password is hunter2";
    let (status, _) =
        g.b.send(
            "PUT",
            "/v1/cloud/memory/settings",
            Some(json!({ "excludeSensitive": false })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, error) =
        g.b.send("POST", "/v1/cloud/memory", Some(g.body(sensitive)))
            .await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::UNPROCESSABLE_ENTITY, json!("memory_rejected"))
    );
    // The writer's own setting still applies to their private scopes.
    let (status, _) =
        g.b.send("POST", "/v1/cloud/memory", Some(memory_body(sensitive)))
            .await;
    assert_eq!(status, StatusCode::CREATED);

    let (_, saved) =
        g.b.send(
            "POST",
            "/v1/cloud/memory",
            Some(g.body("Demo on Thursdays")),
        )
        .await;
    let memory_id = saved["memory"]["memoryId"].as_str().unwrap().to_string();
    let (status, error) =
        g.b.send(
            "PATCH",
            &format!("/v1/cloud/memory/{memory_id}"),
            Some(json!({ "text": sensitive })),
        )
        .await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::UNPROCESSABLE_ENTITY, json!("memory_rejected"))
    );
    g.cleanup().await;
}

#[tokio::test]
async fn edit_that_repeats_another_memory_is_a_conflict() {
    let Some(fx) = fixture().await else { return };
    let (_, first) = fx
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(memory_body("Ship on Fridays")),
        )
        .await;
    let first_id = first["memory"]["memoryId"].as_str().unwrap().to_string();
    let (_, second) = fx
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(memory_body("Ship on Mondays")),
        )
        .await;
    let second_id = second["memory"]["memoryId"].as_str().unwrap().to_string();

    let (status, error) = fx
        .send(
            "PATCH",
            &format!("/v1/cloud/memory/{second_id}"),
            Some(json!({ "text": "  Ship  on Fridays " })),
        )
        .await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::CONFLICT, json!("memory_exists"))
    );
    // Saving a memory's own text again is not a conflict.
    let (status, _) = fx
        .send(
            "PATCH",
            &format!("/v1/cloud/memory/{first_id}"),
            Some(json!({ "text": "Ship on Fridays" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    // Once the first is deleted, its text is free again.
    fx.send("DELETE", &format!("/v1/cloud/memory/{first_id}"), None)
        .await;
    let (status, _) = fx
        .send(
            "PATCH",
            &format!("/v1/cloud/memory/{second_id}"),
            Some(json!({ "text": "Ship on Fridays" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    fx.cleanup().await;

    // In a group, another member's memory counts too.
    let Some(g) = group().await else { return };
    g.a.send(
        "POST",
        "/v1/cloud/memory",
        Some(g.body("Demo on Thursdays")),
    )
    .await;
    let (_, from_b) =
        g.b.send("POST", "/v1/cloud/memory", Some(g.body("Demo on Fridays")))
            .await;
    let b_id = from_b["memory"]["memoryId"].as_str().unwrap().to_string();
    let (status, error) =
        g.b.send(
            "PATCH",
            &format!("/v1/cloud/memory/{b_id}"),
            Some(json!({ "text": "Demo on Thursdays" })),
        )
        .await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::CONFLICT, json!("memory_exists"))
    );
    g.cleanup().await;
}
