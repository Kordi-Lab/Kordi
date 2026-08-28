use super::*;

fn identity_request() -> UpsertCanonicalIdentityRequest {
    UpsertCanonicalIdentityRequest {
        id: Some("human:replay-user".to_string()),
        kind: "human".to_string(),
        display_name: "Replay user".to_string(),
        owner_identity_id: None,
        source: Some("cloud".to_string()),
        source_host_id: Some("cloud".to_string()),
        bridge_node_id: Some("cloud:replay-user".to_string()),
        human_id: Some("replay-user".to_string()),
        agent_id: None,
        avatar_key: Some("cloud:replay-user".to_string()),
        profile_image_url: Some("https://example.test/avatar.png".to_string()),
        metadata: Some(serde_json::json!({ "accountId": "replay-user" })),
    }
}

fn session_request() -> OpenCanonicalSessionRequest {
    OpenCanonicalSessionRequest {
        id: Some("session:group:replay".to_string()),
        kind: "group".to_string(),
        title: Some("main".to_string()),
        status: Some("active".to_string()),
        created_by_identity_id: "human:replay-user".to_string(),
        primary_identity_id: None,
        project_id: None,
        project_name: None,
        relationship_identity_id: None,
        participant_identity_ids: Vec::new(),
        metadata: Some(serde_json::json!({
            "groupId": "session:group:replay",
            "groupSpaceId": "session:group:replay",
            "sessionTitleSource": "manual",
            "sessionTitleRevision": 1,
            "sessionTitleUpdatedAtMs": 1
        })),
    }
}

fn message_request() -> AppendCanonicalMessageRequest {
    AppendCanonicalMessageRequest {
        id: Some("msg:cloud:replay".to_string()),
        session_id: "session:group:replay".to_string(),
        sender_identity_id: "human:replay-user".to_string(),
        sender_role: "user".to_string(),
        message_kind: "text".to_string(),
        content_text: "hello from replay".to_string(),
        content: Some(serde_json::json!({ "deliveryState": "complete" })),
        created_at_ms: Some(1_000),
        parent_message_id: None,
        delegated_exchange_id: None,
        status: Some("sent".to_string()),
        source_transport: Some("cloud-group".to_string()),
        source_event_id: Some("cloud-group:wire-replay".to_string()),
    }
}

fn terminal_agent_response_request() -> AppendCanonicalMessageRequest {
    AppendCanonicalMessageRequest {
        id: Some("msg:cloud-agent-processing:request:owner".to_string()),
        session_id: "session:group:replay".to_string(),
        sender_identity_id: "agent:cloud:owner".to_string(),
        sender_role: "external-agent".to_string(),
        message_kind: "agent-turn".to_string(),
        content_text: "finished".to_string(),
        content: Some(serde_json::json!({
            "deliveryState": "complete",
            "requestId": "request"
        })),
        created_at_ms: Some(2_000),
        parent_message_id: Some("request".to_string()),
        delegated_exchange_id: None,
        status: Some("received".to_string()),
        source_transport: Some("cloud-group-agent".to_string()),
        source_event_id: Some("cloud-group-agent:wire-response".to_string()),
    }
}

fn delayed_processing_fallback_request() -> AppendCanonicalMessageRequest {
    AppendCanonicalMessageRequest {
        id: Some("msg:cloud-agent-processing:request:owner".to_string()),
        session_id: "session:group:replay".to_string(),
        sender_identity_id: "agent:cloud:owner".to_string(),
        sender_role: "external-agent".to_string(),
        message_kind: "agent-turn".to_string(),
        content_text: "processing...".to_string(),
        content: Some(serde_json::json!({
            "deliveryState": "processing",
            "requestId": "request"
        })),
        created_at_ms: Some(3_000),
        parent_message_id: Some("request".to_string()),
        delegated_exchange_id: None,
        status: Some("processing".to_string()),
        source_transport: Some("cloud-group-agent-offline".to_string()),
        source_event_id: Some("cloud-group-agent-processing:request:owner".to_string()),
    }
}

