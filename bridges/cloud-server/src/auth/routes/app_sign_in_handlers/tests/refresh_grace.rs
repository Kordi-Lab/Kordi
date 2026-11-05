//! A retried or concurrent refresh gets the same successor instead of
//! signing the app out; later reuse still revokes the sign-in.

use super::*;
use crate::auth::app_sign_in::codes::hash_code;

async fn reason(harness: &Harness, body: &Value) -> Option<String> {
    let row: (Option<String>,) =
        query_as("SELECT revoked_reason FROM cloud_app_sign_ins WHERE sign_in_id = $1")
            .bind(token(body, "sign_in_id"))
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    row.0
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_lost_refresh_response_is_answered_again_with_the_same_successor() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let first = harness.signed_in(&account, DESKTOP, LOOPBACK).await;
    let old = token(&first, "refresh_token");
    let (status, lost) = harness.refresh(DESKTOP, &old).await;
    assert_eq!(status, StatusCode::OK, "{lost}");
    // The app never saw that response and retries with the old token.
    let (status, retried) = harness.refresh(DESKTOP, &old).await;
    assert_eq!(status, StatusCode::OK, "{retried}");
    assert_eq!(retried["refresh_token"], lost["refresh_token"]);
    assert_eq!(retried["access_token"], lost["access_token"]);
    assert_eq!(retried["sign_in_id"], first["sign_in_id"]);
    assert_eq!(
        harness.me_status(&token(&retried, "access_token")).await,
        StatusCode::OK
    );
    // Only hashes are stored.
    let stored: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_app_refresh_tokens \
         WHERE token_hash = $1 OR successor_token_hash = $1",
    )
    .bind(token(&retried, "refresh_token"))
    .fetch_one(&harness.pool)
    .await
    .unwrap();
    assert_eq!(stored.0, 0);

    // Once the successor is used, the old token is reuse again.
    let (status, next) = harness
        .refresh(DESKTOP, &token(&retried, "refresh_token"))
        .await;
    assert_eq!(status, StatusCode::OK, "{next}");
    let (status, body) = harness.refresh(DESKTOP, &old).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], "invalid_grant");
    assert_eq!(
        reason(&harness, &first).await.as_deref(),
        Some("refresh_token_reuse")
    );
    assert_eq!(
        harness.me_status(&token(&next, "access_token")).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn concurrent_refreshes_get_one_successor() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let first = harness.signed_in(&account, DESKTOP, LOOPBACK).await;
    let old = token(&first, "refresh_token");
    let (left, right) = tokio::join!(
        harness.refresh(DESKTOP, &old),
        harness.refresh(DESKTOP, &old)
    );
    assert_eq!(left.0, StatusCode::OK, "{}", left.1);
    assert_eq!(right.0, StatusCode::OK, "{}", right.1);
    assert_eq!(left.1["refresh_token"], right.1["refresh_token"]);
    assert_eq!(left.1["access_token"], right.1["access_token"]);
    let live: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_app_refresh_tokens \
         WHERE sign_in_id = $1 AND rotated_at IS NULL",
    )
    .bind(token(&first, "sign_in_id"))
    .fetch_one(&harness.pool)
    .await
    .unwrap();
    assert_eq!(live.0, 1);
    assert_eq!(reason(&harness, &first).await, None);
    let (status, body) = harness
        .refresh(DESKTOP, &token(&left.1, "refresh_token"))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn reuse_after_the_grace_period_revokes_the_sign_in() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let first = harness.signed_in(&account, DESKTOP, LOOPBACK).await;
    let old = token(&first, "refresh_token");
    let (status, second) = harness.refresh(DESKTOP, &old).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    query(
        "UPDATE cloud_app_refresh_tokens SET rotated_at = rotated_at - make_interval(secs => $1) \
         WHERE token_hash = $2",
    )
    .bind((crate::auth::app_sign_in::tokens::REFRESH_REUSE_GRACE_SECS + 1) as f64)
    .bind(hash_code(&old))
    .execute(&harness.pool)
    .await
    .unwrap();
    let (status, body) = harness.refresh(DESKTOP, &old).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        reason(&harness, &first).await.as_deref(),
        Some("refresh_token_reuse")
    );
    let (status, _) = harness
        .refresh(DESKTOP, &token(&second, "refresh_token"))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
