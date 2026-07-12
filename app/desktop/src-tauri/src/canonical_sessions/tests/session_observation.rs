use super::*;
use kordi_tools::{ReadSessionRequest, SearchSessionsRequest};

struct TempSqliteFile {
    path: std::path::PathBuf,
}

impl TempSqliteFile {
    fn new() -> Self {
        Self {
            path: std::env::temp_dir().join(format!(
                "kordi-monotonic-read-cursor-{}.sqlite3",
                Uuid::new_v4().simple()
            )),
        }
    }

    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for TempSqliteFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

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

fn participant_read_state(
    conn: &Connection,
    session_id: &str,
    identity_id: &str,
) -> (Option<i64>, Option<String>) {
    conn.query_row(
        "SELECT last_seen_at_ms, last_read_message_id
         FROM session_participants
         WHERE session_id = ?1 AND identity_id = ?2",
        params![session_id, identity_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("read participant cursor")
}

fn seed_other_session_with_message(conn: &Connection) -> String {
    let session = open_or_create_session_in_db(
        conn,
        OpenCanonicalSessionRequest {
            id: Some("session:other".to_string()),
            kind: "group".to_string(),
            title: Some("Other session".to_string()),
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
    .expect("seed other session");
    append_message_in_db(
        conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:other".to_string()),
            session_id: session.id.clone(),
            sender_identity_id: "human:alice".to_string(),
            sender_role: "self".to_string(),
            message_kind: "text".to_string(),
            content_text: "Other session message".to_string(),
            content: None,
            created_at_ms: Some(1_800_000_000_001),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: None,
            source_event_id: None,
        },
    )
    .expect("append other session message");
    session.id
}

#[test]
fn mark_session_read_returns_self_participant_cursor_delta() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);

    let result = mark_session_read_in_db(
        &conn,
        MarkCanonicalSessionReadRequest {
            session_id,
            identity_id: Some("human:alice".to_string()),
            message_id: Some("msg:3".to_string()),
        },
    )
    .expect("mark session read")
    .expect("self participant cursor delta");

    assert_eq!(result.session_id, "session:launch");
    assert_eq!(result.identity_id, "human:alice");
    assert!(result.last_seen_at_ms > 0);
    assert_eq!(result.last_read_message_id.as_deref(), Some("msg:3"));
}

#[test]
fn mark_session_read_uses_latest_readable_message_when_target_is_omitted() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);

    let result = mark_session_read_in_db(
        &conn,
        MarkCanonicalSessionReadRequest {
            session_id,
            identity_id: Some("human:alice".to_string()),
            message_id: None,
        },
    )
    .expect("mark latest message read")
    .expect("latest cursor delta");

    assert_eq!(result.last_read_message_id.as_deref(), Some("msg:3"));
}

#[test]
fn mark_session_read_advances_from_a_missing_current_cursor() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    conn.execute(
        "UPDATE session_participants
         SET last_read_message_id = 'msg:removed'
         WHERE session_id = ?1 AND identity_id = 'human:alice'",
        params![session_id],
    )
    .expect("seed missing cursor");

    let result = mark_session_read_in_db(
        &conn,
        MarkCanonicalSessionReadRequest {
            session_id,
            identity_id: Some("human:alice".to_string()),
            message_id: Some("msg:2".to_string()),
        },
    )
    .expect("advance missing cursor")
    .expect("replacement cursor delta");

    assert_eq!(result.last_read_message_id.as_deref(), Some("msg:2"));
}

#[test]
fn mark_session_read_does_not_move_cursor_backward_across_connections() {
    // Declaring the guard first makes it clean up after both connections during unwind.
    let db_file = TempSqliteFile::new();
    let newer_conn = Connection::open(db_file.path()).expect("open newer connection");
    schema::initialize_schema(&newer_conn).expect("initialize schema");
    let session_id = seed_session_with_messages(&newer_conn);
    let stale_conn = Connection::open(db_file.path()).expect("open stale connection");

    let newer = mark_session_read_in_db(
        &newer_conn,
        MarkCanonicalSessionReadRequest {
            session_id: session_id.clone(),
            identity_id: Some("human:alice".to_string()),
            message_id: Some("msg:2".to_string()),
        },
    )
    .expect("mark newer message read")
    .expect("newer cursor delta");
    assert_eq!(newer.last_read_message_id.as_deref(), Some("msg:2"));
    let newer_seen_at_ms = i64::MAX - 1;
    newer_conn
        .execute(
            "UPDATE session_participants
             SET last_seen_at_ms = ?1
             WHERE session_id = ?2 AND identity_id = 'human:alice'",
            params![newer_seen_at_ms, session_id],
        )
        .expect("model newer completion timestamp");

    let stale = mark_session_read_in_db(
        &stale_conn,
        MarkCanonicalSessionReadRequest {
            session_id: session_id.clone(),
            identity_id: Some("human:alice".to_string()),
            message_id: Some("msg:1".to_string()),
        },
    )
    .expect("mark stale message read")
    .expect("stale cursor delta");

    assert_eq!(stale.last_read_message_id.as_deref(), Some("msg:2"));
    assert_eq!(
        (stale.last_seen_at_ms, stale.last_read_message_id.clone()),
        (newer_seen_at_ms, Some("msg:2".to_string()))
    );
    assert_eq!(
        participant_read_state(&newer_conn, &session_id, "human:alice"),
        (Some(newer_seen_at_ms), Some("msg:2".to_string()))
    );
}

