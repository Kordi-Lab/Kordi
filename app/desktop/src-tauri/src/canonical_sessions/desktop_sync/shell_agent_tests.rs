//! A Kordi Cloud chat with one of the owner's named agents keeps that agent
//! when the local desktop shell syncs, so a reply that runs only on this Mac
//! (such as a background follow-up) is attributed to the same agent.

use super::super::models::OpenCanonicalSessionRequest;
use super::super::open_or_create_session_in_db;
use super::{desktop_session_agent_identity, shell_agent_identity};
use rusqlite::{params, Connection};

const HUMAN: &str = "human:acct_synthetic";
const CLOUD_AGENT: &str = "agent:cloud-self:acct_synthetic";
const OLD_DELEGATE: &str = "agent:local:old-workspace";
const DELEGATE: &str = "agent:local:current-workspace";

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    super::super::schema::initialize_schema(&conn).unwrap();
    for (id, kind, name) in [
        (HUMAN, "human", "Owner"),
        (CLOUD_AGENT, "agent", "Named agent"),
        (OLD_DELEGATE, "agent", "Kordi"),
        (DELEGATE, "agent", "Kordi"),
    ] {
        conn.execute(
            "INSERT INTO identities(id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, 'local', ?1, 1, 1)",
            params![id, kind, name],
        )
        .unwrap();
    }
    conn
}

fn upsert(conn: &Connection, primary: &str, participants: Vec<String>) {
    open_or_create_session_in_db(
        conn,
        OpenCanonicalSessionRequest {
            id: Some("session-synthetic".into()),
            kind: "self-agent".into(),
            title: Some("Disk review".into()),
            status: Some("active".into()),
            created_by_identity_id: HUMAN.into(),
            primary_identity_id: Some(primary.into()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: participants,
            metadata: Some(serde_json::json!({"source": "desktop-chat-detail"})),
        },
    )
    .unwrap();
}

fn delegates(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM session_participants WHERE session_id='session-synthetic' AND identity_id LIKE 'agent:local:%'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn a_cloud_agent_chat_keeps_its_agent_through_the_desktop_shell_sync() {
    let conn = conn();
    // The Cloud sync set the named agent; an earlier desktop sync had also
    // added this Mac's delegate as a participant.
    upsert(
        &conn,
        CLOUD_AGENT,
        vec![CLOUD_AGENT.into(), DELEGATE.into()],
    );

    let shell = shell_agent_identity(&conn, "session-synthetic", DELEGATE).unwrap();
    upsert(&conn, &shell, vec![shell.clone()]);

    assert_eq!(shell, CLOUD_AGENT);
    // Local replies are attributed to the session's agent, not the delegate.
    assert_eq!(
        desktop_session_agent_identity(&conn, "session-synthetic", DELEGATE).unwrap(),
        CLOUD_AGENT
    );
    assert_eq!(delegates(&conn), 0);
}

#[test]
fn a_plain_local_chat_follows_the_current_delegate() {
    let conn = conn();
    upsert(&conn, OLD_DELEGATE, vec![OLD_DELEGATE.into()]);

    let shell = shell_agent_identity(&conn, "session-synthetic", DELEGATE).unwrap();

    assert_eq!(shell, DELEGATE);
    assert_eq!(delegates(&conn), 1);
}

#[test]
fn a_new_session_starts_with_the_current_delegate() {
    let conn = conn();
    assert_eq!(
        shell_agent_identity(&conn, "session-missing", DELEGATE).unwrap(),
        DELEGATE
    );
}
