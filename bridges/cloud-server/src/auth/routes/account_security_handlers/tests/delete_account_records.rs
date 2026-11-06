//! What deleting an account leaves in other people's records: comments on
//! their documents, their digests, and the access waitlist.

use super::*;
use crate::deleted_account::{DELETED_ACCOUNT_ID, DELETED_DISPLAY_NAME};

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn deletion_keeps_comments_and_clears_digests_and_the_waitlist() {
    let harness = harness().await;
    let pool = &harness.pool;
    let password = strong_password();
    let dana = harness.account(Some(&password), true).await;
    let kim = harness.account(None, true).await;
    let now = Utc::now().to_rfc3339();
    // A document Kim owns, with Dana's comment and Kim's reply to it.
    let document = format!("att_{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, size_bytes, \
         content_type, sha256_hex, created_at, finalized_at) \
         VALUES ($1, $2, $3, 4, 'text/markdown', 'abcd', $4, $4)",
    )
    .bind(&document)
    .bind(&kim.account_id)
    .bind(format!("attachments/{}/{document}", kim.account_id))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    let comment = format!("doccmt_{}", uuid::Uuid::new_v4().simple());
    let reply = format!("doccmt_{}", uuid::Uuid::new_v4().simple());
    for (id, parent, author, name) in [
        (&comment, None, &dana.account_id, "Dana Doe"),
        (&reply, Some(&comment), &kim.account_id, "Kim"),
    ] {
        query(
            "INSERT INTO cloud_document_comments (comment_id, attachment_id, block_id, \
             parent_comment_id, author_account_id, author_name, body, created_at) \
             VALUES ($1, $2, 'b1', $3, $4, $5, 'Looks good', $6)",
        )
        .bind(id)
        .bind(&document)
        .bind(parent)
        .bind(author)
        .bind(name)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
    }
    // Kim's digest was built from one of Dana's messages.
    query(
        "INSERT INTO cloud_account_digests (account_id, input_hash, snapshot_json, \
         snapshot_input_json) VALUES ($1, 'hash', $2, $3)",
    )
    .bind(&kim.account_id)
    .bind(json!({"items": [{"title": "Reply to Dana Doe"}]}))
    .bind(json!({"sources": [{"senderAccountId": dana.account_id}]}))
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_access_waitlist (email, first_requested_at, last_requested_at) \
         VALUES ($1, now(), now())",
    )
    .bind(dana.email.to_uppercase())
    .execute(pool)
    .await
    .unwrap();

    let (status, body) = harness
        .post(
            "/delete",
            Auth::Bearer(&dana.token),
            json!({ "currentPassword": password }),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let comments: Vec<(String, Option<String>, String)> = query_as(
        "SELECT comment_id, author_account_id, author_name FROM cloud_document_comments \
         WHERE attachment_id = $1 ORDER BY created_at, comment_id",
    )
    .bind(&document)
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(comments.len(), 2, "the reply survives with its parent");
    let kept = comments.iter().find(|(id, _, _)| id == &comment).unwrap();
    assert_eq!(kept.1.as_deref(), Some(DELETED_ACCOUNT_ID));
    assert_eq!(kept.2, DELETED_DISPLAY_NAME);

    let (snapshot, input, hash): (Option<Value>, Option<Value>, String) = query_as(
        "SELECT snapshot_json, snapshot_input_json, input_hash FROM cloud_account_digests \
         WHERE account_id = $1",
    )
    .bind(&kim.account_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!((snapshot, input, hash.as_str()), (None, None, ""));

    let (waitlisted,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_access_waitlist WHERE lower(email) = lower($1)")
            .bind(&dana.email)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(waitlisted, 0);
}
