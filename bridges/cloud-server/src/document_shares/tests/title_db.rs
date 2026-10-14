//! Database tests for renaming documents.

use axum::http::StatusCode;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::db_fixture::*;

fn document_uri(f: &Fixture) -> String {
    format!("/v1/cloud/documents/{}", f.attachment_id)
}

async fn title_events(f: &Fixture, account: &str) -> Vec<Value> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT payload FROM cloud_chat_user_sync_events WHERE account_id = $1 \
         AND event_type = 'document.updated' AND payload->>'change' = 'title' ORDER BY stream_seq",
    )
    .bind(account)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    rows.into_iter().map(|(payload,)| payload).collect()
}

#[tokio::test]
async fn members_rename_a_document_and_everyone_hears_about_it() {
    let Some(f) = fixture().await else { return };
    // Without a leading heading the title is the file name until renamed.
    let (status, saved) = send(
        &f.app,
        "PUT",
        &format!("{}/content", document_uri(&f)),
        Some(&f.owner_token),
        Some(json!({"baseRevision": 1, "source": "First paragraph.\n"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let file_name = saved["fileName"].as_str().unwrap().to_string();
    assert_ne!(saved["title"], "Q4 plan");

    let (status, renamed) = send(
        &f.app,
        "PATCH",
        &document_uri(&f),
        Some(&f.member_token),
        Some(json!({"title": "  Q4 \n plan "})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["title"], "Q4 plan");
    assert_eq!(renamed["fileName"], file_name.as_str());
    assert_eq!(renamed["revision"], 2);

    let (status, owner_view) =
        send(&f.app, "GET", &document_uri(&f), Some(&f.owner_token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(owner_view["title"], "Q4 plan");
    for account in [&f.owner, &f.member] {
        let events = title_events(&f, account).await;
        assert_eq!(events.len(), 1, "{account}");
        assert_eq!(events[0]["attachmentId"], f.attachment_id.as_str());
        assert_eq!(events[0]["title"], "Q4 plan");
        assert_eq!(events[0]["revision"], 2);
        assert_eq!(events[0]["updatedByAccountId"], f.member.as_str());
    }
    assert!(title_events(&f, &f.outsider).await.is_empty());
    let (critical,): (bool,) = query_as(
        "SELECT bool_or(critical) FROM cloud_chat_user_sync_events WHERE account_id = $1 \
         AND event_type = 'document.updated'",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(
        !critical,
        "older clients must be able to skip document.updated"
    );

    // The same title again changes nothing and announces nothing.
    let (status, _) = send(
        &f.app,
        "PATCH",
        &document_uri(&f),
        Some(&f.owner_token),
        Some(json!({"title": "Q4 plan"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(title_events(&f, &f.owner).await.len(), 1);

    // A leading heading is the title readers see; the stored title waits behind it.
    let (status, headed) = send(
        &f.app,
        "PUT",
        &format!("{}/content", document_uri(&f)),
        Some(&f.owner_token),
        Some(json!({"baseRevision": 2, "source": "# Field notes\n\nFirst paragraph.\n"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{headed}");
    assert_eq!(headed["title"], "Field notes");
}

#[tokio::test]
async fn invalid_titles_and_accounts_without_edit_rights_are_refused() {
    let Some(f) = fixture().await else { return };
    let rename = |title: Value| json!({ "title": title });
    for title in [json!(""), json!(" \t\n"), json!("a".repeat(201))] {
        let (status, refused) = send(
            &f.app,
            "PATCH",
            &document_uri(&f),
            Some(&f.owner_token),
            Some(rename(title)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["errorCode"], "document_title_invalid");
    }

    let (status, _) = send(
        &f.app,
        "PATCH",
        &document_uri(&f),
        Some(&f.outsider_token),
        Some(rename(json!("Hijacked"))),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "no read access, no hint the document exists"
    );

    // Readable through the media library, but not a member: no edit, no rename.
    let now = Utc::now().to_rfc3339();
    query("INSERT INTO cloud_expressive_media_items (item_id, account_id, attachment_id, kind, name, mime_type, size_bytes, created_at, updated_at) VALUES ($1, $2, $3, 'sticker', 'notes', 'text/markdown', 10, $4, $4)")
        .bind(format!("media_{}", Uuid::new_v4().simple()))
        .bind(&f.outsider)
        .bind(&f.attachment_id)
        .bind(&now)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, refused) = send(
        &f.app,
        "PATCH",
        &document_uri(&f),
        Some(&f.outsider_token),
        Some(rename(json!("Hijacked"))),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["errorCode"], "document_edit_forbidden");

    let (stored,): (Option<String>,) =
        query_as("SELECT document_title FROM cloud_attachments WHERE attachment_id = $1")
            .bind(&f.attachment_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(stored, None);
}
