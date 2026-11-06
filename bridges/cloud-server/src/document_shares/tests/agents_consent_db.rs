//! A comment never starts an agent run for someone who declined AI
//! (`crate::ai_consent`), and the refused comment is not stored.

use axum::http::StatusCode;
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};

use super::agents_fixture::*;
use super::db_fixture::*;

#[tokio::test]
async fn a_mention_by_someone_who_declined_ai_is_refused() {
    let Some(f) = fixture().await else { return };
    query("UPDATE cloud_accounts SET ai_consent_status = 'declined' WHERE account_id = $1")
        .bind(&f.member)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, body) = send(
        &f.app,
        "POST",
        &comments_uri(&f),
        Some(&f.member_token),
        Some(json!({ "blockId": "b1", "body": "@Kordi can you tighten this?" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["errorCode"], "ai_consent_required");
    let (runs,): (i64,) = query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_fallback_runs WHERE requester_account_id = $1",
    )
    .bind(&f.member)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(runs, 0);
    // A comment without a mention still posts.
    let plain = post_comment(&f, &f.member_token, "b1", "Plain note").await;
    assert!(plain["agentRun"].is_null(), "{plain}");
}