#[test]
fn mark_session_read_rejects_cross_session_target_without_mutation() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    seed_other_session_with_message(&conn);
    mark_session_read_in_db(
        &conn,
        MarkCanonicalSessionReadRequest {
            session_id: session_id.clone(),
            identity_id: Some("human:alice".to_string()),
            message_id: Some("msg:2".to_string()),
        },
    )
    .expect("seed read cursor");
    let before = participant_read_state(&conn, &session_id, "human:alice");

    let result = mark_session_read_in_db(
        &conn,
        MarkCanonicalSessionReadRequest {
            session_id: session_id.clone(),
            identity_id: Some("human:alice".to_string()),
            message_id: Some("msg:other".to_string()),
        },
    );

    assert!(result.is_err(), "cross-session target must be rejected");
    assert_eq!(
        participant_read_state(&conn, &session_id, "human:alice"),
        before
    );
}

#[test]
fn mark_session_read_rejects_unknown_target_without_mutation() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    mark_session_read_in_db(
        &conn,
        MarkCanonicalSessionReadRequest {
            session_id: session_id.clone(),
            identity_id: Some("human:alice".to_string()),
            message_id: Some("msg:2".to_string()),
        },
    )
    .expect("seed read cursor");
    let before = participant_read_state(&conn, &session_id, "human:alice");

    let result = mark_session_read_in_db(
        &conn,
        MarkCanonicalSessionReadRequest {
            session_id: session_id.clone(),
            identity_id: Some("human:alice".to_string()),
            message_id: Some("msg:missing".to_string()),
        },
    );

    assert!(result.is_err(), "unknown target must be rejected");
    assert_eq!(
        participant_read_state(&conn, &session_id, "human:alice"),
        before
    );
}

#[test]
fn mark_session_read_rejects_unreadable_target_without_mutation() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    mark_session_read_in_db(
        &conn,
        MarkCanonicalSessionReadRequest {
            session_id: session_id.clone(),
            identity_id: Some("human:alice".to_string()),
            message_id: Some("msg:2".to_string()),
        },
    )
    .expect("seed read cursor");
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:sending".to_string()),
            session_id: session_id.clone(),
            sender_identity_id: "human:alice".to_string(),
            sender_role: "self".to_string(),
            message_kind: "text".to_string(),
            content_text: "Still sending".to_string(),
            content: None,
            created_at_ms: Some(1_800_000_000_001),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sending".to_string()),
            source_transport: None,
            source_event_id: None,
        },
    )
    .expect("append transient message");
    let before = participant_read_state(&conn, &session_id, "human:alice");

    let result = mark_session_read_in_db(
        &conn,
        MarkCanonicalSessionReadRequest {
            session_id: session_id.clone(),
            identity_id: Some("human:alice".to_string()),
            message_id: Some("msg:sending".to_string()),
        },
    );

    assert!(result.is_err(), "unreadable target must be rejected");
    assert_eq!(
        participant_read_state(&conn, &session_id, "human:alice"),
        before
    );
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
fn search_sessions_defaults_to_session_list_without_snippets() {
    let conn = test_conn();
    seed_session_with_messages(&conn);

    let response = super::super::session_observation::search_sessions_for_observation_in_db(
        &conn,
        SearchSessionsRequest {
            query: "canary".to_string(),
            limit: Some(10),
            include_messages: None,
        },
    )
    .expect("search sessions");

    assert_eq!(response.sessions.len(), 1);
    assert!(response.sessions[0].snippets.is_empty());
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
fn read_session_defaults_to_index_without_message_text() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);

    let response = super::super::session_observation::read_session_for_observation_in_db(
        &conn,
        ReadSessionRequest {
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

    let response = super::super::session_observation::read_session_for_observation_in_db(
        &conn,
        ReadSessionRequest {
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

    let error = super::super::session_observation::read_session_for_observation_in_db(
        &conn,
        ReadSessionRequest {
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

    let response = super::super::session_observation::read_session_for_observation_in_db(
        &conn,
        ReadSessionRequest {
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
            mode: None,
            message_ids: None,
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