fn seed_chat_sync_message(conn: &rusqlite::Connection, message_id: &str, sequence: i64) {
    conn.execute(
        "INSERT OR IGNORE INTO chat_sync_conversations(
             account_id, conversation_id, client_session_id, version,
             snapshot_json, updated_at_ms
         ) VALUES (
             'acct-replay', 'conversation-replay', 'session:group:replay', 1,
             '{\"legacy_session_id\":\"session:group:replay\"}', 1
         )",
        [],
    )
    .expect("seed reliable conversation");
    conn.execute(
        "INSERT INTO chat_sync_messages(
             account_id, message_id, conversation_id, conversation_sequence,
             version, snapshot_json, updated_at_ms
         ) VALUES ('acct-replay', ?1, 'conversation-replay', ?2, 1, '{}', ?2)",
        rusqlite::params![message_id, sequence],
    )
    .expect("seed reliable message sequence");
}

#[test]
fn identical_identity_replay_preserves_updated_timestamp() {
    let conn = test_conn();
    upsert_identity_in_db(&conn, identity_request()).expect("insert identity");
    conn.execute(
        "UPDATE identities SET updated_at_ms = 101 WHERE id = 'human:replay-user'",
        [],
    )
    .expect("set identity timestamp sentinel");

    let replayed = upsert_identity_in_db(&conn, identity_request()).expect("replay identity");

    assert_eq!(replayed.updated_at_ms, 101);
}

#[test]
fn identical_session_replay_preserves_updated_timestamp_and_title() {
    let conn = test_conn();
    upsert_identity_in_db(&conn, identity_request()).expect("insert identity");
    open_or_create_session_in_db(&conn, session_request()).expect("insert session");
    conn.execute(
        "UPDATE sessions SET updated_at_ms = 202 WHERE id = 'session:group:replay'",
        [],
    )
    .expect("set session timestamp sentinel");

    let replayed = open_or_create_session_in_db(&conn, session_request()).expect("replay session");

    assert_eq!(replayed.updated_at_ms, 202);
    assert_eq!(replayed.title, "main");
}

#[test]
fn identical_message_replay_preserves_message_and_session_timestamps() {
    let conn = test_conn();
    upsert_identity_in_db(&conn, identity_request()).expect("insert identity");
    open_or_create_session_in_db(&conn, session_request()).expect("insert session");
    upsert_message_in_db(&conn, message_request()).expect("insert message");
    conn.execute(
        "UPDATE session_messages SET updated_at_ms = 303 WHERE id = 'msg:cloud:replay'",
        [],
    )
    .expect("set message timestamp sentinel");
    conn.execute(
        "UPDATE sessions SET updated_at_ms = 404 WHERE id = 'session:group:replay'",
        [],
    )
    .expect("set session timestamp sentinel");

    let replayed = upsert_message_in_db(&conn, message_request()).expect("replay message");
    let session_updated_at_ms: i64 = conn
        .query_row(
            "SELECT updated_at_ms FROM sessions WHERE id = 'session:group:replay'",
            [],
            |row| row.get(0),
        )
        .expect("read session timestamp");

    assert_eq!(replayed.updated_at_ms, 303);
    assert_eq!(session_updated_at_ms, 404);
}

#[test]
fn cloud_replay_preserves_reliable_sequence_when_newest_page_arrives_first() {
    let conn = test_conn();
    upsert_identity_in_db(&conn, identity_request()).expect("insert identity");
    open_or_create_session_in_db(&conn, session_request()).expect("insert session");
    seed_chat_sync_message(&conn, "wire-latest", 20);
    seed_chat_sync_message(&conn, "wire-older", 5);

    let mut latest = message_request();
    latest.id = Some("msg:cloud:latest".to_string());
    latest.source_event_id = Some("cloud-group:wire-latest".to_string());
    latest.created_at_ms = Some(20_000);
    let mut older = message_request();
    older.id = Some("msg:cloud:older".to_string());
    older.source_transport = Some("cloud-self-agent".to_string());
    older.source_event_id = Some("wire-older".to_string());
    older.created_at_ms = Some(5_000);

    let latest = upsert_message_in_db(&conn, latest).expect("insert latest page");
    let older = upsert_message_in_db(&conn, older).expect("backfill older page");

    assert_eq!(latest.sequence_num, 20);
    assert_eq!(older.sequence_num, 5);
}

