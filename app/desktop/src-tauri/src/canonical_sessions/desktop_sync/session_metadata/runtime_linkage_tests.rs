use chrono::Utc;
use kordi_core::types::{
    AgentMessage, AssistantContent, AssistantMessage, ContentBlock, EntryBase, EntryId,
    SessionEntry, StopReason, Usage, UserMessage,
};
use rusqlite::{params, Connection};

use super::{canonical_id_from_runtime_linkage, session_is_cloud_self_agent_in_db};

const SESSION: &str = "session:cloud-self";
const CWD: &str = "/tmp/kordi";
const REQUEST_ENTRY: &str = "01a16ff2-request";
const REPLY_ENTRY: &str = "236ffc48-reply";

fn canonical_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open canonical db");
    crate::canonical_sessions::schema::initialize_schema(&conn).expect("initialize schema");
    conn
}

fn insert_row(
    conn: &Connection,
    id: &str,
    sender_role: &str,
    sequence_num: i64,
    content: serde_json::Value,
    parent_message_id: Option<&str>,
) {
    conn.execute(
        "INSERT INTO session_messages(
             id, session_id, sender_identity_id, sender_role, message_kind, content_text,
             content_json, parent_message_id, status, sequence_num, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, 'text', 'text', ?5, ?6, 'sent', ?7, 1, 1)",
        params![
            id,
            SESSION,
            format!("identity:{sender_role}"),
            sender_role,
            content.to_string(),
            parent_message_id,
            sequence_num,
        ],
    )
    .expect("insert canonical row");
}

fn base(id: &str, parent_id: Option<&str>) -> EntryBase {
    EntryBase {
        id: EntryId(id.to_string()),
        parent_id: parent_id.map(|value| EntryId(value.to_string())),
        timestamp: Utc::now(),
    }
}

fn user(id: &str, parent_id: Option<&str>) -> SessionEntry {
    SessionEntry::Message {
        base: base(id, parent_id),
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "Plan the launch".to_string(),
            }],
            timestamp: 0,
        }),
    }
}

fn assistant(id: &str, parent_id: &str) -> SessionEntry {
    SessionEntry::Message {
        base: base(id, Some(parent_id)),
        message: AgentMessage::Assistant(AssistantMessage {
            content: vec![AssistantContent::Text {
                text: "Here is the plan".to_string(),
            }],
            provider: "test".to_string(),
            model: "test".to_string(),
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 0,
        }),
    }
}

/// user -> assistant (tool call) -> custom -> assistant (final reply)
fn runtime_entries() -> Vec<kordi_session::store::EntryRow> {
    let runtime = kordi_session::store::open_memory().expect("open runtime db");
    kordi_session::store::create_session_with_id(&runtime, SESSION, CWD).expect("session");
    let entries = [
        user(REQUEST_ENTRY, None),
        assistant("entry-tool-call", REQUEST_ENTRY),
        SessionEntry::Custom {
            base: base("entry-custom", Some("entry-tool-call")),
            custom_type: "tool_progress".to_string(),
            data: None,
        },
        assistant(REPLY_ENTRY, "entry-custom"),
    ];
    for entry in &entries {
        kordi_session::store::append_entry(&runtime, SESSION, entry).expect("append entry");
    }
    kordi_session::store::get_entries(&runtime, SESSION).expect("entries")
}

fn resolve(conn: &Connection, entry_id: &str) -> Option<String> {
    canonical_id_from_runtime_linkage(conn, SESSION, entry_id, &runtime_entries())
        .expect("resolve linkage")
}

#[test]
fn assistant_entry_resolves_to_the_cloud_response_row() {
    let conn = canonical_conn();
    insert_row(
        &conn,
        "msg:cloud:self:01a16ff2-request",
        "user",
        1,
        serde_json::json!({ "desktopEntryId": REQUEST_ENTRY }),
        None,
    );
    insert_row(
        &conn,
        "msg:cloud:self:response:01a16ff2-request",
        "owned-agent",
        2,
        serde_json::json!({ "cloudRequestMessageId": REQUEST_ENTRY }),
        None,
    );
    assert_eq!(
        resolve(&conn, REPLY_ENTRY).as_deref(),
        Some("msg:cloud:self:response:01a16ff2-request")
    );
}

