//! Database tests for shared documents. See `db_fixture.rs` for the
//! `DATABASE_URL` rule and the object storage stub.

use axum::http::StatusCode;
use chrono::Utc;
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::db_fixture::*;

#[tokio::test]
async fn owner_share_is_reused_and_members_cannot_share() {
    let Some(f) = fixture().await else { return };
    let first = create_share(&f).await;
    assert!(first["shareId"].as_str().unwrap().starts_with("docshare_"));
    assert_eq!(first["accessMode"], "link");
    assert_eq!(first["readersCanAskAgent"], true);
    let token = token_of(&first);
    assert!(token.starts_with("kordi_ds_") && token.len() == 52);
    assert_eq!(first["deepLink"], format!("kordi://document/{token}"));
    let again = create_share(&f).await;
    assert_eq!(again["shareId"], first["shareId"]);
    assert_eq!(again["shareUrl"], first["shareUrl"]);
    let (stored,): (String,) =
        query_as("SELECT token_hash FROM cloud_document_shares WHERE share_id = $1")
            .bind(first["shareId"].as_str().unwrap())
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(stored, super::super::tokens::hash_share_token(&token));

    let uri = format!("/v1/cloud/documents/{}/shares", f.attachment_id);
    let (status, body) = send(&f.app, "POST", &uri, Some(&f.member_token), Some(json!({}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, list) = send(&f.app, "GET", &uri, Some(&f.owner_token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["shares"].as_array().unwrap().len(), 1);

    let (status, document) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/documents/{}", f.attachment_id),
        Some(&f.owner_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{document}");
    assert_eq!(document["viewer"], "owner");
    assert_eq!(document["title"], "Field notes");
    assert_eq!(document["fileName"], "field-notes.md");
    assert_eq!(document["sessionTitle"], "Research");
    assert_eq!(document["blocks"].as_array().unwrap().len(), 3);
    assert_eq!(document["share"]["shareId"], first["shareId"]);
    assert_eq!(document["viewerCan"]["share"], true);
    let (status, member_view) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/documents/{}", f.attachment_id),
        Some(&f.member_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(member_view["viewer"], "member");
    assert!(member_view["share"].is_null());
}

#[tokio::test]
async fn non_members_cannot_read_and_revoked_links_are_off() {
    let Some(f) = fixture().await else { return };
    let uri = format!("/v1/cloud/documents/{}", f.attachment_id);
    let (status, _) = send(&f.app, "GET", &uri, Some(&f.outsider_token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let share = create_share(&f).await;
    let token = token_of(&share);
    let public_uri = format!("/v1/cloud/public/documents/{token}");
    let (status, public) = send(&f.app, "GET", &public_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{public}");
    assert_eq!(public["viewer"], "public");
    assert!(public["share"].is_null());
    assert_eq!(public["author"]["accountId"], "");
    assert!(
        !public.to_string().contains(&f.owner),
        "public payloads carry no account ids"
    );
    assert!(
        !public.to_string().contains("example.test"),
        "no email addresses"
    );

    let (status, _) = send(
        &f.app,
        "DELETE",
        &format!(
            "/v1/cloud/documents/shares/{}",
            share["shareId"].as_str().unwrap()
        ),
        Some(&f.owner_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = send(&f.app, "GET", &public_uri, None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["errorCode"], "document_link_off");
    assert_eq!(body["message"], "This link is off");
    let (status, _, html) = page(&f.app, &format!("/d/{token}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(html.contains("This link is off"));
    let (audits,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_audit_events WHERE account_id = $1 AND event_type IN ('document.share.created', 'document.share.revoked')")
        .bind(&f.owner)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(audits, 2);
}

#[tokio::test]
async fn public_reactions_toggle_with_the_same_reader_key() {
    let Some(f) = fixture().await else { return };
    let token = token_of(&create_share(&f).await);
    let uri = format!("/v1/cloud/public/documents/{token}/reactions");
    let body = json!({"blockId": "b1", "reaction": "\u{1f44d}", "readerKey": READER_KEY, "readerName": "Priya"});
    let (status, on) = send(&f.app, "POST", &uri, None, Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{on}");
    let reactions = on["reactions"].as_array().unwrap();
    assert_eq!(reactions.len(), 1);
    assert_eq!(reactions[0]["mine"], true);
    assert_eq!(reactions[0]["actor"]["displayName"], "Priya");
    assert_eq!(reactions[0]["actor"]["readerKey"], READER_KEY);
    assert!(reactions[0]["actor"]["accountId"].is_null());
    let (status, off) = send(&f.app, "POST", &uri, None, Some(body)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(off["reactions"].as_array().unwrap().is_empty());
    let missing = json!({"blockId": "b9", "reaction": "\u{1f44d}", "readerKey": READER_KEY, "readerName": "Priya"});
    let (status, _) = send(&f.app, "POST", &uri, None, Some(missing)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn comments_record_agent_mentions_and_only_authors_edit() {
    let Some(f) = fixture().await else { return };
    let token = token_of(&create_share(&f).await);
    let uri = format!("/v1/cloud/public/documents/{token}/comments");
    let body = json!({"blockId": "b2", "body": "@agent what does this mean?", "readerKey": READER_KEY, "readerName": "Priya"});
    let (status, comment) = send(&f.app, "POST", &uri, None, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{comment}");
    assert!(comment["commentId"]
        .as_str()
        .unwrap()
        .starts_with("doccmt_"));
    assert_eq!(comment["mentionsAgent"], true);
    assert_eq!(comment["author"]["displayName"], "Priya");
    assert_eq!(comment["mine"], true);
    let (stored,): (bool,) =
        query_as("SELECT mentions_agent FROM cloud_document_comments WHERE comment_id = $1")
            .bind(comment["commentId"].as_str().unwrap())
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(stored);

    let own_uri = format!("/v1/cloud/documents/{}/comments", f.attachment_id);
    let (status, own) = send(
        &f.app,
        "POST",
        &own_uri,
        Some(&f.owner_token),
        Some(json!({"blockId": "b1", "body": "Plain note"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{own}");
    assert_eq!(own["mentionsAgent"], false);
    let comment_uri = format!(
        "/v1/cloud/documents/comments/{}",
        own["commentId"].as_str().unwrap()
    );
    let (status, _) = send(
        &f.app,
        "PATCH",
        &comment_uri,
        Some(&f.member_token),
        Some(json!({"body": "Hijacked"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, csp, html) = page(&f.app, &format!("/d/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        csp.starts_with("default-src 'none'; style-src 'nonce-"),
        "{csp}"
    );
    assert!(html.contains("<h1>Field notes</h1>") && html.contains("First paragraph."));
    let (status, _, _) = page(&f.app, &format!("/d/{token}/raw")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "Markdown has no raw view");

    let (status, _) = send(&f.app, "DELETE", &comment_uri, Some(&f.member_token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = send(
        &f.app,
        "PATCH",
        &comment_uri,
        Some(&f.outsider_token),
        Some(json!({"body": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, edited) = send(
        &f.app,
        "PATCH",
        &comment_uri,
        Some(&f.owner_token),
        Some(json!({"body": "Edited", "resolved": true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["body"], "Edited");
    assert!(edited["editedAt"].is_string() && edited["resolvedAt"].is_string());
}

#[tokio::test]
async fn public_writes_stop_at_the_per_share_caps() {
    let Some(f) = fixture().await else { return };
    let token = token_of(&create_share(&f).await);
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_document_comments (comment_id, attachment_id, block_id, \
         author_reader_key, author_name, body, created_at) \
         SELECT 'doccmt_fill_' || n || '_' || $2, $1, 'b1', 'filler-key-0123456789', 'Filler', 'x', $3 \
         FROM generate_series(1, 500) n",
    )
    .bind(&f.attachment_id)
    .bind(Uuid::new_v4().simple().to_string())
    .bind(&now)
    .execute(&f.pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_document_reactions (reaction_id, attachment_id, block_id, reaction, \
         actor_reader_key, actor_name, created_at) \
         SELECT 'docrx_fill_' || n || '_' || $2, $1, 'b1', '\u{1f44d}', 'filler-' || n || '-0123456789', 'Filler', $3 \
         FROM generate_series(1, 2000) n",
    )
    .bind(&f.attachment_id)
    .bind(Uuid::new_v4().simple().to_string())
    .bind(&now)
    .execute(&f.pool)
    .await
    .unwrap();
    let comment = json!({"blockId": "b1", "body": "One more", "readerKey": READER_KEY, "readerName": "Priya"});
    let (status, body) = send(
        &f.app,
        "POST",
        &format!("/v1/cloud/public/documents/{token}/comments"),
        None,
        Some(comment),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["errorCode"], "document_limit_reached");
    let reaction = json!({"blockId": "b1", "reaction": "\u{1f525}", "readerKey": READER_KEY, "readerName": "Priya"});
    let (status, _) = send(
        &f.app,
        "POST",
        &format!("/v1/cloud/public/documents/{token}/reactions"),
        None,
        Some(reaction),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}
