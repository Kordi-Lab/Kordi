//! Quote guard hook, account isolation, and account deletion checks.

use super::*;

#[tokio::test]
async fn memory_quote_guard_uses_protected_texts() {
    use kordi_tools::memory_guard::{check_memory_text, MemoryGuardError, MemoryGuardOptions};

    // The route feeds `protected_texts_for_scope`, which is empty until #1687.
    let Some(fx) = fixture().await else { return };
    assert!(crate::memory_store::protected_texts_for_scope(
        &fx.pool,
        &fx.account_id,
        "conversation",
        "session-1"
    )
    .await
    .unwrap()
    .is_empty());
    let protected = vec![
        "we should move the launch to next Tuesday because the review slipped again".to_string(),
    ];
    let options = MemoryGuardOptions {
        exclude_sensitive: true,
        protected_texts: &protected,
    };
    assert_eq!(
        check_memory_text(
            "Note: we should move the launch to next Tuesday because the review slipped",
            &options
        ),
        Err(MemoryGuardError::QuotesProtectedText)
    );
    assert!(check_memory_text(
        "Note: we should move the launch to next Tuesday because the review",
        &options
    )
    .is_ok());
}

#[tokio::test]
async fn memory_rows_are_private_to_the_account() {
    let Some(owner) = fixture().await else { return };
    let Some(other) = fixture().await else { return };
    let (_, saved) = owner
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(memory_body("Use the staging bucket")),
        )
        .await;
    let memory_id = saved["memory"]["memoryId"].as_str().unwrap().to_string();
    let (status, _) = other
        .send(
            "PATCH",
            &format!("/v1/cloud/memory/{memory_id}"),
            Some(json!({ "text": "Changed" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = other
        .send("DELETE", &format!("/v1/cloud/memory/{memory_id}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, list) = other.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"], json!([]));

    // Account deletion removes memories and settings.
    owner
        .send(
            "PUT",
            "/v1/cloud/memory/settings",
            Some(json!({ "memoryEnabled": false })),
        )
        .await;
    query("DELETE FROM cloud_accounts WHERE account_id = $1")
        .bind(&owner.account_id)
        .execute(&owner.pool)
        .await
        .unwrap();
    let (memories, settings): (i64, i64) = query_as(
        "SELECT (SELECT COUNT(*) FROM cloud_account_memories WHERE owner_account_id = $1), \
                (SELECT COUNT(*) FROM cloud_account_memory_settings WHERE account_id = $1)",
    )
    .bind(&owner.account_id)
    .fetch_one(&owner.pool)
    .await
    .unwrap();
    assert_eq!((memories, settings), (0, 0));
}
