//! Database tests for forwarded copies and live annotation events.

use axum::http::StatusCode;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::*;

/// Inserts a finalized attachment owned by `owner`.
async fn attachment(pool: &PgPool, owner: &str, content_type: &str) -> String {
    let id = format!("att_copy_{}", Uuid::new_v4().simple());
    query("INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, content_type, size_bytes, created_at, finalized_at) VALUES ($1, $2, $3, $4, 10, $5, $5)")
        .bind(&id)
        .bind(owner)
        .bind(format!("attachments/{owner}/{id}"))
        .bind(content_type)
        .bind(Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .unwrap();
    id
}

/// Sends `attachment_id` from `sender` in a new direct conversation with
/// `recipient`.
async fn send_in_new_conversation(
    pool: &PgPool,
    sender: &str,
    recipient: &str,
    attachment_id: &str,
) {
    let conversation = Uuid::new_v4();
    query("INSERT INTO cloud_chat_conversations (conversation_id, kind, shared_title, created_by_account_id, client_operation_id, creation_fingerprint, legacy_session_id, next_message_sequence, latest_message_sequence) VALUES ($1, 'group', 'Forwarded', $2, $3, 'fixture', $4, 2, 1)")
        .bind(conversation)
        .bind(sender)
        .bind(Uuid::new_v4())
        .bind(format!("group-forward-{}", Uuid::new_v4().simple()))
        .execute(pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_chat_conversation_members (conversation_id, account_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')")
        .bind(conversation)
        .bind(sender)
        .bind(recipient)
        .execute(pool)
        .await
        .unwrap();
    let message = Uuid::new_v4();
    query("INSERT INTO cloud_chat_messages (message_id, conversation_id, conversation_sequence, sender_account_id, client_message_id, request_fingerprint, content) VALUES ($1, $2, 1, $3, $4, 'fixture', $5)")
        .bind(message)
        .bind(conversation)
        .bind(sender)
        .bind(Uuid::new_v4())
        .bind(json!({"schema": 1, "blocks": [{"type": "text", "text": "Forwarded"}]}))
        .execute(pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_chat_message_attachments (message_id, attachment_id, position) VALUES ($1, $2, 0)")
        .bind(message)
        .bind(attachment_id)
        .execute(pool)
        .await
        .unwrap();
}

struct Forward {
    copy: String,
    friend: String,
    friend_token: String,
}

/// The member forwards the fixture document to a friend who is in no
/// conversation with the owner, and links the copy to its source.
async fn forwarded(f: &Fixture) -> Forward {
    let (friend, friend_token) = signed_in_account(&f.pool, "friend").await;
    let copy = attachment(&f.pool, &f.member, "text/markdown").await;
    let (status, linked) = send(
        &f.app,
        "POST",
        &format!("/v1/cloud/documents/{copy}/source"),
        Some(&f.member_token),
        Some(json!({"sourceAttachmentId": f.attachment_id})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{linked}");
    assert_eq!(linked["attachmentId"], f.attachment_id.as_str());
    assert_eq!(linked["requestedAttachmentId"], copy.as_str());
    send_in_new_conversation(&f.pool, &f.member, &friend, &copy).await;
    Forward {
        copy,
        friend,
        friend_token,
    }
}

async fn events(pool: &PgPool, account: &str) -> Vec<Value> {
    query_as::<_, (Value,)>("SELECT payload FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = 'document.updated' ORDER BY stream_seq")
        .bind(account)
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|(payload,)| payload)
        .collect()
}

fn source_uri(id: &str) -> String {
    format!("/v1/cloud/documents/{id}/source")
}

#[tokio::test]
async fn the_source_route_checks_ownership_access_format_and_state() {
    let Some(f) = fixture().await else { return };
    let link = |source: &str| Some(json!({"sourceAttachmentId": source}));
    let copy = attachment(&f.pool, &f.member, "text/markdown").await;
    let (status, _) = send(
        &f.app,
        "POST",
        &source_uri("att_missing"),
        Some(&f.member_token),
        link(&f.attachment_id),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &f.app,
        "POST",
        &source_uri(&copy),
        Some(&f.member_token),
        link("att_missing"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = send(
        &f.app,
        "POST",
        &source_uri(&copy),
        Some(&f.owner_token),
        link(&f.attachment_id),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["errorCode"], "document_source_forbidden");
    let outsider_copy = attachment(&f.pool, &f.outsider, "text/markdown").await;
    let (status, body) = send(
        &f.app,
        "POST",
        &source_uri(&outsider_copy),
        Some(&f.outsider_token),
        link(&f.attachment_id),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "the outsider cannot read the source: {body}"
    );
    let html_copy = attachment(&f.pool, &f.member, "text/html").await;
    let (status, body) = send(
        &f.app,
        "POST",
        &source_uri(&html_copy),
        Some(&f.member_token),
        link(&f.attachment_id),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["errorCode"], "document_source_mismatch");
    let used = attachment(&f.pool, &f.member, "text/markdown").await;
    query("INSERT INTO cloud_document_contents (attachment_id, source, updated_at) VALUES ($1, 'mine', $2)")
        .bind(&used)
        .bind(Utc::now().to_rfc3339())
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, body) = send(
        &f.app,
        "POST",
        &source_uri(&used),
        Some(&f.member_token),
        link(&f.attachment_id),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["errorCode"], "document_source_conflict");

    let (status, first) = send(
        &f.app,
        "POST",
        &source_uri(&copy),
        Some(&f.member_token),
        link(&f.attachment_id),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["attachmentId"], f.attachment_id.as_str());
    assert_eq!(first["requestedAttachmentId"], copy.as_str());
    let (status, _) = send(
        &f.app,
        "POST",
        &source_uri(&copy),
        Some(&f.member_token),
        link(&f.attachment_id),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "linking again is a no-op");
    let (status, own) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/documents/{}", f.attachment_id),
        Some(&f.owner_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        own.get("requestedAttachmentId").is_none(),
        "omitted when equal"
    );

    // A copy of the copy points at the root.
    send_in_new_conversation(&f.pool, &f.member, &f.outsider, &copy).await;
    let second = attachment(&f.pool, &f.outsider, "text/markdown").await;
    let (status, body) = send(
        &f.app,
        "POST",
        &source_uri(&second),
        Some(&f.outsider_token),
        link(&copy),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (stored,): (Option<String>,) = query_as(
        "SELECT document_source_attachment_id FROM cloud_attachments WHERE attachment_id = $1",
    )
    .bind(&second)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(stored.as_deref(), Some(f.attachment_id.as_str()));
}

#[tokio::test]
async fn annotations_through_a_copy_land_on_the_canonical_document() {
    let Some(f) = fixture().await else { return };
    let forward = forwarded(&f).await;
    let (status, reacted) = send(
        &f.app,
        "POST",
        &format!("/v1/cloud/documents/{}/reactions", forward.copy),
        Some(&forward.friend_token),
        Some(json!({"blockId": "b1", "reaction": "\u{1f44d}"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reacted}");
    let (_, canonical) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/documents/{}", f.attachment_id),
        Some(&f.owner_token),
        None,
    )
    .await;
    let reactions = canonical["reactions"].as_array().unwrap();
    assert_eq!(reactions.len(), 1);
    assert_eq!(reactions[0]["actor"]["accountId"], forward.friend.as_str());
    let (_, via_copy) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/documents/{}", forward.copy),
        Some(&forward.friend_token),
        None,
    )
    .await;
    assert_eq!(via_copy["attachmentId"], f.attachment_id.as_str());
    assert_eq!(
        via_copy["sessionTitle"], "Forwarded",
        "the friend's own session"
    );
    assert_eq!(
        via_copy["viewerCan"]["edit"], true,
        "active members of a copy's conversation edit"
    );
    let token = token_of(&create_share(&f).await);
    let (_, public) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/public/documents/{token}"),
        None,
        None,
    )
    .await;
    assert_eq!(public["reactions"].as_array().unwrap().len(), 1);
    assert!(public["reactions"][0]["actor"]["accountId"].is_null());
}

#[tokio::test]
async fn only_the_canonical_owner_shares_through_a_copy() {
    let Some(f) = fixture().await else { return };
    let forward = forwarded(&f).await;
    let uri = format!("/v1/cloud/documents/{}/shares", forward.copy);
    let (status, body) = send(&f.app, "POST", &uri, Some(&f.member_token), Some(json!({}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["errorCode"], "document_share_forbidden");
    let (status, _) = send(&f.app, "GET", &uri, Some(&f.member_token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, member_view) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/documents/{}", forward.copy),
        Some(&f.member_token),
        None,
    )
    .await;
    assert_eq!(
        member_view["viewer"], "member",
        "a copy's owner is a member"
    );
    assert_eq!(member_view["viewerCan"]["share"], false);

    // The owner forwards their own document and shares through that copy.
    let own_copy = attachment(&f.pool, &f.owner, "text/markdown").await;
    let (status, linked) = send(
        &f.app,
        "POST",
        &source_uri(&own_copy),
        Some(&f.owner_token),
        Some(json!({"sourceAttachmentId": f.attachment_id})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{linked}");
    let own_uri = format!("/v1/cloud/documents/{own_copy}/shares");
    let (status, share) = send(
        &f.app,
        "POST",
        &own_uri,
        Some(&f.owner_token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{share}");
    assert_eq!(share["attachmentId"], f.attachment_id.as_str());
    let (_, listed) = send(&f.app, "GET", &own_uri, Some(&f.owner_token), None).await;
    assert_eq!(listed["shares"][0]["shareId"], share["shareId"]);
    let (_, canonical) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/documents/{}/shares", f.attachment_id),
        Some(&f.owner_token),
        None,
    )
    .await;
    assert_eq!(
        canonical["shares"][0]["shareId"], share["shareId"],
        "one share, whichever id"
    );
    let (status, public) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/public/documents/{}", token_of(&share)),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{public}");
    assert_eq!(public["title"], "Field notes");
}

#[tokio::test]
async fn saves_and_annotations_reach_the_copy_audience() {
    let Some(f) = fixture().await else { return };
    let forward = forwarded(&f).await;
    let (status, _) = send(
        &f.app,
        "PUT",
        &format!("/v1/cloud/documents/{}/content", f.attachment_id),
        Some(&f.owner_token),
        Some(json!({"baseRevision": 1, "source": "# Field notes\n\nRevised.\n"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let friend_events = events(&f.pool, &forward.friend).await;
    assert_eq!(
        friend_events.len(),
        1,
        "the copy's conversation hears about saves"
    );
    assert_eq!(friend_events[0]["change"], "content");
    assert_eq!(friend_events[0]["revision"], 2);
    assert_eq!(friend_events[0]["attachmentId"], f.attachment_id.as_str());

    let (status, comment) = send(
        &f.app,
        "POST",
        &format!("/v1/cloud/documents/{}/comments", forward.copy),
        Some(&forward.friend_token),
        Some(json!({"blockId": "b1", "body": "Nice"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{comment}");
    let owner_events = events(&f.pool, &f.owner).await;
    let last = owner_events.last().unwrap();
    assert_eq!(last["change"], "annotations");
    assert_eq!(last["revision"], 2);
    assert_eq!(last["updatedByAccountId"], forward.friend.as_str());
    assert_eq!(last["attachmentId"], f.attachment_id.as_str());

    // The friend edits their comment through the canonical comment route.
    let comment_uri = format!(
        "/v1/cloud/documents/comments/{}",
        comment["commentId"].as_str().unwrap()
    );
    let (status, _) = send(
        &f.app,
        "PATCH",
        &comment_uri,
        Some(&forward.friend_token),
        Some(json!({"body": "Nice work"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let token = token_of(&create_share(&f).await);
    let reader = json!({"blockId": "b1", "reaction": "\u{1f525}", "readerKey": READER_KEY, "readerName": "Priya"});
    let (status, _) = send(
        &f.app,
        "POST",
        &format!("/v1/cloud/public/documents/{token}/reactions"),
        None,
        Some(reader),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let friend_events = events(&f.pool, &forward.friend).await;
    let last = friend_events.last().unwrap();
    assert_eq!(friend_events.len(), 4);
    assert_eq!(last["change"], "annotations");
    assert!(
        last["updatedByAccountId"].is_null(),
        "public readers have no account"
    );
}
