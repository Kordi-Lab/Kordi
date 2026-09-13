use super::*;

#[test]
fn read_session_defaults_to_index_without_message_text() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);

    let response =
        crate::canonical_sessions::session_observation::read_session_for_observation_in_db(
            &conn,
            ReadSessionRequest {
                before_sequence: None,
                attachment_id: None,
                expected_version: None,
                offset: None,
                session_id,
                around_message_id: None,
                limit: Some(2),
                mode: None,
                message_ids: None,
            },
        )
        .expect("read session index");

    assert_eq!(response.messages.len(), 2);
    assert_eq!(response.messages[0].message_id, "msg:2");
    assert_eq!(response.messages[0].sequence_num, 2);
    assert!(response.messages[0].text.is_none());
    assert_eq!(response.messages[1].message_id, "msg:3");
    assert_eq!(response.messages[1].sequence_num, 3);
    assert!(response.messages[1].text.is_none());
}

#[test]
fn read_session_reads_only_requested_message_details_by_id() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);

    let response =
        crate::canonical_sessions::session_observation::read_session_for_observation_in_db(
            &conn,
            ReadSessionRequest {
                before_sequence: None,
                attachment_id: None,
                expected_version: None,
                offset: None,
                session_id,
                around_message_id: None,
                limit: Some(10),
                mode: Some("messages".to_string()),
                message_ids: Some(vec!["msg:3".to_string(), "msg:1".to_string()]),
            },
        )
        .expect("read selected messages");

    assert_eq!(
        response
            .messages
            .iter()
            .map(|message| message.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["msg:1", "msg:3"]
    );
    assert_eq!(response.messages[0].text.as_deref(), Some("Kickoff notes"));
    assert_eq!(
        response.messages[1].text.as_deref(),
        Some("Please review the rollout")
    );
}

#[test]
fn read_session_messages_mode_requires_message_ids() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);

    let error = crate::canonical_sessions::session_observation::read_session_for_observation_in_db(
        &conn,
        ReadSessionRequest {
            before_sequence: None,
            attachment_id: None,
            expected_version: None,
            offset: None,
            session_id,
            around_message_id: None,
            limit: Some(10),
            mode: Some("messages".to_string()),
            message_ids: Some(Vec::new()),
        },
    )
    .expect_err("messages mode without ids should fail");

    assert!(error.contains("messageIds cannot be empty"));
}

#[test]
fn read_session_truncates_long_message_text() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:long-read".to_string()),
            session_id: session_id.clone(),
            sender_identity_id: "human:bob".to_string(),
            sender_role: "person".to_string(),
            message_kind: "text".to_string(),
            content_text: "x".repeat(1_600),
            content: None,
            created_at_ms: Some(1_800_000_000_000),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: None,
            source_event_id: None,
        },
    )
    .expect("append long message");

    let response =
        crate::canonical_sessions::session_observation::read_session_for_observation_in_db(
            &conn,
            ReadSessionRequest {
                before_sequence: None,
                attachment_id: None,
                expected_version: None,
                offset: None,
                session_id,
                around_message_id: None,
                limit: Some(1),
                mode: Some("messages".to_string()),
                message_ids: Some(vec!["msg:long-read".to_string()]),
            },
        )
        .expect("read session");

    assert_eq!(response.messages.len(), 1);
    let text = response.messages[0]
        .text
        .as_ref()
        .expect("message text should be disclosed in messages mode");
    assert!(text.chars().count() <= 1_200);
    assert!(text.ends_with('…'));
}
