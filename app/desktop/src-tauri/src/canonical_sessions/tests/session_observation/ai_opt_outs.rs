//! A private assistant leaves out the messages of members who turned on
//! "Don't let AI use my messages" when it searches or reads the local cache.
use super::*;
use crate::canonical_sessions::session_observation::{read_session_as, search_sessions_as};

fn remember_conversation(conn: &Connection, account: &str, session_id: &str, excluded: &[&str]) {
    let snapshot = serde_json::json!({
        "id": format!("conversation-{account}"),
        "kind": "group",
        "legacy_session_id": session_id,
        "version": 2,
        "members": [],
        "ai_access": {
            "history_scope": "mentions",
            "pip": null,
            "excluded_member_ids": excluded,
            "viewer_excluded": excluded.contains(&account),
            "viewer_can_manage": false
        }
    });
    conn.execute(
        "INSERT INTO chat_sync_conversations(account_id,conversation_id,client_session_id,version,snapshot_json,updated_at_ms)
         VALUES(?1,?2,?3,2,?4,1)",
        params![account, format!("conversation-{account}"), session_id, snapshot.to_string()],
    )
    .unwrap();
}

fn append(conn: &Connection, session_id: &str, id: &str, sender: &str, text: &str) {
    append_message_in_db(
        conn,
        AppendCanonicalMessageRequest {
            id: Some(id.to_string()),
            session_id: session_id.to_string(),
            sender_identity_id: sender.to_string(),
            sender_role: "person".to_string(),
            message_kind: "text".to_string(),
            content_text: text.to_string(),
            content: None,
            created_at_ms: Some(1_800_000_000_100),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: None,
            source_event_id: None,
        },
    )
    .expect("append message");
}

fn search(conn: &Connection, viewer: &str, query: &str) -> Vec<String> {
    search_sessions_as(
        conn,
        SearchSessionsRequest {
            before_sequence: None,
            query: query.to_string(),
            limit: Some(8),
            include_messages: Some(true),
        },
        None,
        Some(viewer),
    )
    .unwrap()
    .sessions
    .into_iter()
    .flat_map(|session| session.snippets)
    .map(|snippet| snippet.message_id)
    .collect()
}

fn read_ids(
    conn: &Connection,
    session_id: &str,
    viewer: &str,
    ids: Option<Vec<String>>,
) -> Vec<String> {
    read_session_as(
        conn,
        ReadSessionRequest {
            before_sequence: None,
            attachment_id: None,
            expected_version: None,
            offset: None,
            session_id: session_id.to_string(),
            around_message_id: None,
            limit: Some(20),
            mode: Some(if ids.is_some() { "messages" } else { "index" }.to_string()),
            message_ids: ids,
        },
        Some(viewer),
    )
    .unwrap()
    .messages
    .into_iter()
    .map(|message| message.message_id)
    .collect()
}

#[test]
fn private_search_and_reads_leave_out_members_who_opted_out() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    seed_identity(&conn, "agent:bob-agent", "Bob's agent", "agent");
    append(
        &conn,
        &session_id,
        "msg:agent",
        "agent:bob-agent",
        "The canary agent summary",
    );
    remember_conversation(&conn, "alice", &session_id, &["bob"]);

    // Bob's own message is left out; his agent's reply is not.
    assert_eq!(search(&conn, "alice", "canary"), vec!["msg:agent"]);
    assert_eq!(
        read_ids(&conn, &session_id, "alice", None),
        vec!["msg:1", "msg:3", "msg:agent"]
    );
    assert_eq!(
        read_ids(
            &conn,
            &session_id,
            "alice",
            Some(vec!["msg:2".into(), "msg:3".into()])
        ),
        vec!["msg:3"]
    );
    // A session that only matches through a left-out message is not found.
    assert!(search(&conn, "alice", "deploy is ready").is_empty());
}

#[test]
fn a_member_who_left_with_the_setting_on_stays_left_out() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    // Bob left: the server lists him only among every account with the
    // setting on, not among the active members.
    remember_conversation(&conn, "alice", &session_id, &[]);
    conn.execute(
        "UPDATE chat_sync_conversations SET snapshot_json = json_set(snapshot_json, '$.ai_access.excluded_account_ids', json('[\"bob\"]'))",
        [],
    )
    .unwrap();
    assert!(search(&conn, "alice", "canary").is_empty());
    assert_eq!(
        read_ids(&conn, &session_id, "alice", None),
        vec!["msg:1", "msg:3"]
    );
    // Positive control: with no one listed, Bob's earlier message is found.
    conn.execute(
        "UPDATE chat_sync_conversations SET snapshot_json = json_set(snapshot_json, '$.ai_access.excluded_account_ids', json('[]'))",
        [],
    )
    .unwrap();
    assert_eq!(search(&conn, "alice", "canary"), vec!["msg:2"]);
}

#[test]
fn the_signed_in_member_still_sees_their_own_messages() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    remember_conversation(&conn, "bob", &session_id, &["bob"]);
    assert_eq!(search(&conn, "bob", "canary"), vec!["msg:2"]);
    assert_eq!(
        read_ids(&conn, &session_id, "bob", None),
        vec!["msg:1", "msg:2", "msg:3"]
    );
}

#[test]
fn unknown_authors_are_left_out_only_while_someone_opted_out() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    seed_identity(&conn, "human:unmatched", "Someone", "human");
    conn.execute(
        "UPDATE identities SET human_id = NULL WHERE id = 'human:unmatched'",
        [],
    )
    .unwrap();
    append(
        &conn,
        &session_id,
        "msg:unknown",
        "human:unmatched",
        "Canary from someone",
    );

    remember_conversation(&conn, "alice", &session_id, &[]);
    assert!(read_ids(&conn, &session_id, "alice", None).contains(&"msg:unknown".to_string()));
    assert!(search(&conn, "alice", "canary").contains(&"msg:unknown".to_string()));

    conn.execute(
        "UPDATE chat_sync_conversations SET snapshot_json = json_set(snapshot_json, '$.ai_access.excluded_member_ids', json('[\"carol\"]'))",
        [],
    )
    .unwrap();
    assert!(!read_ids(&conn, &session_id, "alice", None).contains(&"msg:unknown".to_string()));
    assert!(!search(&conn, "alice", "canary").contains(&"msg:unknown".to_string()));
    // Known members who did not opt out stay visible.
    assert!(search(&conn, "alice", "canary").contains(&"msg:2".to_string()));
}

#[test]
fn snapshots_from_servers_without_the_setting_change_nothing() {
    let conn = test_conn();
    let session_id = seed_session_with_messages(&conn);
    conn.execute(
        "INSERT INTO chat_sync_conversations(account_id,conversation_id,client_session_id,version,snapshot_json,updated_at_ms)
         VALUES('alice','legacy',?1,1,'{\"id\":\"legacy\",\"kind\":\"group\"}',1)",
        params![session_id],
    )
    .unwrap();
    assert_eq!(
        read_ids(&conn, &session_id, "alice", None),
        vec!["msg:1", "msg:2", "msg:3"]
    );
}
