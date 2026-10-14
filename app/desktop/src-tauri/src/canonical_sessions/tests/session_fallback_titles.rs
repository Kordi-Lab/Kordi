use super::*;
use crate::canonical_sessions::desktop_sync::desktop_session_title_with_canonical_seed;

const SESSION_ID: &str = "session:project:failed-first-turns";

fn append_turn_message(conn: &Connection, index: i64, sender_role: &str, text: &str) {
    let sender_identity_id = if sender_role == "user" {
        "human:local"
    } else {
        "agent:local"
    };
    append_message_in_db(
        conn,
        AppendCanonicalMessageRequest {
            id: Some(format!("msg:failed-first-turns:{index}")),
            session_id: SESSION_ID.to_string(),
            sender_identity_id: sender_identity_id.to_string(),
            sender_role: sender_role.to_string(),
            message_kind: "text".to_string(),
            content_text: text.to_string(),
            content: None,
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some(
                if sender_role == "user" {
                    "sent"
                } else {
                    "failed"
                }
                .to_string(),
            ),
            created_at_ms: Some(1_000 + index),
            source_transport: Some("desktop-chat-ui".to_string()),
            source_event_id: Some(format!("failed-first-turns:{index}")),
        },
    )
    .expect("append canonical message");
}

fn sync_runtime_summary(conn: &Connection, runtime_title: &str) -> CanonicalSession {
    // The runtime row has no title yet, so its metadata says "placeholder".
    let metadata = serde_json::json!({
        "source": "desktop-project-summary",
        "sessionTitleSource": "placeholder",
        "titleSource": "placeholder",
        "sessionTitleRevision": 0,
    });
    let (title, metadata) =
        desktop_session_title_with_canonical_seed(conn, SESSION_ID, runtime_title, metadata)
            .expect("seed title");
    open_or_create_session_in_db(
        conn,
        OpenCanonicalSessionRequest {
            id: Some(SESSION_ID.to_string()),
            kind: "project".to_string(),
            title: Some(title),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:local".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:local".to_string()],
            metadata: Some(metadata),
        },
    )
    .expect("sync runtime summary")
}

fn title_source(session: &CanonicalSession) -> Option<String> {
    session
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("sessionTitleSource"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

fn seed_failed_first_turns(conn: &Connection) {
    seed_identity(conn, "human:local", "Me", "human");
    seed_identity(conn, "agent:local", "Kordi", "agent");
    append_turn_message(conn, 0, "user", "hi");
    append_turn_message(conn, 1, "owned-agent", "Provider is unavailable.");
    append_turn_message(conn, 2, "user", "check this worktree");
    append_turn_message(conn, 3, "owned-agent", "Provider is unavailable.");
}

#[test]
fn failed_turns_known_only_to_the_canonical_store_still_name_the_session() {
    let conn = test_conn();
    seed_failed_first_turns(&conn);

    let session = sync_runtime_summary(&conn, "New chat");

    assert_eq!(session.title, "Check this worktree");
    assert_eq!(title_source(&session).as_deref(), Some("auto"));

    // A later successful turn keeps the title from the first meaningful message.
    append_turn_message(&conn, 4, "user", "which model are you using");
    append_turn_message(&conn, 5, "owned-agent", "I am Kordi.");
    assert_eq!(
        sync_runtime_summary(&conn, "New chat").title,
        "Check this worktree"
    );
}

#[test]
fn stored_dated_fallback_title_is_replaced_automatically() {
    let conn = test_conn();
    seed_failed_first_turns(&conn);
    sync_runtime_summary(&conn, "New chat");
    // Older builds could store the runtime fallback with an "auto" source.
    conn.execute(
        "UPDATE sessions
         SET title = 'Chat with Kordi · Oct 13',
             metadata_json = json_set(metadata_json, '$.sessionTitleSource', 'auto',
                                      '$.titleSource', 'auto', '$.sessionTitleRevision', 1)
         WHERE id = ?1",
        [SESSION_ID],
    )
    .expect("seed dated fallback");

    let session = sync_runtime_summary(&conn, "Chat with Kordi · Oct 13");

    assert_eq!(session.title, "Check this worktree");
    assert_eq!(title_source(&session).as_deref(), Some("auto"));
}

#[test]
fn manual_title_is_never_replaced_by_a_seeded_title() {
    let conn = test_conn();
    seed_failed_first_turns(&conn);
    sync_runtime_summary(&conn, "New chat");
    rename_any_session_title_in_db(&conn, SESSION_ID, "Trust review").expect("rename");

    let session = sync_runtime_summary(&conn, "New chat");

    assert_eq!(session.title, "Trust review");
    assert_eq!(title_source(&session).as_deref(), Some("manual"));
}
