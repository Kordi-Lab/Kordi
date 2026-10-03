//! Deleted, hidden, and edited content leaves no earlier copy in replay.

use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use kordi_cloud_server::chat_sync::models::MessageSnapshot;
use serde_json::Value;

pub(super) struct Chat {
    pub(super) owner: String,
    pub(super) peer: String,
    pub(super) conversation_id: Uuid,
    pub(super) session_id: String,
}

pub(super) async fn direct_chat(pool: &PgPool, label: &str) -> Chat {
    let owner = account(pool, &format!("{label}-owner")).await;
    let peer = account(pool, &format!("{label}-peer")).await;
    connect_accounts(pool, &owner, &peer).await;
    let session_id = direct_person_session_id(&owner, &peer);
    let conversation = store::create_conversation(
        pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: session_id.clone(),
            member_account_ids: vec![peer.clone()],
        },
    )
    .await
    .expect("create direct chat");
    Chat {
        owner,
        peer,
        conversation_id: conversation.value.id,
        session_id,
    }
}

pub(super) async fn group_chat(pool: &PgPool, label: &str, extra: &[String]) -> Chat {
    let owner = account(pool, &format!("{label}-owner")).await;
    let peer = account(pool, &format!("{label}-peer")).await;
    let mut members = vec![peer.clone()];
    for member in extra {
        connect_accounts(pool, &owner, member).await;
        members.push(member.clone());
    }
    connect_accounts(pool, &owner, &peer).await;
    let session_id = format!("session:group:{}", Uuid::now_v7());
    let conversation = store::create_conversation(
        pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Content removal".to_string()),
            client_session_id: session_id.clone(),
            member_account_ids: members,
        },
    )
    .await
    .expect("create group chat");
    Chat {
        owner,
        peer,
        conversation_id: conversation.value.id,
        session_id: conversation.value.legacy_session_id.unwrap_or(session_id),
    }
}

/// A group envelope whose logical id is `logical_id`.
pub(super) fn group_text(chat: &Chat, logical_id: &str, text: &str) -> String {
    let body = json!({
        "kind": "group-message",
        "groupId": chat.session_id,
        "groupTitle": null,
        "createdByAccountId": chat.owner,
        "actor": { "accountId": chat.owner, "displayName": "Owner" },
        "participants": [
            { "accountId": chat.owner, "displayName": "Owner" },
            { "accountId": chat.peer, "displayName": "Peer" }
        ],
        "message": { "id": logical_id, "senderAccountId": chat.owner, "text": text, "createdAtMs": 1 }
    });
    format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(body.to_string())
    )
}

pub(super) async fn photo(pool: &PgPool, owner: &str, mime: &str) -> String {
    let id = format!("att-{}", Uuid::new_v4());
    query("INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,created_at,finalized_at,content_type,detected_content_type,size_bytes) VALUES($1,$2,$1,$3,$3,$4,$4,100)")
        .bind(&id).bind(owner).bind(chrono::Utc::now().to_rfc3339()).bind(mime)
        .execute(pool).await.expect("create attachment");
    id
}

/// A direct message with two photos and a caption.
pub(super) async fn photo_message(
    pool: &PgPool,
    chat: &Chat,
    caption: &str,
) -> (MessageSnapshot, Vec<String>) {
    let ids = vec![
        photo(pool, &chat.owner, "image/png").await,
        photo(pool, &chat.owner, "image/png").await,
    ];
    let attachments: Vec<_> = ids
        .iter()
        .map(|id| json!({"attachmentId": id, "name": "Photo.png", "kind": "image", "mimeType": "image/png", "sizeBytes": 100}))
        .collect();
    let envelope =
        json!({"schemaVersion": 1, "kind": "message", "text": caption, "attachments": attachments});
    let text = format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    );
    let sent = store::send_message(
        pool,
        &chat.owner,
        chat.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": attachments}),
            reply_to_message_id: None,
            attachment_ids: ids.clone(),
        },
    )
    .await
    .expect("send photo message");
    (sent.value, ids)
}

