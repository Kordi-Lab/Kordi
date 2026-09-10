use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::json;

use super::{apply_on_connection, load_all_conversation_heads, ChatSyncApplyRequest};

#[test]
fn own_agent_replies_count_until_read_but_own_human_messages_do_not() {
    let mut conn = super::test_support::test_connection();
    let complete = URL_SAFE_NO_PAD.encode(
        json!({"kind":"agent-response", "text":"Ready", "deliveryState":"complete"}).to_string(),
    );
    let processing = URL_SAFE_NO_PAD.encode(
        json!({"kind":"agent-response", "text":"Working", "deliveryState":"processing"})
            .to_string(),
    );
    let group = URL_SAFE_NO_PAD.encode(json!({"kind":"group-message", "message":{"id":"group-answer", "senderKind":"agent", "text":"Done", "deliveryState":"complete"}}).to_string());
    let bodies = [
        "Human send".to_string(),
        format!("kordi-cloud-agent-response:{complete}"),
        format!("kordi-cloud-agent-response:{processing}"),
        format!("kordi-cloud-group:{group}"),
    ];
    apply_on_connection(&mut conn, ChatSyncApplyRequest {
        account_id: "acct_test".into(), bootstrap: true, cursor: None, last_stream_seq: Some(4),
        conversations: vec![json!({"id":"conversation", "kind":"ai", "version":1,"latest_message_sequence":4,"members":[{"account_id":"acct_test","last_read_sequence":0}]})],
        messages: bodies.iter().enumerate().map(|(index,body)|json!({"id":format!("message-{index}"),"conversation_id":"conversation","conversation_sequence":index+1,"sender_account_id":"acct_test","content":{"blocks":[{"text":body}]},"deleted_at":null,"version":1})).collect(),
        events: vec![],
    }).unwrap();
    assert_eq!(
        load_all_conversation_heads(&conn, "acct_test").unwrap()[0].unread_count,
        2
    );
    apply_on_connection(&mut conn, ChatSyncApplyRequest {
        account_id: "acct_test".into(), bootstrap: false, cursor: None, last_stream_seq: Some(5),
        conversations: vec![json!({"id":"conversation", "kind":"ai", "version":2,"latest_message_sequence":4,"members":[{"account_id":"acct_test","last_read_sequence":4}]})],
        messages: vec![], events: vec![],
    }).unwrap();
    assert_eq!(
        load_all_conversation_heads(&conn, "acct_test").unwrap()[0].unread_count,
        0
    );
}

#[test]
fn unread_counts_cover_history_and_ignore_sync_controls() {
    let mut conn = super::test_support::test_connection();
    let mut messages = (1..=100)
        .map(|sequence| {
            json!({
                "id": format!("message-{sequence}"),
                "conversation_id": "conversation-1",
                "conversation_sequence": sequence,
                "client_message_id": format!("client-{sequence}"),
                "sender_account_id": "acct_peer",
                "deleted_at": null,
                "version": 1
            })
        })
        .collect::<Vec<_>>();
    let title = URL_SAFE_NO_PAD.encode(json!({ "kind": "session-title-update" }).to_string());
    messages.push(json!({
        "id": "control-101", "conversation_id": "conversation-1",
        "conversation_sequence": 101, "sender_account_id": "acct_peer",
        "content": { "blocks": [{ "text": format!("kordi-cloud-group:{title}") }] },
        "deleted_at": null, "version": 1
    }));
    let group_message = URL_SAFE_NO_PAD.encode(
        json!({
            "kind": "group-message",
            "message": { "id": "logical-message", "senderKind": "human" }
        })
        .to_string(),
    );
    for sequence in [102, 103] {
        messages.push(json!({
            "id": format!("duplicate-{sequence}"), "conversation_id": "conversation-1",
            "conversation_sequence": sequence, "sender_account_id": "acct_peer",
            "content": { "blocks": [{ "text": format!("kordi-cloud-group:{group_message}") }] },
            "deleted_at": null, "version": 1
        }));
    }
    apply_on_connection(
        &mut conn,
        ChatSyncApplyRequest {
            account_id: "acct_test".to_string(),
            bootstrap: true,
            cursor: Some("cursor-101".to_string()),
            last_stream_seq: Some(101),
            conversations: vec![json!({
                "id": "conversation-1",
                "kind": "group",
                "legacy_session_id": "session:group:one",
                "version": 1,
                "latest_message_sequence": 103,
                "members": [{
                    "account_id": "acct_test",
                    "last_read_sequence": 10
                }]
            })],
            messages,
            events: vec![],
        },
    )
    .unwrap();

    let counts = load_all_conversation_heads(&conn, "acct_test").unwrap();
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].session_id, "session:group:one");
    assert_eq!(counts[0].last_read_sequence, 10);
    assert_eq!(counts[0].unread_count, 91);
}
