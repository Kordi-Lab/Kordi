//! Database tests for saving edited documents.

use axum::http::StatusCode;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::db_fixture::*;

fn content_uri(f: &Fixture) -> String {
    format!("/v1/cloud/documents/{}/content", f.attachment_id)
}

fn block_sources(document: &Value) -> Vec<String> {
    document["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|block| block["source"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn owner_and_members_save_with_revisions_and_members_hear_about_it() {
    let Some(f) = fixture().await else { return };
    let uri = format!("/v1/cloud/documents/{}", f.attachment_id);
    let (status, first) = send(&f.app, "GET", &uri, Some(&f.owner_token), None).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["revision"], 1);
    assert_eq!(first["viewerCan"]["edit"], true);

    let edited = "# Field notes\n\nFirst paragraph, revised.\n\nSecond paragraph.\n";
    let (status, saved) = send(
        &f.app,
        "PUT",
        &content_uri(&f),
        Some(&f.owner_token),
        Some(json!({"baseRevision": 1, "source": edited})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 2);
    assert_eq!(block_sources(&saved)[1], "First paragraph, revised.");

    let (status, member_view) = send(&f.app, "GET", &uri, Some(&f.member_token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(member_view["revision"], 2);
    assert_eq!(member_view["viewerCan"]["edit"], true);
    let (status, by_member) = send(
        &f.app,
        "PUT",
        &content_uri(&f),
        Some(&f.member_token),
        Some(json!({"baseRevision": 2, "source": "# Field notes\n\nShort.\n"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{by_member}");
    assert_eq!(by_member["revision"], 3);

    let (updated_by, revision): (String, i64) = query_as("SELECT updated_by_account_id, revision FROM cloud_document_contents WHERE attachment_id = $1")
        .bind(&f.attachment_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!((updated_by.as_str(), revision), (f.member.as_str(), 3));
    for account in [&f.owner, &f.member] {
        let payloads: Vec<(Value,)> = query_as("SELECT payload FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = 'document.updated' ORDER BY stream_seq")
            .bind(account)
            .fetch_all(&f.pool)
            .await
            .unwrap();
        assert_eq!(payloads.len(), 2, "{account}");
        assert_eq!(payloads[1].0["attachmentId"], f.attachment_id.as_str());
        assert_eq!(payloads[1].0["revision"], 3);
        assert_eq!(payloads[1].0["updatedByAccountId"], f.member.as_str());
        assert!(payloads[1].0["sessionId"].is_string());
    }
    let (outsider_events,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = 'document.updated'")
        .bind(&f.outsider)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(outsider_events, 0);

    let (status, _) = send(
        &f.app,
        "PUT",
        &content_uri(&f),
        Some(&f.owner_token),
        Some(json!({"baseRevision": 3, "source": "x".repeat(1024 * 1024 + 1)})),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn stale_saves_get_the_current_document_back() {
    let Some(f) = fixture().await else { return };
    let save = |base: i64, source: &str| json!({"baseRevision": base, "source": source});
    let (status, _) = send(
        &f.app,
        "PUT",
        &content_uri(&f),
        Some(&f.owner_token),
        Some(save(1, "# Field notes\n\nMine.\n")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, conflict) = send(
        &f.app,
        "PUT",
        &content_uri(&f),
        Some(&f.member_token),
        Some(save(1, "# Field notes\n\nTheirs.\n")),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    assert_eq!(conflict["errorCode"], "document_revision_conflict");
    assert_eq!(conflict["revision"], 2);
    assert_eq!(block_sources(&conflict), ["# Field notes", "Mine."]);
    assert_eq!(conflict["attachmentId"], f.attachment_id.as_str());
}

#[tokio::test]
async fn accounts_that_are_not_active_members_cannot_edit() {
    let Some(f) = fixture().await else { return };
    let body = json!({"baseRevision": 1, "source": "# Hijacked\n"});
    let (status, _) = send(
        &f.app,
        "PUT",
        &content_uri(&f),
        Some(&f.outsider_token),
        Some(body.clone()),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "no read access, no hint the document exists"
    );

    // The outsider can read the file through their media library, but is a
    // member of no conversation that carries it.
    let now = Utc::now().to_rfc3339();
    query("INSERT INTO cloud_expressive_media_items (item_id, account_id, attachment_id, kind, name, mime_type, size_bytes, created_at, updated_at) VALUES ($1, $2, $3, 'sticker', 'notes', 'text/markdown', 10, $4, $4)")
        .bind(format!("media_{}", Uuid::new_v4().simple()))
        .bind(&f.outsider)
        .bind(&f.attachment_id)
        .bind(&now)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, view) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/documents/{}", f.attachment_id),
        Some(&f.outsider_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["viewerCan"]["edit"], false);
    let (status, refused) = send(
        &f.app,
        "PUT",
        &content_uri(&f),
        Some(&f.outsider_token),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["errorCode"], "document_edit_forbidden");

    let html_id = format!("att_html_{}", Uuid::new_v4().simple());
    query("INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, content_type, size_bytes, created_at, finalized_at) VALUES ($1, $2, $3, 'text/html', 10, $4, $4)")
        .bind(&html_id)
        .bind(&f.owner)
        .bind(format!("attachments/{}/{html_id}", f.owner))
        .bind(&now)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, html) = send(
        &f.app,
        "PUT",
        &format!("/v1/cloud/documents/{html_id}/content"),
        Some(&f.owner_token),
        Some(json!({"baseRevision": 1, "source": "<p>x</p>"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{html}");
    let (_, html_view) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/documents/{html_id}"),
        Some(&f.owner_token),
        None,
    )
    .await;
    assert_eq!(html_view["viewerCan"]["edit"], false);
    assert_eq!(html_view["revision"], 1);
}

#[tokio::test]
async fn public_reads_follow_the_saved_source() {
    let Some(f) = fixture().await else { return };
    let token = token_of(&create_share(&f).await);
    let (_, before) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/public/documents/{token}"),
        None,
        None,
    )
    .await;
    assert_eq!(before["revision"], 1);
    assert_eq!(before["viewerCan"]["edit"], false);
    let edited = "# Field notes\n\nA ==highlighted== <u>change</u>.\n";
    let (status, _) = send(
        &f.app,
        "PUT",
        &content_uri(&f),
        Some(&f.owner_token),
        Some(json!({"baseRevision": 1, "source": edited})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, after) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/public/documents/{token}"),
        None,
        None,
    )
    .await;
    assert_eq!(after["revision"], 2);
    assert_eq!(
        after["blocks"][1]["html"],
        "<p>A <mark>highlighted</mark> <u>change</u>.</p>\n"
    );
    let (status, _, html) = page(&f.app, &format!("/d/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("<mark>highlighted</mark>"));
    assert!(!html.contains("First paragraph."));
}

#[tokio::test]
async fn annotations_move_with_their_blocks_on_save() {
    let Some(f) = fixture().await else { return };
    let comments_uri = format!("/v1/cloud/documents/{}/comments", f.attachment_id);
    let reactions_uri = format!("/v1/cloud/documents/{}/reactions", f.attachment_id);
    let (_, on_first) = send(
        &f.app,
        "POST",
        &comments_uri,
        Some(&f.owner_token),
        Some(json!({"blockId": "b1", "body": "On the first paragraph"})),
    )
    .await;
    let (_, on_second) = send(
        &f.app,
        "POST",
        &comments_uri,
        Some(&f.member_token),
        Some(json!({"blockId": "b2", "body": "On the second paragraph"})),
    )
    .await;
    for (token, block) in [
        (&f.member_token, "b1"),
        (&f.member_token, "b2"),
        (&f.owner_token, "b0"),
        (&f.owner_token, "b1"),
    ] {
        let (status, _) = send(
            &f.app,
            "POST",
            &reactions_uri,
            Some(token),
            Some(json!({"blockId": block, "reaction": "\u{1f44d}"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    // Delete the first paragraph: the second moves from b2 to b1, and the
    // deleted block's annotations go to the nearest surviving block before it.
    let (status, saved) = send(
        &f.app,
        "PUT",
        &content_uri(&f),
        Some(&f.owner_token),
        Some(json!({"baseRevision": 1, "source": "# Field notes\n\nSecond paragraph.\n"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let block_of = |id: &Value| {
        saved["comments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|comment| comment["commentId"] == *id)
            .map(|comment| comment["blockId"].as_str().unwrap().to_string())
            .unwrap()
    };
    assert_eq!(block_of(&on_first["commentId"]), "b0");
    assert_eq!(block_of(&on_second["commentId"]), "b1");
    let mut reactions: Vec<String> = saved["reactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|reaction| reaction["blockId"].as_str().unwrap().to_string())
        .collect();
    reactions.sort();
    // The owner's reaction on the deleted block would duplicate theirs on b0.
    assert_eq!(reactions, ["b0", "b0", "b1"]);
}

#[tokio::test]
async fn swapping_blocks_swaps_their_reactions() {
    let Some(f) = fixture().await else { return };
    let reactions_uri = format!("/v1/cloud/documents/{}/reactions", f.attachment_id);
    for block in ["b1", "b2"] {
        let (status, _) = send(
            &f.app,
            "POST",
            &reactions_uri,
            Some(&f.member_token),
            Some(json!({"blockId": block, "reaction": "\u{1f44d}"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let swapped = "# Field notes\n\nSecond paragraph.\n\nFirst paragraph.\n";
    let (status, saved) = send(
        &f.app,
        "PUT",
        &content_uri(&f),
        Some(&f.owner_token),
        Some(json!({"baseRevision": 1, "source": swapped})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["reactions"].as_array().unwrap().len(), 2);
    let (live,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_document_reactions WHERE attachment_id = $1 AND deleted_at IS NULL")
        .bind(&f.attachment_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(live, 2);
}
