//! Removal jobs, retried sends, purged files, and tombstone rewrites.

use super::content_removal::{
    direct_chat, group_chat, group_text, jobs, mentions, photo, photo_message, send_text,
    stored_rows,
};
use super::*;

#[tokio::test]
async fn deleting_a_group_live_photo_queues_one_job_with_every_id() {
    let Some(pool) = try_pool().await else { return };
    let chat = group_chat(&pool, "removal-job-group", &[]).await;
    let ids = vec![
        photo(&pool, &chat.owner, "image/heic").await,
        photo(&pool, &chat.owner, "video/quicktime").await,
        photo(&pool, &chat.owner, "video/mp4").await,
    ];
    let logical_id = format!("group-logical-{}", Uuid::new_v4());
    let content = json!({ "legacy_attachments": [{
        "attachmentId": ids[0], "name": "Photo.heic", "kind": "image", "mimeType": "image/heic", "sizeBytes": 100,
        "livePhoto": {
            "video": { "attachmentId": ids[1], "name": "Live.mov", "mimeType": "video/quicktime", "sizeBytes": 100 },
            "playback": { "attachmentId": ids[2], "name": "Live.mp4", "mimeType": "video/mp4", "sizeBytes": 100 }
        }
    }], "schema": 1, "blocks": [{ "type": "text", "text": group_text(&chat, &logical_id, "photo") }] });
    let sent = store::send_message(
        &pool,
        &chat.owner,
        chat.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content,
            reply_to_message_id: None,
            attachment_ids: ids.clone(),
        },
    )
    .await
    .expect("send group live photo")
    .value;
    store::delete_message(&pool, &chat.owner, chat.conversation_id, sent.id, true)
        .await
        .unwrap();
    store::delete_message(&pool, &chat.owner, chat.conversation_id, sent.id, true)
        .await
        .unwrap();
    let jobs = jobs(&pool, sent.id).await;
    assert_eq!(jobs.len(), 1, "a repeated delete queues nothing more");
    let (reason, identifiers, attachments) = &jobs[0];
    assert_eq!(reason, "message_deleted");
    for expected in [
        sent.id.to_string(),
        sent.client_message_id.to_string(),
        format!("ios_{}", sent.client_message_id),
        logical_id,
    ] {
        assert!(
            identifiers.contains(&expected),
            "{expected} in {identifiers:?}"
        );
    }
    assert_eq!(attachments, &ids);
}

#[tokio::test]
async fn removing_one_photo_for_everyone_queues_only_that_file() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "removal-job-photo").await;
    let (message, ids) = photo_message(&pool, &chat, "Caption stays").await;
    let kept = store::delete_attachment(
        &pool,
        &chat.owner,
        chat.conversation_id,
        message.id,
        &ids[0],
        true,
    )
    .await
    .unwrap()
    .expect("caption keeps the message");
    assert_eq!(kept.attachment_ids, vec![ids[1].clone()]);
    let jobs = jobs(&pool, message.id).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].0, "attachment_removed");
    assert_eq!(jobs[0].2, vec![ids[0].clone()]);
    let rows = stored_rows(&pool, message.id).await;
    assert!(!mentions(&rows, &ids[0]), "{rows:?}");
    for account_id in [&chat.owner, &chat.peer] {
        let own = rows
            .iter()
            .filter(|row| &row.0 == account_id)
            .collect::<Vec<_>>();
        let (newest, earlier) = own.split_last().unwrap();
        assert_eq!(newest.1, "message.updated");
        assert!(earlier
            .iter()
            .all(|row| row.1 == "message.superseded" && !row.2));
    }
}