#[test]
fn assistant_entry_resolves_through_the_cloud_request_id() {
    let conn = canonical_conn();
    insert_row(
        &conn,
        "msg:cloud:reply-older",
        "owned-agent",
        2,
        serde_json::json!({ "cloudRequestMessageId": REQUEST_ENTRY }),
        None,
    );
    insert_row(
        &conn,
        "msg:cloud:reply-latest",
        "owned-agent",
        3,
        serde_json::json!({ "cloudRequestMessageId": REQUEST_ENTRY }),
        None,
    );
    insert_row(
        &conn,
        "msg:cloud:user-echo",
        "user",
        4,
        serde_json::json!({ "cloudRequestMessageId": REQUEST_ENTRY }),
        None,
    );
    assert_eq!(
        resolve(&conn, REPLY_ENTRY).as_deref(),
        Some("msg:cloud:reply-latest")
    );
}

#[test]
fn assistant_entry_resolves_through_the_request_row_parent_link() {
    let conn = canonical_conn();
    insert_row(
        &conn,
        "msg:request",
        "user",
        1,
        serde_json::json!({ "desktopEntryId": REQUEST_ENTRY }),
        None,
    );
    insert_row(
        &conn,
        "msg:reply",
        "owned-agent",
        2,
        serde_json::json!({}),
        Some("msg:request"),
    );
    assert_eq!(resolve(&conn, REPLY_ENTRY).as_deref(), Some("msg:reply"));
}

#[test]
fn user_entry_resolves_to_the_cloud_request_row() {
    let conn = canonical_conn();
    insert_row(
        &conn,
        "msg:cloud:self:01a16ff2-request",
        "user",
        1,
        serde_json::json!({}),
        None,
    );
    assert_eq!(
        resolve(&conn, REQUEST_ENTRY).as_deref(),
        Some("msg:cloud:self:01a16ff2-request")
    );
}

#[test]
fn unknown_or_unlinked_entries_resolve_to_nothing() {
    let conn = canonical_conn();
    insert_row(
        &conn,
        "msg:cloud:self:response:01a16ff2-request",
        "owned-agent",
        1,
        serde_json::json!({}),
        None,
    );
    assert_eq!(resolve(&conn, "entry-missing"), None);
    assert_eq!(resolve(&conn, "entry-custom"), None);
    assert_eq!(resolve(&conn, REQUEST_ENTRY), None);
}

#[test]
fn cloud_self_agent_sessions_are_recognized() {
    let conn = canonical_conn();
    let sessions = [
        ("session:self", Some("agent:cloud-self:account"), None),
        ("session:owned", Some("agent:cloud-owned:agent-1"), None),
        (
            "session:flag",
            Some("agent:local:mac"),
            Some(r#"{"cloudSelfAgentSession":true}"#),
        ),
        (
            "session:agent-id",
            None,
            Some(r#"{"cloudAgentId":"agent-1"}"#),
        ),
        (
            "session:local",
            Some("agent:local:mac"),
            Some(r#"{"cloudSelfAgentSession":false,"cloudAgentId":"  "}"#),
        ),
    ];
    for (id, primary_identity_id, metadata) in sessions {
        conn.execute(
            "INSERT INTO sessions(id, kind, title, created_by_identity_id, primary_identity_id,
                                  metadata_json, created_at_ms, updated_at_ms)
             VALUES (?1, 'direct-agent', 'Chat', 'human:local', ?2, ?3, 1, 1)",
            params![id, primary_identity_id, metadata],
        )
        .expect("insert session");
    }
    for id in [
        "session:self",
        "session:owned",
        "session:flag",
        "session:agent-id",
    ] {
        assert!(
            session_is_cloud_self_agent_in_db(&conn, id).unwrap(),
            "{id}"
        );
    }
    assert!(!session_is_cloud_self_agent_in_db(&conn, "session:local").unwrap());
    assert!(!session_is_cloud_self_agent_in_db(&conn, "session:missing").unwrap());
}
