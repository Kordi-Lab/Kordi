use super::*;

#[path = "../../../../../shared/test-fixtures/chat_media.rs"]
mod fixtures;
use fixtures::IMAGES;

async fn cursor(f: &Fixture) -> i64 {
    sqlx_core::query_as::query_as::<_, (i64,)>(
        "SELECT last_read_sequence FROM cloud_chat_conversation_members WHERE conversation_id=$1 AND account_id=$2",
    ).bind(f.conversation).bind(&f.owner.account_id).fetch_one(&f.pool).await.unwrap().0
}

async fn index(f: &Fixture, member: bool, limit: usize) -> Value {
    let args = json!({"sessionId":f.session,"mode":"index","limit":limit});
    let request = if member {
        member_tests::member_request(f, None, args)
    } else {
        f.request("read_session", args)
    };
    let response = f.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    read_json(response).await
}

// Attachment content is checked independently of filenames, captions and receipts.
// This exercises authorized retrieval, not live model image comprehension.
#[tokio::test]
async fn latest_unread_mixed_images_refresh_without_advancing_the_human_read_cursor() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let start_cursor = cursor(&f).await;
    let mixed = insert_test_message(
        &f.pool,
        &f.peer.account_id,
        f.conversation,
        "Synthetic mixed send.",
    )
    .await;
    let first = Fixture::attach(&f.pool, &f.peer, &mixed, IMAGES[0], &f.objects).await;
    let second = Fixture::attach(&f.pool, &f.peer, &mixed, IMAGES[1], &f.objects).await;
    query("UPDATE cloud_chat_message_attachments SET position=2 WHERE message_id::text=$1 AND attachment_id=$2")
        .bind(&mixed).bind(&second).execute(&f.pool).await.unwrap();
    let file = Fixture::attach(
        &f.pool,
        &f.peer,
        &mixed,
        b"Synthetic file; no image description.",
        &f.objects,
    )
    .await;
    query("UPDATE cloud_attachments SET content_type='text/plain' WHERE attachment_id=$1")
        .bind(&file)
        .execute(&f.pool)
        .await
        .unwrap();
    query("UPDATE cloud_chat_message_attachments SET position=1 WHERE message_id::text=$1 AND attachment_id=$2")
        .bind(&mixed).bind(&file).execute(&f.pool).await.unwrap();

    // Both the owner Ask Agent route and leased run route must read current server state.
    for member in [true, false] {
        let response = index(&f, member, 1).await;
        assert_eq!(response["messages"][0]["messageId"], mixed);
        assert_eq!(
            response["messages"][0]["attachments"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["attachmentId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [&first, &file, &second]
        );
        assert!(response["messages"][0]["sequenceNum"].as_i64().unwrap() > start_cursor);
        assert!(response.get("media").is_none());
    }

    // Arrive after the first read, so a reused index/prompt cannot satisfy this assertion.
    let latest = insert_test_message(&f.pool, &f.peer.account_id, f.conversation, "").await;
    let latest_attachment = Fixture::attach(&f.pool, &f.peer, &latest, IMAGES[2], &f.objects).await;
    for member in [true, false] {
        let response = index(&f, member, 2).await;
        let messages = response["messages"].as_array().unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|m| m["messageId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [&mixed, &latest]
        );
        let latest_only = index(&f, member, 1).await;
        assert_eq!(latest_only["messages"][0]["messageId"], latest);
        assert_eq!(
            latest_only["messages"][0]["attachments"][0]["attachmentId"],
            latest_attachment
        );
        for (message, attachment, bytes) in [
            (&mixed, &first, IMAGES[0]),
            (&mixed, &second, IMAGES[1]),
            (&latest, &latest_attachment, IMAGES[2]),
        ] {
            let args = f.args(message, attachment);
            let request = if member {
                member_tests::member_request(&f, None, args)
            } else {
                f.request("read_session", args)
            };
            let response = f.router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let response = read_json(response).await;
            assert_eq!(response["messages"][0]["messageId"], *message);
            assert_eq!(
                response["media"][0]["data"],
                base64::engine::general_purpose::STANDARD.encode(bytes)
            );
            assert_eq!(response["media"][0]["mime_type"], "image/png");
        }
    }
    assert_eq!(
        cursor(&f).await,
        start_cursor,
        "agent inspection must not mark a human chat read"
    );
}
