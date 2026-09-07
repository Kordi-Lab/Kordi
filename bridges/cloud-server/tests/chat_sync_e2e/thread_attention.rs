use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use kordi_cloud_server::chat_sync::models::AdvanceThreadReadRequest;

#[tokio::test]
async fn unread_threads_are_discoverable_without_history_and_keep_independent_cursors() {
    let Ok(database_url) = std::env::var("DATABASE_URL") else {
        return;
    };
    let pool = init_pool(&database_url)
        .await
        .expect("configured thread attention database must be available");
    let owner = account(&pool, "thread-owner").await;
    let peer = account(&pool, "thread-peer").await;
    let outsider = account(&pool, "thread-outsider").await;
    connect_accounts(&pool, &owner, &peer).await;
    let conversation = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: direct_person_session_id(&owner, &peer),
            member_account_ids: vec![peer.clone()],
        },
    )
    .await
    .unwrap()
    .value
    .id;
    let send = |sender: String, text: String, root: Option<Uuid>, reply: Option<Uuid>| {
        let pool = pool.clone();
        async move {
            let body = if let Some(root) = root {
                format!("kordi-cloud-message:{}",URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"schemaVersion":1,"kind":"message","text":text,"messageAction":{"schemaVersion":1,"kind":"thread","source":{"sourceMessageId":root,"sourceSessionId":conversation}}})).unwrap()))
            } else {
                text
            };
            store::send_message(
                &pool,
                &sender,
                conversation,
                SendMessageRequest {
                    client_message_id: Uuid::now_v7(),
                    kind: "text".into(),
                    content: content(&body),
                    reply_to_message_id: reply,
                    attachment_ids: vec![],
                },
            )
            .await
            .unwrap()
            .value
        }
    };
    let first = send(owner.clone(), "Root one".into(), None, None).await;
    let second = send(owner.clone(), "Root two".into(), None, None).await;
    let reply = send(
        peer.clone(),
        "First unread reply".into(),
        Some(first.client_message_id),
        None,
    )
    .await;
    let last = send(
        peer.clone(),
        "Second thread reply".into(),
        Some(second.id),
        None,
    )
    .await;
    send(
        owner.clone(),
        "Own reply is not unread".into(),
        Some(first.id),
        None,
    )
    .await;
    let main = send(peer.clone(), "Main message".into(), None, None).await;
    // Legacy optional metadata must not make the whole account's unread query fail.
    query("UPDATE cloud_chat_messages SET content=jsonb_set(content,'{legacy_attachments}','null'::jsonb) WHERE message_id=$1")
        .bind(reply.id).execute(&pool).await.unwrap();
    let summary = store::thread_attention(&pool, &owner, None)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.conversation_id == conversation)
        .unwrap();
    assert_eq!(
        (
            summary.unread_count,
            summary.thread_count,
            summary.thread_unread_count
        ),
        (3, 2, 2)
    );
    assert_eq!(summary.next_root_id, Some(first.id));
    assert_eq!(summary.next_message_id, Some(reply.id));
    let page = store::thread_page(&pool, &owner, conversation, reply.id, None)
        .await
        .unwrap();
    assert!(page.is_thread);
    assert_eq!(page.root.id, first.id);
    assert_eq!(page.first_unread_message_id, Some(reply.id));
    assert!(matches!(
        store::thread_page(&pool, &outsider, conversation, reply.id, None).await,
        Err(StoreError::Forbidden)
    ));
    assert!(store::thread_attention(&pool, &outsider, None)
        .await
        .unwrap()
        .is_empty());
    store::advance_read_cursor(
        &pool,
        &owner,
        conversation,
        AdvanceConversationCursorRequest {
            client_operation_id: Uuid::now_v7(),
            sequence: main.conversation_sequence,
        },
    )
    .await
    .unwrap();
    let summary = store::thread_attention(&pool, &owner, None)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.conversation_id == conversation)
        .unwrap();
    assert_eq!((summary.unread_count, summary.thread_count), (2, 2));
    store::advance_thread_read(
        &pool,
        &owner,
        conversation,
        AdvanceThreadReadRequest {
            root_message_id: first.id,
            sequence: reply.conversation_sequence,
        },
    )
    .await
    .unwrap();
    let summary = store::thread_attention(&pool, &owner, None)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.conversation_id == conversation)
        .unwrap();
    assert_eq!((summary.unread_count, summary.thread_count), (1, 1));
    assert_eq!(summary.next_message_id, Some(last.id));
    let old = store::advance_thread_read(
        &pool,
        &owner,
        conversation,
        AdvanceThreadReadRequest {
            root_message_id: first.client_message_id,
            sequence: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(old.last_read_sequence, reply.conversation_sequence);
    let reopened = store::thread_page(&pool, &owner, conversation, reply.id, None)
        .await
        .unwrap();
    assert!(reopened
        .messages
        .iter()
        .any(|message| message.id == reply.id));
    let ordinary = store::thread_page(&pool, &owner, conversation, main.id, None)
        .await
        .unwrap();
    assert!(!ordinary.is_thread);
    for index in 0..105 {
        send(
            peer.clone(),
            format!("Reply {index}"),
            Some(second.id),
            None,
        )
        .await;
    }
    let page = store::thread_page(&pool, &owner, conversation, last.id, None)
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 100);
    let next = store::thread_page(
        &pool,
        &owner,
        conversation,
        second.id,
        page.next_after_sequence,
    )
    .await
    .unwrap();
    assert!(
        next.is_thread,
        "paging by the root must stay in the discussion"
    );
    assert_eq!(next.messages.len(), 6);
    assert!(next.next_after_sequence.is_none());
    query("INSERT INTO cloud_chat_message_visibility(account_id,message_id) VALUES($1,$2)")
        .bind(&owner)
        .bind(second.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        store::thread_page(&pool, &owner, conversation, last.id, None).await,
        Err(StoreError::NotFound)
    ));
    let summary = store::thread_attention(&pool, &owner, None)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.conversation_id == conversation)
        .unwrap();
    assert_eq!((summary.unread_count, summary.thread_count), (0, 0));
}
