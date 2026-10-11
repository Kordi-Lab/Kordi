//! Saves are idempotent on content within one scope.

use super::*;

#[tokio::test]
async fn memory_save_with_the_same_text_returns_the_existing_row() {
    let Some(fx) = fixture().await else { return };
    let mut unlabeled = memory_body("Prefer short status updates");
    unlabeled["scopeLabel"] = Value::Null;
    let (status, first) = fx.send("POST", "/v1/cloud/memory", Some(unlabeled)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(first["memory"]["scopeLabel"], Value::Null);
    let memory_id = first["memory"]["memoryId"].as_str().unwrap().to_string();

    // Same scope and the same text after whitespace collapsing.
    let (status, again) = fx
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(memory_body("  Prefer  short\nstatus updates ")),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["memory"]["memoryId"], memory_id.as_str());
    assert_eq!(again["memory"]["createdAt"], first["memory"]["createdAt"]);
    assert_eq!(again["memory"]["scopeLabel"], "Launch planning");
    let first_updated =
        chrono::DateTime::parse_from_rfc3339(first["memory"]["updatedAt"].as_str().unwrap())
            .unwrap();
    let touched =
        chrono::DateTime::parse_from_rfc3339(again["memory"]["updatedAt"].as_str().unwrap())
            .unwrap();
    assert!(touched >= first_updated);

    // A new clientMemoryId with the same content still returns the row.
    let mut with_client_id = memory_body("Prefer short status updates");
    with_client_id["clientMemoryId"] = json!(format!("client_{}", uuid::Uuid::new_v4().simple()));
    let (status, by_client) = fx
        .send("POST", "/v1/cloud/memory", Some(with_client_id))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(by_client["memory"]["memoryId"], memory_id.as_str());

    // Case, scope, and scope id still distinguish memories.
    let mut other_scope = memory_body("Prefer short status updates");
    other_scope["scopeId"] = json!("session-2");
    for body in [memory_body("prefer short status updates"), other_scope] {
        let (status, _) = fx.send("POST", "/v1/cloud/memory", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED);
    }
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"].as_array().unwrap().len(), 3);
    assert_eq!(fx.audit_count("memory_saved").await, 3);

    // An archived memory does not block saving the same text again.
    let (status, _) = fx
        .send("DELETE", &format!("/v1/cloud/memory/{memory_id}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, fresh) = fx
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(memory_body("Prefer short status updates")),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_ne!(fresh["memory"]["memoryId"], memory_id.as_str());
}
