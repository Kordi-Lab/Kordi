use super::*;

#[test]
fn read_session_returns_latest_window_in_transcript_order() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);

    let response = super::super::super::session_observation::read_session_for_observation_in_db(
        &conn,
        ReadSessionRequest {
            offset: None,
            session_id,
            around_message_id: None,
            limit: Some(2),
            mode: None,
            message_ids: None,
        },
    )
    .expect("read session");

    assert_eq!(response.session.title, "Launch planning");
    assert!(response.session.participants.is_empty());
    assert_eq!(
        response
            .messages
            .iter()
            .map(|message| message.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["msg:2", "msg:3"]
    );
    assert!(response.window.has_more_before);
    assert!(!response.window.has_more_after);
}

#[test]
fn group_observation_is_scoped_and_participants_are_loaded_only_on_demand() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    let request = || SearchSessionsRequest {
        query: "canary".to_string(),
        limit: Some(8),
        include_messages: Some(true),
    };
    let other_scope = super::super::super::session_observation::search_sessions_in_scope(
        &conn,
        request(),
        Some("session:other"),
    )
    .unwrap();
    assert!(other_scope.sessions.is_empty());
    let matching = super::super::super::session_observation::search_sessions_in_scope(
        &conn,
        request(),
        Some(&session_id),
    )
    .unwrap();
    assert_eq!(matching.sessions.len(), 1);
    assert_eq!(matching.sessions[0].snippets[0].message_id, "msg:2");
    let response = super::super::super::session_observation::read_session_for_observation_in_db(
        &conn,
        ReadSessionRequest {
            offset: None,
            session_id,
            around_message_id: None,
            limit: None,
            mode: Some("participants".to_string()),
            message_ids: None,
        },
    )
    .unwrap();
    assert_eq!(response.session.participants.len(), 2);
    assert!(response.messages.is_empty());
}

#[test]
fn long_message_details_can_be_read_in_bounded_chunks() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    let text = format!("{}older evidence", "x".repeat(1300));
    conn.execute(
        "UPDATE session_messages SET content_text = ?1 WHERE id = 'msg:1'",
        params![text],
    )
    .unwrap();
    let read = |offset| {
        super::super::super::session_observation::read_session_for_observation_in_db(
            &conn,
            ReadSessionRequest {
                offset: Some(offset),
                session_id: session_id.clone(),
                around_message_id: None,
                limit: Some(1),
                mode: Some("messages".to_string()),
                message_ids: Some(vec!["msg:1".to_string()]),
            },
        )
        .unwrap()
    };
    let first = read(0);
    assert_eq!(
        first.messages[0].text.as_ref().unwrap().chars().count(),
        1200
    );
    let second = read(first.messages[0].next_offset.unwrap());
    assert!(second.messages[0]
        .text
        .as_ref()
        .unwrap()
        .ends_with("older evidence"));
    assert_eq!(second.messages[0].next_offset, None);
}