pub(super) async fn send_text(pool: &PgPool, chat: &Chat, text: &str) -> MessageSnapshot {
    store::send_message(
        pool,
        &chat.owner,
        chat.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content: content(text),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send text")
    .value
}

/// Stored replay rows of one entity: (account, type, critical, payload).
pub(super) async fn stored_rows(
    pool: &PgPool,
    entity_id: Uuid,
) -> Vec<(String, String, bool, Value)> {
    query_as(
        "SELECT account_id, event_type, critical, payload FROM cloud_chat_user_sync_events \
         WHERE entity_id = $1 ORDER BY account_id, stream_seq",
    )
    .bind(entity_id)
    .fetch_all(pool)
    .await
    .expect("load stored rows")
}

pub(super) fn mentions(rows: &[(String, String, bool, Value)], needle: &str) -> bool {
    rows.iter().any(|row| row.3.to_string().contains(needle))
}

pub(super) async fn jobs(
    pool: &PgPool,
    message_id: Uuid,
) -> Vec<(String, Vec<String>, Vec<String>)> {
    query_as(
        "SELECT reason, source_identifiers, attachment_ids FROM cloud_content_removal_jobs \
         WHERE message_id = $1 ORDER BY created_at",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .expect("load removal jobs")
}

#[tokio::test]
async fn edits_leave_only_the_current_version_in_every_stream() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "removal-edit").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let edited = format!("edited-{}", Uuid::new_v4());
    let message = send_text(&pool, &chat, &canary).await;
    let updated = store::edit_message(
        &pool,
        &chat.owner,
        chat.conversation_id,
        message.id,
        UpdateMessageRequest {
            expected_version: message.version,
            text: edited.clone(),
        },
    )
    .await
    .expect("edit message");
    let rows = stored_rows(&pool, message.id).await;
    assert!(!mentions(&rows, &canary), "{rows:?}");
    for account_id in [&chat.owner, &chat.peer] {
        let own = rows
            .iter()
            .filter(|row| &row.0 == account_id)
            .collect::<Vec<_>>();
        let (newest, earlier) = own.split_last().expect("rows for each member");
        assert_eq!(newest.1, "message.updated");
        assert!(newest.3.to_string().contains(&edited));
        assert!(!earlier.is_empty());
        for row in earlier {
            assert_eq!((row.1.as_str(), row.2), ("message.superseded", false));
            assert_eq!(row.3["message_id"], message.id.to_string());
            assert!(row.3.get("message").is_none());
        }
        let replay = store::sync_batch(&pool, account_id, 0, Some(500))
            .await
            .unwrap();
        let body = serde_json::to_string(&replay.events).unwrap();
        assert!(!body.contains(&canary) && body.contains(&edited));
    }
    let jobs = jobs(&pool, message.id).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].0, "message_edited");
    assert_eq!(jobs[0].1, vec![message.id.to_string()]);
    assert_eq!(updated.version, message.version + 1);
}

#[tokio::test]
async fn edits_after_a_member_left_supersede_the_former_members_rows() {
    let Some(pool) = try_pool().await else { return };
    let leaver = account(&pool, "removal-leaver").await;
    let chat = group_chat(&pool, "removal-left", std::slice::from_ref(&leaver)).await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let message = send_text(&pool, &chat, &canary).await;
    store::add_conversation_members(
        &pool,
        &chat.owner,
        chat.conversation_id,
        AddConversationMembersRequest {
            client_operation_id: Uuid::now_v7(),
            member_account_ids: vec![chat.peer.clone()],
            replace: true,
        },
    )
    .await
    .expect("remove a member");
    let edited = format!("edited-{}", Uuid::new_v4());
    store::edit_message(
        &pool,
        &chat.owner,
        chat.conversation_id,
        message.id,
        UpdateMessageRequest {
            expected_version: message.version,
            text: edited.clone(),
        },
    )
    .await
    .expect("edit message");
    let rows = stored_rows(&pool, message.id).await;
    let former = rows
        .iter()
        .filter(|row| row.0 == leaver)
        .collect::<Vec<_>>();
    assert!(!former.is_empty());
    for row in former {
        assert_eq!((row.1.as_str(), row.2), ("message.superseded", false));
        assert!(!row.3.to_string().contains(&canary) && !row.3.to_string().contains(&edited));
    }
    assert!(!mentions(&rows, &canary));
}

