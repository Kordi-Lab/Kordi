//! Quote and thread previews after the quoted message is deleted.

use super::content_removal::{direct_chat, group_chat, group_text, send_text, stored_rows, Chat};
use super::content_removal_worker::{job_ids, settle, FakeObjects};
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use kordi_cloud_server::chat_sync::models::MessageSnapshot;
use serde_json::Value;

fn action(kind: &str, session_id: &str, source_id: &str, preview: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "kind": kind,
        "source": {
            "sourceSessionId": session_id,
            "sourceMessageId": source_id,
            "senderLabel": "Owner",
            "textPreview": preview,
            "attachmentCount": 1,
            "createdAtMs": 1,
            "mentions": [{"accountId": "someone", "label": "@Sam"}]
        }
    })
}

fn encoded(prefix: &str, envelope: &Value) -> Value {
    content(&format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    ))
}

fn decoded(message: &MessageSnapshot) -> Value {
    let text = message.content["blocks"][0]["text"].as_str().unwrap();
    let (_, encoded) = text.split_once(':').unwrap();
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
}

/// The peer replies with `content`.
async fn reply(pool: &PgPool, chat: &Chat, content: Value) -> MessageSnapshot {
    store::send_message(
        pool,
        &chat.peer,
        chat.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content,
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send reply")
    .value
}

fn assert_scrubbed(source: &Value) {
    assert_eq!(source["textPreview"], "");
    assert_eq!(source["attachmentCount"], 0);
    assert_eq!(source["sourceDeleted"], true);
    assert!(source.get("mentions").is_none());
    assert_eq!(source["senderLabel"], "Owner");
}

async fn reload(pool: &PgPool, message: &MessageSnapshot) -> MessageSnapshot {
    store::load_message_snapshot(pool, message.id)
        .await
        .unwrap()
}

#[tokio::test]
async fn deleting_a_message_replaces_its_quotes_and_thread_previews() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "quotes-direct").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let source = send_text(&pool, &chat, &canary).await;
    let source_id = source.id.to_string();
    let message = |kind: &str| {
        json!({"schemaVersion": 1, "kind": "message", "text": "my reply",
               "messageAction": action(kind, &chat.session_id, &source_id, &canary)})
    };
    let quote = reply(
        &pool,
        &chat,
        encoded("kordi-cloud-message:", &message("quote")),
    )
    .await;
    let forward = reply(
        &pool,
        &chat,
        encoded("kordi-cloud-message:", &message("forward")),
    )
    .await;
    let agent_response = json!({"kind": "agent-response", "text": "agent reply",
        "messageAction": action("thread", &chat.session_id, &format!("collaboration-message:{source_id}"), &canary)});
    let response = reply(
        &pool,
        &chat,
        encoded("kordi-cloud-agent-response:", &agent_response),
    )
    .await;

    // An edit never changes quotes.
    store::edit_message(
        &pool,
        &chat.owner,
        chat.conversation_id,
        source.id,
        UpdateMessageRequest {
            expected_version: source.version,
            text: "edited wording".into(),
        },
    )
    .await
    .unwrap();
    settle(
        &pool,
        &FakeObjects::default(),
        &job_ids(&pool, source.id).await,
    )
    .await;
    assert_eq!(reload(&pool, &quote).await.version, quote.version);

    store::delete_message(&pool, &chat.owner, chat.conversation_id, source.id, true)
        .await
        .unwrap();
    settle(
        &pool,
        &FakeObjects::default(),
        &job_ids(&pool, source.id).await,
    )
    .await;
    for (before, path) in [(&quote, "messageAction"), (&response, "messageAction")] {
        let after = reload(&pool, before).await;
        assert_eq!(after.version, before.version + 1);
        assert!(after.edited_at.is_none());
        let envelope = decoded(&after);
        assert_scrubbed(&envelope[path]["source"]);
        assert!(!after.content.to_string().contains(&canary));
        // Earlier rows of the reply no longer carry the preview.
        let rows = stored_rows(&pool, before.id).await;
        assert!(!rows.iter().any(|row| row.3.to_string().contains(&canary)));
        for account in [&chat.owner, &chat.peer] {
            let own = rows
                .iter()
                .filter(|row| &row.0 == account)
                .collect::<Vec<_>>();
            let (newest, earlier) = own.split_last().unwrap();
            assert_eq!(newest.1, "message.updated");
            assert!(earlier
                .iter()
                .all(|row| row.1 == "message.superseded" && !row.2));
        }
    }
    let forward_after = reload(&pool, &forward).await;
    assert_eq!(forward_after.version, forward.version);
    assert_eq!(forward_after.content, forward.content);
}

#[tokio::test]
async fn group_threads_on_a_deleted_message_are_replaced() {
    let Some(pool) = try_pool().await else { return };
    let chat = group_chat(&pool, "quotes-group", &[]).await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let logical_id = format!("logical-{}", Uuid::new_v4());
    let source = store::send_message(
        &pool,
        &chat.owner,
        chat.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content: content(&group_text(&chat, &logical_id, &canary)),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap()
    .value;
    let envelope = json!({
        "kind": "group-message",
        "groupId": chat.session_id,
        "groupTitle": null,
        "createdByAccountId": chat.owner,
        "actor": { "accountId": chat.peer, "displayName": "Peer" },
        "participants": [
            { "accountId": chat.owner, "displayName": "Owner" },
            { "accountId": chat.peer, "displayName": "Peer" }
        ],
        "message": {
            "id": format!("logical-{}", Uuid::new_v4()),
            "senderAccountId": chat.peer,
            "text": "my reply",
            "createdAtMs": 2,
            "messageAction": action("thread", &chat.session_id, &logical_id, &canary)
        }
    });
    let thread = reply(&pool, &chat, encoded("kordi-cloud-group:", &envelope)).await;
    assert!(decoded(&thread)["message"]["messageAction"].is_object());

    store::delete_message(&pool, &chat.owner, chat.conversation_id, source.id, true)
        .await
        .unwrap();
    settle(
        &pool,
        &FakeObjects::default(),
        &job_ids(&pool, source.id).await,
    )
    .await;
    let after = reload(&pool, &thread).await;
    assert_eq!(after.version, thread.version + 1);
    assert!(after.edited_at.is_none());
    let envelope = decoded(&after);
    assert_scrubbed(&envelope["message"]["messageAction"]["source"]);
    assert_eq!(envelope["message"]["text"], "my reply");
    assert_eq!(envelope["actor"]["accountId"], chat.peer.as_str());
}