#[tokio::test]
async fn retried_sends_of_a_deleted_message_return_the_tombstone() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "removal-retry").await;
    let request = SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".into(),
        content: content("retry me"),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    let sent = store::send_message(&pool, &chat.owner, chat.conversation_id, request.clone())
        .await
        .unwrap()
        .value;
    store::delete_message(&pool, &chat.owner, chat.conversation_id, sent.id, true)
        .await
        .unwrap();
    for content in [content("retry me"), content("different text")] {
        let retried = store::send_message(
            &pool,
            &chat.owner,
            chat.conversation_id,
            SendMessageRequest {
                content,
                ..request.clone()
            },
        )
        .await
        .expect("a retry returns the tombstone");
        assert!(!retried.inserted);
        assert_eq!(retried.value.id, sent.id);
        assert!(retried.value.deleted_at.is_some());
    }

    let group = group_chat(&pool, "removal-retry-group", &[]).await;
    let envelope = content(&group_text(&group, "logical-retry", "group retry"));
    let first = store::send_message(
        &pool,
        &group.owner,
        group.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            content: envelope.clone(),
            ..request.clone()
        },
    )
    .await
    .unwrap()
    .value;
    store::delete_message(&pool, &group.owner, group.conversation_id, first.id, true)
        .await
        .unwrap();
    let resent = store::send_message(
        &pool,
        &group.owner,
        group.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            content: envelope,
            ..request
        },
    )
    .await
    .unwrap();
    assert!(!resent.inserted);
    assert_eq!(resent.value.id, first.id);
    let (count,): (i64,) =
        query_as("SELECT count(*) FROM cloud_chat_messages WHERE conversation_id = $1")
            .bind(group.conversation_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn files_queued_for_deletion_cannot_be_linked_again() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "removal-purged").await;
    let live = photo(&pool, &chat.owner, "image/png").await;
    let purged = photo(&pool, &chat.owner, "image/png").await;
    let request = |ids: Vec<String>| SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".into(),
        content: content("photo"),
        reply_to_message_id: None,
        attachment_ids: ids,
    };
    // Positive control before the file is queued for deletion.
    let linked = store::send_message(
        &pool,
        &chat.owner,
        chat.conversation_id,
        request(vec![purged.clone()]),
    )
    .await
    .expect("an available file links");
    query("UPDATE cloud_attachments SET purge_requested_at = now() WHERE attachment_id = $1")
        .bind(&purged)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        store::send_message(
            &pool,
            &chat.owner,
            chat.conversation_id,
            request(vec![live.clone(), purged.clone()])
        )
        .await,
        Err(StoreError::InvalidInput(
            "one or more attachments are unavailable"
        ))
    ));
    let agent_message = send_text(&pool, &chat, "agent reply").await;
    assert!(matches!(
        store::replace_message_snapshot(
            &pool,
            &chat.owner,
            agent_message.id,
            content("with file"),
            vec![purged.clone()]
        )
        .await,
        Err(StoreError::InvalidInput(
            "one or more attachments are unavailable"
        ))
    ));
    let replaced = store::replace_message_snapshot(
        &pool,
        &chat.owner,
        agent_message.id,
        content("with file"),
        vec![live.clone()],
    )
    .await
    .expect("an available file still links");
    assert_eq!(replaced.attachment_ids, vec![live]);
    assert_eq!(linked.value.attachment_ids, vec![purged]);
}

#[tokio::test]
async fn late_snapshots_never_restore_a_deleted_message() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "removal-tombstone").await;
    let file = photo(&pool, &chat.owner, "image/png").await;
    let message = send_text(&pool, &chat, "generating").await;
    store::delete_message(&pool, &chat.owner, chat.conversation_id, message.id, true)
        .await
        .unwrap();
    let rows_before = stored_rows(&pool, message.id).await;
    let tombstone = store::replace_message_snapshot(
        &pool,
        &chat.owner,
        message.id,
        content("late generation snapshot"),
        vec![file],
    )
    .await
    .expect("a late snapshot returns the tombstone");
    assert!(tombstone.deleted_at.is_some());
    assert!(tombstone.attachment_ids.is_empty());
    assert_eq!(tombstone.content["blocks"], json!([]));
    let (links,): (i64,) =
        query_as("SELECT count(*) FROM cloud_chat_message_attachments WHERE message_id = $1")
            .bind(message.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(links, 0);
    assert_eq!(stored_rows(&pool, message.id).await, rows_before);
}
