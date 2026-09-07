use super::{
    content_with_desktop_runtime, fork_metadata_value, metadata_with_fork,
    resolve_desktop_entry_to_canonical_message_id,
};
use rusqlite::Connection;

#[test]
fn fork_metadata_value_includes_session_message_and_policy_defaults() {
    let conn = Connection::open_in_memory().expect("open db");
    let value = fork_metadata_value(&conn, Some("session:source"), Some("msg:source"))
        .expect("fork metadata builds")
        .expect("fork metadata is emitted when source session is present");
    assert_eq!(value["forkedFromSessionId"], "session:source");
    assert_eq!(value["forkedFromMessageId"], "msg:source");
    assert_eq!(value["forkMode"], "private-local");
    assert_eq!(value["contextPolicy"], "prefix-through-message");
    assert_eq!(value["boundary"], "inherited-history-reference-only");
    assert_eq!(
        value["forkedFromMessageAliases"],
        serde_json::json!(["msg:source"])
    );
}

#[test]
fn fork_metadata_value_omits_message_id_when_unknown() {
    let conn = Connection::open_in_memory().expect("open db");
    let value = fork_metadata_value(&conn, Some("session:source"), None)
        .expect("fork metadata builds")
        .expect("fork metadata is emitted when source session is present");
    assert!(value.get("forkedFromMessageId").is_none());
}

#[test]
fn fork_metadata_value_returns_none_without_source_session() {
    let conn = Connection::open_in_memory().expect("open db");
    assert!(fork_metadata_value(&conn, None, Some("entry:42"))
        .expect("fork metadata builds")
        .is_none());
    assert!(fork_metadata_value(&conn, Some("   "), Some("entry:42"))
        .expect("fork metadata builds")
        .is_none());
}

#[test]
fn metadata_with_fork_appends_fork_subobject_without_clobbering_base_keys() {
    let base = serde_json::json!({
        "source": "desktop-chat-detail",
        "subtitle": "talking about forks",
    });
    let conn = Connection::open_in_memory().expect("open db");
    let combined = metadata_with_fork(
        &conn,
        None,
        base,
        Some("session:source"),
        Some("msg:source"),
    )
    .expect("metadata builds");
    assert_eq!(combined["source"], "desktop-chat-detail");
    assert_eq!(combined["subtitle"], "talking about forks");
    assert_eq!(combined["fork"]["forkedFromSessionId"], "session:source");
    assert_eq!(combined["fork"]["forkedFromMessageId"], "msg:source");
}

#[test]
fn metadata_with_fork_returns_base_when_no_fork_lineage() {
    let base = serde_json::json!({"source": "desktop-chat-summary"});
    let conn = Connection::open_in_memory().expect("open db");
    let combined =
        metadata_with_fork(&conn, None, base.clone(), None, None).expect("metadata builds");
    assert_eq!(combined, base);
}

#[test]
fn desktop_runtime_content_persists_the_entry_id_alias() {
    let message = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("Kordi".to_string()),
        text: "A response".to_string(),
        detail: None,
        time_label: "12:00".to_string(),
        timestamp_ms: 1_000,
        failed: false,
        cancelled: false,
        attachments: Vec::new(),
        thinking_text: None,
        tools: Vec::new(),
        entry_id: Some("entry:runtime-agent".to_string()),
    };

    let content =
        content_with_desktop_runtime(None, &message, None).expect("desktop content builds");
    assert_eq!(content["desktopEntryId"], "entry:runtime-agent");
}

#[test]
fn cloud_request_identity_reconciles_without_matching_message_text() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE session_messages (
        id TEXT PRIMARY KEY, session_id TEXT, sender_role TEXT,
        source_transport TEXT, source_event_id TEXT, content_json TEXT
    ); INSERT INTO session_messages VALUES
        ('canonical-one', 'session', 'user', 'cloud-self-agent', 'request-one', '{}'),
        ('canonical-two', 'session', 'user', 'cloud-self-agent', 'request-two', '{}');",
    )
    .unwrap();
    let message = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "user".to_string(),
        sender: None,
        text: "Identical repeated text".to_string(),
        detail: None,
        time_label: "12:00".to_string(),
        timestamp_ms: 1000,
        failed: false,
        cancelled: false,
        attachments: Vec::new(),
        thinking_text: None,
        tools: Vec::new(),
        entry_id: Some("request-two".to_string()),
    };
    assert_eq!(
        super::sync_desktop_chat_message(&conn, "session", "human", "agent", 0, &message, None)
            .unwrap(),
        Some("canonical-two".to_string())
    );
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM session_messages", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn desktop_sync_preserves_the_canonical_fork_contract_and_runtime_aliases() {
    let conn = Connection::open_in_memory().expect("open db");
    super::super::schema::initialize_schema(&conn).expect("canonical schema");
    let existing_metadata = serde_json::json!({
        "source": "canonical-fork-snapshot",
        "fork": {
            "forkedFromSessionId": "session:source",
            "forkedFromMessageId": "msg:source",
            "forkedFromMessageAliases": ["msg:source", "entry:runtime-source"],
            "forkMode": "private-local",
            "contextPolicy": "prefix-through-message",
            "boundary": "inherited-history-reference-only",
            "snapshotMessageCount": 6,
        },
    });
    conn.execute(
        "INSERT INTO sessions(
            id, kind, title, status, created_by_identity_id, metadata_json,
            created_at_ms, updated_at_ms
         ) VALUES (?1, 'self-agent', 'New fork', 'active', 'human:me', ?2, 1, 1)",
        rusqlite::params!["session:fork", existing_metadata.to_string()],
    )
    .expect("fork session");

    let combined = metadata_with_fork(
        &conn,
        Some("session:fork"),
        serde_json::json!({"source": "desktop-chat-detail"}),
        Some("session:source"),
        Some("msg:source"),
    )
    .expect("metadata builds");

    assert_eq!(
        combined["fork"]["forkedFromMessageAliases"],
        serde_json::json!(["msg:source", "entry:runtime-source"])
    );
    assert_eq!(combined["fork"]["snapshotMessageCount"], 6);
    assert_eq!(
        combined["fork"]["boundary"],
        "inherited-history-reference-only"
    );
}

#[test]
fn runtime_entry_alias_resolves_to_stable_canonical_message_id() {
    let conn = Connection::open_in_memory().expect("open db");
    conn.execute_batch(
        "CREATE TABLE session_messages(
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            content_json TEXT,
            sequence_num INTEGER NOT NULL,
            source_transport TEXT
         );",
    )
    .expect("schema");
    conn.execute(
        "INSERT INTO session_messages(id, session_id, content_json, sequence_num, source_transport)
         VALUES (?1, ?2, ?3, 1, 'desktop-chat')",
        rusqlite::params![
            "msg:canonical-agent",
            "session:self-agent",
            serde_json::json!({"desktopEntryId": "entry:runtime-agent"}).to_string(),
        ],
    )
    .expect("canonical message");

    assert_eq!(
        resolve_desktop_entry_to_canonical_message_id(
            &conn,
            "session:self-agent",
            "entry:runtime-agent",
        )
        .expect("resolve alias"),
        Some("msg:canonical-agent".to_string())
    );
}
