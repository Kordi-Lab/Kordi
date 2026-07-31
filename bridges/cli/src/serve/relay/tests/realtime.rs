//! Realtime WebSocket delivery and acknowledgement-aware polling scenarios.

use super::*;

#[tokio::test]
async fn derp_realtime_message_is_mailboxed_until_receiver_acks() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node(&state, "sender", "sender-key");
    seed_registered_node(&state, "receiver", "receiver-key");
    seed_contact(&state, "sender", "receiver");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    tokio::spawn(async move {
        axum::serve(listener, routes(server_state)).await.unwrap();
    });
    let base_url = format!("ws://{addr}");

    let _receiver_socket = connect_test_derp_client(&base_url, "receiver-key").await;
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    let mut sender_socket = connect_test_derp_client(&base_url, "sender-key").await;
    let payload = serde_json::json!({
        "requestId": "bridge_req_ws_durable_1",
        "messageType": "raw",
        "payload": { "message": "durable websocket message" },
    });
    let frame = DerpFrame {
        src: None,
        dst: Some("receiver".to_string()),
        durable: Some(true),
        target_kind: None,
        data: serde_json::to_vec(&payload).unwrap(),
    };
    sender_socket
        .send(TungsteniteMessage::Text(
            serde_json::to_string(&frame).unwrap(),
        ))
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let pending = poll_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(100),
            after: None,
        }),
    )
    .await
    .expect("poll mailbox")
    .0;
    assert_eq!(pending.entries.len(), 1);
    assert_eq!(pending.entries[0].from, "sender");

    let ack_ids = pending
        .entries
        .iter()
        .map(|entry| entry.message_id.clone())
        .collect::<Vec<_>>();
    ack_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxAckReq {
            message_ids: ack_ids,
        }),
    )
    .await
    .expect("ack mailbox");

    let after_ack = poll_mailbox_v2(
        State(state),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(100),
            after: None,
        }),
    )
    .await
    .expect("poll after ack")
    .0;
    assert!(after_ack.entries.is_empty());
}

#[tokio::test]
async fn derp_realtime_message_requires_contact_or_project_before_mailbox() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node(&state, "sender", "sender-key");
    seed_registered_node(&state, "receiver", "receiver-key");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    tokio::spawn(async move {
        axum::serve(listener, routes(server_state)).await.unwrap();
    });
    let base_url = format!("ws://{addr}");

    let _receiver_socket = connect_test_derp_client(&base_url, "receiver-key").await;
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    let mut sender_socket = connect_test_derp_client(&base_url, "sender-key").await;
    let frame = DerpFrame {
        src: None,
        dst: Some("receiver".to_string()),
        durable: Some(true),
        target_kind: None,
        data: serde_json::to_vec(&serde_json::json!({
            "requestId": "bridge_req_ws_unauthorized",
            "messageType": "raw",
            "payload": { "message": "should not mailbox" },
        }))
        .unwrap(),
    };
    sender_socket
        .send(TungsteniteMessage::Text(
            serde_json::to_string(&frame).unwrap(),
        ))
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let pending = poll_mailbox_v2(
        State(state),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(100),
            after: None,
        }),
    )
    .await
    .expect("poll mailbox")
    .0;
    assert!(pending.entries.is_empty());
}

#[tokio::test]
async fn derp_group_invite_requires_contact_even_for_server_open_target() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node(&state, "sender", "sender-key");
    seed_registered_node_with_policy(
        &state,
        "receiver",
        "receiver-key",
        RegisteredNodePolicy::human("human-receiver", "server-open", "auto", "contacts"),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    tokio::spawn(async move {
        axum::serve(listener, routes(server_state)).await.unwrap();
    });
    let base_url = format!("ws://{addr}");

    let _receiver_socket = connect_test_derp_client(&base_url, "receiver-key").await;
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    let mut sender_socket = connect_test_derp_client(&base_url, "sender-key").await;
    let frame = DerpFrame {
        src: None,
        dst: Some("receiver".to_string()),
        durable: Some(true),
        target_kind: Some("person-invite".to_string()),
        data: serde_json::to_vec(&serde_json::json!({
            "requestId": "bridge_req_ws_group_invite",
            "messageType": "raw",
            "payload": { "message": "group invite" },
        }))
        .unwrap(),
    };
    sender_socket
        .send(TungsteniteMessage::Text(
            serde_json::to_string(&frame).unwrap(),
        ))
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let pending = poll_mailbox_v2(
        State(state),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(100),
            after: None,
        }),
    )
    .await
    .expect("poll mailbox")
    .0;
    assert!(pending.entries.is_empty());
}

#[tokio::test]
async fn mailbox_poll_requires_ack_before_removal() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_mailbox_entry(&state, "sender", "receiver", "blob-1");
    seed_mailbox_entry(&state, "sender", "receiver", "blob-2");

    let first = poll_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(100),
            after: None,
        }),
    )
    .await
    .expect("poll mailbox")
    .0;
    assert_eq!(first.entries.len(), 2);

    let second = poll_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(100),
            after: None,
        }),
    )
    .await
    .expect("poll mailbox again")
    .0;
    assert_eq!(second.entries.len(), 2, "poll must not destructively drain");

    let ack_ids = first
        .entries
        .iter()
        .map(|entry| entry.message_id.clone())
        .collect();
    ack_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxAckReq {
            message_ids: ack_ids,
        }),
    )
    .await
    .expect("ack mailbox");

    let after_ack = poll_mailbox_v2(
        State(state),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(100),
            after: None,
        }),
    )
    .await
    .expect("poll after ack")
    .0;
    assert_eq!(after_ack.entries.len(), 0);
}

#[tokio::test]
async fn mailbox_poll_after_acked_cursor_returns_remaining_entries() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_mailbox_entry(&state, "sender", "receiver", "blob-1");
    seed_mailbox_entry(&state, "sender", "receiver", "blob-2");

    let first_page = poll_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(1),
            after: None,
        }),
    )
    .await
    .expect("poll first page")
    .0;
    assert_eq!(first_page.entries.len(), 1);
    let first_message_id = first_page.entries[0].message_id.clone();

    ack_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxAckReq {
            message_ids: vec![first_message_id.clone()],
        }),
    )
    .await
    .expect("ack first message");

    let remaining = poll_mailbox_v2(
        State(state),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(100),
            after: Some(first_message_id),
        }),
    )
    .await
    .expect("poll after acked cursor")
    .0;
    assert_eq!(remaining.entries.len(), 1);
    assert_eq!(remaining.entries[0].blob, "blob-2");
}
