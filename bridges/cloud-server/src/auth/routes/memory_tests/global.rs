//! Global memories belong to the whole account and use the scope id `account`.

use super::*;

fn global_body(text: &str) -> Value {
    json!({
        "scope": "global",
        "scopeId": "account",
        "scopeLabel": "Ignored label",
        "source": "user_correction",
        "text": text,
    })
}

#[tokio::test]
async fn global_memory_is_saved_without_a_label_and_listed_with_other_scopes() {
    let Some(fx) = fixture().await else { return };
    let (status, saved) = fx
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(global_body("Always answer in British English")),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(saved["memory"]["scope"], "global");
    assert_eq!(saved["memory"]["scopeId"], "account");
    assert_eq!(saved["memory"]["scopeLabel"], Value::Null);

    // The same text again is the same memory.
    let (status, again) = fx
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(global_body("Always answer in British English")),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["memory"]["memoryId"], saved["memory"]["memoryId"]);
    assert_eq!(again["memory"]["scopeLabel"], Value::Null);

    let (status, _) = fx
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(memory_body("Use metric units here")),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    let mut scopes = list["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|memory| memory["scope"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    scopes.sort();
    assert_eq!(scopes, ["conversation", "global"]);
}

#[tokio::test]
async fn global_memory_rejects_any_scope_id_but_account() {
    let Some(fx) = fixture().await else { return };
    for scope_id in ["session-1", "Account", "acct_other"] {
        let mut body = global_body("Always answer in British English");
        body["scopeId"] = json!(scope_id);
        let (status, error) = fx.send("POST", "/v1/cloud/memory", Some(body)).await;
        assert_eq!(
            (status, error["errorCode"].clone()),
            (StatusCode::BAD_REQUEST, json!("invalid_scope_id")),
            "{scope_id}"
        );
    }
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert!(list["memories"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn runner_saves_global_memories_for_the_run_owner() {
    let Some(fx) = fixture().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    let runner_id = "runner-memory-global";
    let run_id = fx.leased_run(runner_id).await;
    let mut body = global_body("Prefer bullet lists");
    body["runnerId"] = json!(runner_id);
    let (status, saved) = fx
        .send_with_auth(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/memory"),
            Some(body.clone()),
            &format!("Bearer {RUNNER_TOKEN}"),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    assert_eq!(saved["memory"]["scope"], "global");

    body["scopeId"] = json!("car_other");
    let (status, error) = fx
        .send_with_auth(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/memory"),
            Some(body),
            &format!("Bearer {RUNNER_TOKEN}"),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errorCode"], "invalid_scope_id");
}