#[test]
fn versioned_message_replay_rejects_cross_session_movement() {
    let conn = test_conn();
    upsert_identity_in_db(&conn, identity_request()).expect("insert identity");
    open_or_create_session_in_db(&conn, session_request()).expect("insert source session");
    let mut target_session = session_request();
    target_session.id = Some("session:group:target".to_string());
    target_session.title = Some("target".to_string());
    open_or_create_session_in_db(&conn, target_session).expect("insert target session");

    let mut target_message = message_request();
    target_message.id = Some("msg:cloud:target-existing".to_string());
    target_message.session_id = "session:group:target".to_string();
    target_message.source_event_id = Some("cloud-group:target-existing".to_string());
    upsert_message_in_db(&conn, target_message).expect("insert target message");
    upsert_message_in_db(&conn, message_request()).expect("insert source message");

    let mut updated = message_request();
    updated.session_id = "session:group:target".to_string();
    updated.content_text = "updated replay".to_string();
    updated.source_event_id = Some("cloud-group:wire-replay:2".to_string());
    let error = upsert_message_in_db(&conn, updated).expect_err("reject message movement");
    let persisted = select_message(&conn, "msg:cloud:replay")
        .expect("read source message")
        .expect("source message remains");

    assert_eq!(error, "Canonical message session cannot change");
    assert_eq!(persisted.session_id, "session:group:replay");
    assert_eq!(persisted.content_text, "hello from replay");
}

#[test]
fn delayed_processing_fallback_does_not_regress_terminal_agent_response() {
    let conn = test_conn();
    upsert_identity_in_db(&conn, identity_request()).expect("insert identity");
    open_or_create_session_in_db(&conn, session_request()).expect("insert session");
    let terminal = upsert_message_in_db(&conn, terminal_agent_response_request())
        .expect("insert terminal response");

    let persisted = upsert_message_in_db(&conn, delayed_processing_fallback_request())
        .expect("ignore delayed processing fallback");

    assert_eq!(persisted.id, terminal.id);
    assert_eq!(persisted.content_text, "finished");
    assert_eq!(persisted.status, "received");
    assert_eq!(
        persisted.source_transport.as_deref(),
        Some("cloud-group-agent")
    );
    assert_eq!(
        persisted.source_event_id.as_deref(),
        Some("cloud-group-agent:wire-response")
    );
}

#[test]
fn durable_source_lookup_is_batched_normalized_and_deduplicated() {
    let conn = test_conn();
    upsert_identity_in_db(&conn, identity_request()).expect("insert identity");
    open_or_create_session_in_db(&conn, session_request()).expect("insert session");
    upsert_message_in_db(&conn, message_request()).expect("insert message");

    let existing = commands::existing_message_sources_from_db(
        &conn,
        vec![
            CanonicalMessageSourceRef {
                source_transport: " cloud-group ".to_string(),
                source_event_id: " cloud-group:wire-replay ".to_string(),
            },
            CanonicalMessageSourceRef {
                source_transport: "cloud-group".to_string(),
                source_event_id: "cloud-group:wire-replay".to_string(),
            },
            CanonicalMessageSourceRef {
                source_transport: "cloud-group".to_string(),
                source_event_id: "cloud-group:missing".to_string(),
            },
            CanonicalMessageSourceRef {
                source_transport: "".to_string(),
                source_event_id: "cloud-group:wire-replay".to_string(),
            },
        ],
    )
    .expect("query durable sources");

    assert_eq!(
        existing,
        vec![CanonicalMessageSourceRef {
            source_transport: "cloud-group".to_string(),
            source_event_id: "cloud-group:wire-replay".to_string(),
        }]
    );
}