#[tokio::test]
async fn delete_for_everyone_leaves_no_content_reactions_or_file_ids() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "removal-delete").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let (message, ids) = photo_message(&pool, &chat, &canary).await;
    store::set_reaction(
        &pool,
        &chat.peer,
        chat.conversation_id,
        message.id,
        "👍",
        true,
    )
    .await
    .unwrap();
    store::set_attachment_reaction(
        &pool,
        &chat.peer,
        chat.conversation_id,
        message.id,
        &ids[0],
        "👍",
        true,
    )
    .await
    .unwrap();
    store::delete_message(&pool, &chat.owner, chat.conversation_id, message.id, true)
        .await
        .expect("delete for everyone");
    let rows = stored_rows(&pool, message.id).await;
    assert!(rows.len() >= 6, "{rows:?}");
    assert!(!mentions(&rows, &canary));
    for id in &ids {
        assert!(!mentions(&rows, id));
    }
    for row in &rows {
        assert_eq!(row.1, "message.deleted");
        assert!(row.3.get("message").is_none());
        assert_eq!(row.3["message_id"], message.id.to_string());
    }
    let (reactions,): (i64,) =
        query_as("SELECT count(*) FROM cloud_chat_attachment_reactions WHERE message_id = $1")
            .bind(message.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(reactions, 0);
    let jobs = jobs(&pool, message.id).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].0, "message_deleted");
    assert_eq!(jobs[0].2, ids);
    for account_id in [&chat.owner, &chat.peer] {
        let replay = store::sync_batch(&pool, account_id, 0, Some(500))
            .await
            .unwrap();
        let body = serde_json::to_string(&replay.events).unwrap();
        assert!(!body.contains(&canary) && !body.contains(&ids[0]));
    }
}

#[tokio::test]
async fn hiding_redacts_only_the_hiders_stream_and_later_changes() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "removal-hide").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let message = send_text(&pool, &chat, &canary).await;
    store::delete_message(&pool, &chat.peer, chat.conversation_id, message.id, false)
        .await
        .expect("remove from view");
    let rows = stored_rows(&pool, message.id).await;
    let (peer_rows, owner_rows): (Vec<_>, Vec<_>) = rows.iter().partition(|row| row.0 == chat.peer);
    assert!(peer_rows.iter().all(|row| row.1 == "message.hidden"));
    assert!(!peer_rows
        .iter()
        .any(|row| row.3.to_string().contains(&canary)));
    assert!(owner_rows
        .iter()
        .any(|row| row.1 == "message.created" && row.3.to_string().contains(&canary)));
    let jobs = jobs(&pool, message.id).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].0, "message_hidden");

    let edited = format!("edited-{}", Uuid::new_v4());
    let head = sync_head(&pool, &chat.peer).await.0;
    store::edit_message(
        &pool,
        &chat.owner,
        chat.conversation_id,
        message.id,
        UpdateMessageRequest {
            expected_version: message.version,
            text: edited.clone(),
        },
    )
    .await
    .unwrap();
    let after_edit = store::sync_batch(&pool, &chat.peer, head, Some(100))
        .await
        .unwrap();
    assert_eq!(after_edit.events.len(), 1);
    assert_eq!(after_edit.events[0].event_type, "message.hidden");
    assert!(after_edit.events[0].critical);
    assert!(!serde_json::to_string(&after_edit.events)
        .unwrap()
        .contains(&edited));
    let head = sync_head(&pool, &chat.peer).await.0;
    store::set_reaction(
        &pool,
        &chat.owner,
        chat.conversation_id,
        message.id,
        "👍",
        true,
    )
    .await
    .unwrap();
    assert_eq!(
        sync_head(&pool, &chat.peer).await.0,
        head,
        "hiders get no reactions"
    );
    let owner_replay = store::sync_batch(&pool, &chat.owner, 0, Some(500))
        .await
        .unwrap();
    assert!(serde_json::to_string(&owner_replay.events)
        .unwrap()
        .contains(&edited));
}
