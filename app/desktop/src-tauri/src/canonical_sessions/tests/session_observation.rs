use super::*;
use kordi_tools::{ReadSessionRequest, SearchSessionsRequest};

fn seed_session_with_messages(conn: &Connection) -> String {
    seed_identity(conn, "human:alice", "Alice", "human");
    seed_identity(conn, "human:bob", "Bob", "human");
    let session = open_or_create_session_in_db(
        conn,
        OpenCanonicalSessionRequest {
            id: Some("session:launch".to_string()),
            kind: "group".to_string(),
            title: Some("Launch planning".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:alice".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:bob".to_string()],
            metadata: None,
        },
    )
    .expect("seed session");
    for (id, sender, text) in [
        ("msg:1", "human:alice", "Kickoff notes"),
        ("msg:2", "human:bob", "The canary deploy is ready"),
        ("msg:3", "human:alice", "Please review the rollout"),
    ] {
        append_message_in_db(
            conn,
            AppendCanonicalMessageRequest {
                id: Some(id.to_string()),
                session_id: session.id.clone(),
                sender_identity_id: sender.to_string(),
                sender_role: if sender == "human:alice" {
                    "self"
                } else {
                    "person"
                }
                .to_string(),
                message_kind: "text".to_string(),
                content_text: text.to_string(),
                content: None,
                created_at_ms: Some(1_800_000_000_000),
                parent_message_id: None,
                delegated_exchange_id: None,
                status: Some("sent".to_string()),
                source_transport: None,
                source_event_id: None,
            },
        )
        .expect("append message");
    }
    session.id
}

#[test]
fn search_sessions_matches_message_text_and_returns_snippets() {
    let conn = test_conn();
    seed_session_with_messages(&conn);

    let response = super::super::session_observation::search_sessions_for_observation_in_db(
        &conn,
        SearchSessionsRequest {
            query: "canary".to_string(),
            limit: Some(10),
            include_messages: Some(true),
        },
    )
    .expect("search sessions");

    assert_eq!(response.sessions.len(), 1);
    let result = &response.sessions[0];
    assert_eq!(result.session_id, "session:launch");
    assert_eq!(result.title, "Launch planning");
    assert_eq!(result.reason, "Matched message text");
    assert_eq!(result.snippets[0].message_id, "msg:2");
    assert_eq!(result.snippets[0].sender, "Bob");
}

#[test]
fn search_sessions_treats_like_wildcards_as_literal_text() {
    let conn = test_conn();
    seed_session_with_messages(&conn);

    let response = super::super::session_observation::search_sessions_for_observation_in_db(
        &conn,
        SearchSessionsRequest {
            query: "%".to_string(),
            limit: Some(10),
            include_messages: Some(true),
        },
    )
    .expect("search sessions");

    assert!(response.sessions.is_empty());
}

#[test]
fn search_sessions_truncates_long_message_snippets() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:long-search".to_string()),
            session_id,
            sender_identity_id: "human:bob".to_string(),
            sender_role: "person".to_string(),
            message_kind: "text".to_string(),
            content_text: format!("needle {}", "x".repeat(900)),
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

    let response = super::super::session_observation::search_sessions_for_observation_in_db(
        &conn,
        SearchSessionsRequest {
            query: "needle".to_string(),
            limit: Some(10),
            include_messages: Some(true),
        },
    )
    .expect("search sessions");

    let text = &response.sessions[0].snippets[0].text;
    assert!(text.chars().count() <= 500);
    assert!(text.ends_with('…'));
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

    let response = super::super::session_observation::read_session_for_observation_in_db(
        &conn,
        ReadSessionRequest {
            session_id,
            around_message_id: Some("msg:long-read".to_string()),
            limit: Some(1),
        },
    )
    .expect("read session");

    assert_eq!(response.messages.len(), 1);
    assert!(response.messages[0].text.chars().count() <= 1_200);
    assert!(response.messages[0].text.ends_with('…'));
}

#[test]
fn read_session_returns_latest_window_in_transcript_order() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);

    let response = super::super::session_observation::read_session_for_observation_in_db(
        &conn,
        ReadSessionRequest {
            session_id,
            around_message_id: None,
            limit: Some(2),
        },
    )
    .expect("read session");

    assert_eq!(response.session.title, "Launch planning");
    assert_eq!(response.session.participants.len(), 2);
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
