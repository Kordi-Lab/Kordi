use serde_json::json;

use super::{
    apply_on_connection, load_coverage, load_message_refs, load_state, ChatSyncApplyRequest,
};

#[test]
fn apply_result_stays_bounded_as_unrelated_history_grows() {
    let mut conn = super::tests::test_connection();
    let unrelated_messages = (1..=100)
        .map(|sequence| {
            json!({
                "id": format!("unrelated-{sequence}"),
                "conversation_id": "conversation-2",
                "conversation_sequence": sequence,
                "client_message_id": format!("client-unrelated-{sequence}"),
                "version": 1,
                "content": { "padding": "x".repeat(4_096) }
            })
        })
        .collect();
    apply_on_connection(
        &mut conn,
        ChatSyncApplyRequest {
            account_id: "acct_test".to_string(),
            bootstrap: true,
            cursor: Some("cursor-0".to_string()),
            last_stream_seq: Some(0),
            conversations: vec![
                json!({ "id": "conversation-1", "kind": "group", "version": 1, "latest_message_sequence": 0 }),
                json!({ "id": "conversation-2", "kind": "group", "version": 1, "latest_message_sequence": 100 }),
                json!({ "id": "conversation-3", "kind": "direct", "version": 1, "latest_message_sequence": 2 }),
            ],
            messages: [
                unrelated_messages,
                vec![
                    json!({
                        "id": "direct-1",
                        "conversation_id": "conversation-3",
                        "conversation_sequence": 1,
                        "client_message_id": "client-direct-1",
                        "version": 1
                    }),
                    json!({
                        "id": "direct-2",
                        "conversation_id": "conversation-3",
                        "conversation_sequence": 2,
                        "client_message_id": "client-direct-2",
                        "version": 1
                    }),
                ],
            ]
            .concat(),
            events: vec![],
        },
    )
    .unwrap();

    let result = apply_on_connection(
        &mut conn,
        ChatSyncApplyRequest {
            account_id: "acct_test".to_string(),
            bootstrap: false,
            cursor: Some("cursor-1".to_string()),
            last_stream_seq: Some(1),
            conversations: vec![],
            messages: vec![],
            events: vec![json!({
                "stream_seq": 1,
                "protocol_version": 2,
                "type": "message.created",
                "conversation_id": "conversation-1",
                "critical": true,
                "payload": {
                    "conversation": {
                        "id": "conversation-1",
                        "version": 2,
                        "latest_message_sequence": 1
                    },
                    "message": {
                        "id": "message-1",
                        "conversation_id": "conversation-1",
                        "conversation_sequence": 1,
                        "version": 1
                    }
                }
            })],
        },
    )
    .unwrap();

    assert_eq!(result.cursor.as_deref(), Some("cursor-1"));
    assert_eq!(result.last_stream_seq, 1);
    assert_eq!(result.changed_conversation_heads.len(), 1);
    assert_eq!(
        result.changed_conversation_heads[0].conversation_id,
        "conversation-1"
    );
    assert_eq!(
        result.changed_conversation_heads[0].latest_message_sequence,
        1
    );
    assert!(serde_json::to_vec(&result).unwrap().len() < 512);

    let coverage = load_coverage(&conn, "acct_test").unwrap();
    assert_eq!(coverage.len(), 3);
    assert_eq!(coverage[0].conversation_id, "conversation-1");
    assert_eq!(coverage[0].message_count, 1);
    assert_eq!(coverage[1].conversation_id, "conversation-2");
    assert_eq!(coverage[1].message_count, 100);
    assert_eq!(coverage[2].conversation_id, "conversation-3");
    assert_eq!(coverage[2].message_count, 2);

    let refs = load_message_refs(&conn, "acct_test", &["conversation-2".to_string()]).unwrap();
    assert_eq!(refs.len(), 100);
    assert!(serde_json::to_vec(&refs).unwrap().len() < 16_000);

    let startup = load_state(&conn, "acct_test").unwrap();
    assert_eq!(startup.messages.len(), 4);
    assert_eq!(startup.messages[0]["id"], "message-1");
    assert_eq!(startup.messages[1]["id"], "unrelated-100");
    assert_eq!(startup.messages[2]["id"], "direct-1");
    assert_eq!(startup.messages[3]["id"], "direct-2");
    assert!(serde_json::to_vec(&startup).unwrap().len() < 16_000);
}
