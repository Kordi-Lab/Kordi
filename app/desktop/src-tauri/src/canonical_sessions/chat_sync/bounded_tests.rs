use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::json;

use super::{
    apply_on_connection, load_all_conversation_heads, load_coverage, load_message_page,
    load_message_refs, load_recovery_message_ids, load_state, upsert_message, ChatSyncApplyRequest,
};

#[test]
fn unread_counts_cover_history_omitted_from_the_startup_projection() {
    let mut conn = super::test_support::test_connection();
    let messages = (1..=100)
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
        .collect();
    apply_on_connection(
        &mut conn,
        ChatSyncApplyRequest {
            account_id: "acct_test".to_string(),
            bootstrap: true,
            cursor: Some("cursor-100".to_string()),
            last_stream_seq: Some(100),
            conversations: vec![json!({
                "id": "conversation-1",
                "kind": "group",
                "legacy_session_id": "session:group:one",
                "version": 1,
                "latest_message_sequence": 100,
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
    assert_eq!(counts[0].unread_count, 90);
}

#[test]
fn authoritative_message_resolves_its_pending_outbox_operation() {
    let mut conn = super::test_support::test_connection();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_sync_pending_operations (
            account_id TEXT, operation_id TEXT,
            PRIMARY KEY(account_id, operation_id)
         );
         INSERT INTO chat_sync_pending_operations (account_id, operation_id)
         VALUES ('acct_test', 'client-1');",
    )
    .unwrap();
    let tx = conn.transaction().unwrap();
    upsert_message(
        &tx,
        "acct_test",
        &json!({
            "id": "message-1",
            "client_message_id": "client-1",
            "conversation_id": "conversation-1",
            "conversation_sequence": 1,
            "version": 1
        }),
    )
    .unwrap();
    tx.commit().unwrap();

    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM chat_sync_pending_operations",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0);
}

#[test]
fn apply_result_stays_bounded_as_unrelated_history_grows() {
    let mut conn = super::test_support::test_connection();
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
}

#[test]
fn local_state_pages_backfilled_group_history_for_replay() {
    let mut conn = super::test_support::test_connection();
    let message = |sequence| {
        json!({
            "id": format!("group-{sequence}"),
            "conversation_id": "conversation-group",
            "conversation_sequence": sequence,
            "version": 1
        })
    };
    apply_on_connection(
        &mut conn,
        ChatSyncApplyRequest {
            account_id: "acct_test".to_string(),
            bootstrap: true,
            cursor: Some("cursor-0".to_string()),
            last_stream_seq: Some(0),
            conversations: vec![json!({
                "id": "conversation-group",
                "kind": "group",
                "version": 1,
                "latest_message_sequence": 201
            })],
            messages: vec![message(201)],
            events: vec![],
        },
    )
    .unwrap();
    apply_on_connection(
        &mut conn,
        ChatSyncApplyRequest {
            account_id: "acct_test".to_string(),
            bootstrap: false,
            cursor: None,
            last_stream_seq: None,
            conversations: vec![],
            messages: (1..201).map(message).collect(),
            events: vec![],
        },
    )
    .unwrap();

    let recovered = load_state(&conn, "acct_test").unwrap();
    assert_eq!(recovered.messages.len(), 1);
    assert_eq!(recovered.messages[0]["id"], "group-201");

    let first = load_message_page(&conn, "acct_test", "conversation-group", None, 80).unwrap();
    assert_eq!(first.messages.len(), 80);
    assert_eq!(first.messages[0]["id"], "group-1");
    assert_eq!(first.next_after_sequence, Some(80));
    assert!(first.has_more);
    let second = load_message_page(
        &conn,
        "acct_test",
        "conversation-group",
        first.next_after_sequence,
        80,
    )
    .unwrap();
    assert_eq!(second.messages[0]["id"], "group-81");
    assert_eq!(second.next_after_sequence, Some(160));
    assert!(second.has_more);
    let third = load_message_page(
        &conn,
        "acct_test",
        "conversation-group",
        second.next_after_sequence,
        80,
    )
    .unwrap();
    assert_eq!(third.messages.len(), 41);
    assert_eq!(third.messages[40]["id"], "group-201");
    assert_eq!(third.next_after_sequence, Some(201));
    assert!(!third.has_more);
}

#[test]
fn local_state_keeps_one_terminal_agent_response_without_deleting_history() {
    let mut conn = super::test_support::test_connection();
    let response = |sequence: i64, delivery_state: &str, text: &str| {
        let envelope = json!({
            "kind": "agent-response",
            "requestId": "request-1",
            "text": text,
            "deliveryState": delivery_state,
            "execution": { "padding": "x".repeat(4_096) }
        });
        json!({
            "id": format!("response-{sequence}"),
            "conversation_id": "conversation-ai",
            "conversation_sequence": sequence,
            "sender_account_id": "acct_test",
            "client_message_id": format!("client-{sequence}"),
            "version": 1,
            "content": { "blocks": [{
                "type": "text",
                "text": format!(
                    "kordi-cloud-agent-response:{}",
                    URL_SAFE_NO_PAD.encode(envelope.to_string())
                )
            }] }
        })
    };
    apply_on_connection(
        &mut conn,
        ChatSyncApplyRequest {
            account_id: "acct_test".to_string(),
            bootstrap: true,
            cursor: Some("cursor-0".to_string()),
            last_stream_seq: Some(0),
            conversations: vec![json!({
                "id": "conversation-ai",
                "kind": "ai",
                "version": 1,
                "latest_message_sequence": 3
            })],
            messages: vec![
                response(1, "processing", "Long processing response"),
                response(2, "complete", "Complete response"),
                response(3, "processing", "Longer delayed processing response"),
            ],
            events: vec![],
        },
    )
    .unwrap();

    let loaded = load_state(&conn, "acct_test").unwrap();
    assert_eq!(loaded.messages.len(), 1);
    assert_eq!(loaded.messages[0]["id"], "response-2");
    assert_eq!(
        load_recovery_message_ids(&conn, "acct_test", "conversation-ai")
            .unwrap()
            .message_ids,
        vec!["response-2"]
    );
    assert_eq!(
        load_coverage(&conn, "acct_test").unwrap()[0].message_count,
        3
    );
}

#[test]
fn startup_projection_stays_under_scale_row_and_payload_budgets() {
    let mut conn = super::test_support::test_connection();
    let conversations = (0..200)
        .map(|conversation| {
            json!({
                "id": format!("conversation-{conversation}"),
                "kind": "group",
                "version": 1,
                "latest_message_sequence": 100
            })
        })
        .collect();
    let messages = (0..200)
        .flat_map(|conversation| {
            (1..=100).map(move |sequence| {
                json!({
                    "id": format!("message-{conversation}-{sequence}"),
                    "conversation_id": format!("conversation-{conversation}"),
                    "conversation_sequence": sequence,
                    "client_message_id": format!("client-{conversation}-{sequence}"),
                    "kind": "text",
                    "version": 1,
                    "content": { "padding": "x".repeat(256) }
                })
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
            conversations,
            messages,
            events: vec![],
        },
    )
    .unwrap();

    let startup = load_state(&conn, "acct_test").unwrap();
    assert_eq!(startup.messages.len(), 200);
    assert!(serde_json::to_vec(&startup).unwrap().len() < 5 * 1024 * 1024);
    assert_eq!(load_coverage(&conn, "acct_test").unwrap().len(), 200);
}

#[test]
fn startup_projection_keeps_latest_route_beside_conversation_head() {
    let mut conn = super::test_support::test_connection();
    apply_on_connection(
        &mut conn,
        ChatSyncApplyRequest {
            account_id: "acct_test".to_string(),
            bootstrap: true,
            cursor: None,
            last_stream_seq: None,
            conversations: vec![json!({
                "id": "conversation-ai",
                "kind": "ai",
                "version": 1,
                "latest_message_sequence": 101
            })],
            messages: [
                vec![json!({
                    "id": "route-1",
                    "conversation_id": "conversation-ai",
                    "conversation_sequence": 1,
                    "kind": "agent-model-change",
                    "version": 1
                })],
                (2..=101)
                    .map(|sequence| {
                        json!({
                            "id": format!("message-{sequence}"),
                            "conversation_id": "conversation-ai",
                            "conversation_sequence": sequence,
                            "kind": "text",
                            "version": 1
                        })
                    })
                    .collect(),
            ]
            .concat(),
            events: vec![],
        },
    )
    .unwrap();

    let startup = load_state(&conn, "acct_test").unwrap();
    assert_eq!(startup.messages.len(), 2);
    assert_eq!(startup.messages[0]["id"], "route-1");
    assert_eq!(startup.messages[1]["id"], "message-101");
}

#[test]
fn startup_projection_keeps_a_bounded_direct_transcript() {
    let mut conn = super::test_support::test_connection();
    apply_on_connection(
        &mut conn,
        ChatSyncApplyRequest {
            account_id: "acct_test".to_string(),
            bootstrap: true,
            cursor: None,
            last_stream_seq: None,
            conversations: vec![json!({
                "id": "conversation-direct",
                "kind": "direct",
                "version": 1,
                "latest_message_sequence": 100
            })],
            messages: (1..=100)
                .map(|sequence| {
                    json!({
                        "id": format!("direct-{sequence}"),
                        "conversation_id": "conversation-direct",
                        "conversation_sequence": sequence,
                        "kind": "text",
                        "version": 1
                    })
                })
                .collect(),
            events: vec![],
        },
    )
    .unwrap();

    let startup = load_state(&conn, "acct_test").unwrap();
    assert_eq!(startup.messages.len(), 64);
    assert_eq!(startup.messages[0]["id"], "direct-37");
    assert_eq!(startup.messages[63]["id"], "direct-100");
}
