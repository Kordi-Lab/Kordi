use std::{sync::mpsc, thread, time::Duration};

use super::*;

#[test]
fn source_event_dedupes_messages() {
    let conn = test_conn();
    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:test".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Test".to_string()),
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:local".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:local".to_string()],
            metadata: None,
        },
    )
    .expect("open session");
    let request = AppendCanonicalMessageRequest {
        id: None,
        session_id: session.id,
        sender_identity_id: "human:local".to_string(),
        sender_role: "user".to_string(),
        message_kind: "text".to_string(),
        content_text: "hello".to_string(),
        content: None,
        created_at_ms: None,
        parent_message_id: None,
        delegated_exchange_id: None,
        status: None,
        source_transport: Some("bridge".to_string()),
        source_event_id: Some("event-1".to_string()),
    };
    let first = append_message_in_db(&conn, request.clone()).expect("append first");
    let second = append_message_in_db(&conn, request).expect("append second");
    assert_eq!(first.id, second.id);

    let state = commands::load_state_from_db(&conn).expect("load state");
    assert_eq!(state.messages.len(), 1);
}

#[test]
fn source_event_upsert_reuses_the_existing_source_row_when_the_requested_id_differs() {
    let conn = test_conn();
    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:source-upsert".to_string()),
            kind: "group".to_string(),
            title: Some("Group".to_string()),
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: Vec::new(),
            metadata: None,
        },
    )
    .expect("open session");
    let existing = append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:cloud-event".to_string()),
            session_id: session.id.clone(),
            sender_identity_id: "human:local".to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "processing".to_string(),
            content: None,
            created_at_ms: Some(1_000),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("processing".to_string()),
            source_transport: Some("cloud-group".to_string()),
            source_event_id: Some("cloud-group:event-1".to_string()),
        },
    )
    .expect("append source row");

    let reconciled = upsert_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:different-stable-slot".to_string()),
            session_id: session.id,
            sender_identity_id: "human:local".to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "complete".to_string(),
            content: None,
            created_at_ms: Some(1_000),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("complete".to_string()),
            source_transport: Some("cloud-group".to_string()),
            source_event_id: Some("cloud-group:event-1".to_string()),
        },
    )
    .expect("reconcile source row");

    assert_eq!(reconciled.id, existing.id);
    assert_eq!(reconciled.content_text, "complete");
    assert_eq!(reconciled.status, "complete");
    let state = commands::load_state_from_db(&conn).expect("load state");
    assert_eq!(state.messages.len(), 1);
}

#[test]
fn concurrent_stable_message_upserts_lock_before_checking_for_the_row() {
    let db_path = std::env::temp_dir().join(format!(
        "kordi-canonical-concurrent-upsert-{}.sqlite3",
        Uuid::new_v4().simple()
    ));
    let conn = Connection::open(&db_path).expect("open first file-backed connection");
    conn.busy_timeout(Duration::from_secs(2))
        .expect("configure first busy timeout");
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;",
    )
    .expect("configure first connection");
    schema::initialize_schema(&conn).expect("initialize shared schema");
    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:concurrent-upsert".to_string()),
            kind: "group".to_string(),
            title: Some("Group".to_string()),
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: Vec::new(),
            metadata: None,
        },
    )
    .expect("open shared session");

    let second_conn = Connection::open(&db_path).expect("open second file-backed connection");
    second_conn
        .busy_timeout(Duration::from_secs(2))
        .expect("configure second busy timeout");
    second_conn
        .execute_batch("PRAGMA foreign_keys = ON;")
        .expect("configure second connection");

    let writer = rusqlite::Transaction::new_unchecked(&conn, TransactionBehavior::Immediate)
        .expect("begin first writer");
    append_message_in_db(
        &writer,
        AppendCanonicalMessageRequest {
            id: Some("msg:stable-processing-slot".to_string()),
            session_id: session.id.clone(),
            sender_identity_id: "human:local".to_string(),
            sender_role: "owned-agent".to_string(),
            message_kind: "agent-turn".to_string(),
            content_text: "processing...".to_string(),
            content: None,
            created_at_ms: Some(1_000),
            parent_message_id: Some("msg:request".to_string()),
            delegated_exchange_id: None,
            status: Some("processing".to_string()),
            source_transport: Some("cloud-group-agent".to_string()),
            source_event_id: Some("cloud-group-agent:local-processing".to_string()),
        },
    )
    .expect("insert uncommitted stable slot");

    let (started_tx, started_rx) = mpsc::channel();
    let session_id = session.id;
    let replay = thread::spawn(move || {
        started_tx.send(()).expect("signal replay start");
        upsert_message_in_db(
            &second_conn,
            AppendCanonicalMessageRequest {
                id: Some("msg:stable-processing-slot".to_string()),
                session_id,
                sender_identity_id: "human:local".to_string(),
                sender_role: "external-agent".to_string(),
                message_kind: "agent-turn".to_string(),
                content_text: "complete".to_string(),
                content: None,
                created_at_ms: Some(2_000),
                parent_message_id: Some("msg:request".to_string()),
                delegated_exchange_id: None,
                status: Some("complete".to_string()),
                source_transport: Some("cloud-group-agent".to_string()),
                source_event_id: Some("cloud-group-agent:replayed-response".to_string()),
            },
        )
    });

    started_rx.recv().expect("wait for replay writer");
    thread::sleep(Duration::from_millis(100));
    writer.commit().expect("commit first writer");

    let reconciled = replay
        .join()
        .expect("join replay writer")
        .expect("reconcile concurrent stable slot");
    assert_eq!(reconciled.id, "msg:stable-processing-slot");
    assert_eq!(reconciled.content_text, "complete");
    assert_eq!(reconciled.status, "complete");

    let state = commands::load_state_from_db(&conn).expect("load reconciled state");
    assert_eq!(
        state
            .messages
            .iter()
            .filter(|message| message.id == "msg:stable-processing-slot")
            .count(),
        1
    );

    drop(conn);
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(format!("{}-shm", db_path.display()));
    let _ = std::fs::remove_file(format!("{}-wal", db_path.display()));
}

#[test]
fn source_event_reconcile_noops_when_bridge_message_is_unchanged() {
    let conn = test_conn();
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:no-churn".to_string()),
            kind: "direct-person".to_string(),
            title: Some("Peer".to_string()),
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("human:peer".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:peer".to_string()),
            participant_identity_ids: vec!["human:peer".to_string()],
            metadata: None,
        },
    )
    .expect("open session");

    let request = AppendCanonicalMessageRequest {
        id: None,
        session_id: "session:no-churn".to_string(),
        sender_identity_id: "human:peer".to_string(),
        sender_role: "person".to_string(),
        message_kind: "text".to_string(),
        content_text: "@PeerKordi what are you doing".to_string(),
        content: Some(serde_json::json!({ "kind": "session-relay", "timeLabel": "14:11" })),
        created_at_ms: Some(1_000),
        parent_message_id: None,
        delegated_exchange_id: None,
        status: Some("sent".to_string()),
        source_transport: Some("desktop-bridge-session-relay".to_string()),
        source_event_id: Some("relay:message-1".to_string()),
    };

    let first = message_reconcile::append_or_reconcile_message_from_sync(
        &conn,
        request.clone(),
        "desktop-bridge-ui",
        5_000,
    )
    .expect("append relay");
    conn.execute(
        "UPDATE session_messages SET updated_at_ms = ?1 WHERE id = ?2",
        rusqlite::params![111_i64, first.id],
    )
    .expect("pin message updated_at");
    conn.execute(
        "UPDATE sessions SET updated_at_ms = ?1 WHERE id = ?2",
        rusqlite::params![222_i64, "session:no-churn"],
    )
    .expect("pin session updated_at");

    let second = message_reconcile::append_or_reconcile_message_from_sync(
        &conn,
        request,
        "desktop-bridge-ui",
        5_000,
    )
    .expect("reconcile unchanged relay");

    assert_eq!(second.id, first.id);
    let message_updated_at: i64 = conn
        .query_row(
            "SELECT updated_at_ms FROM session_messages WHERE id = ?1",
            rusqlite::params![second.id],
            |row| row.get(0),
        )
        .expect("message updated_at");
    let session_updated_at: i64 = conn
        .query_row(
            "SELECT updated_at_ms FROM sessions WHERE id = ?1",
            rusqlite::params!["session:no-churn"],
            |row| row.get(0),
        )
        .expect("session updated_at");
    assert_eq!(message_updated_at, 111);
    assert_eq!(session_updated_at, 222);
}

#[test]
fn source_event_reconcile_updates_streamed_agent_content() {
    let conn = test_conn();
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:stream".to_string()),
            kind: "direct-agent".to_string(),
            title: Some("Remote agent".to_string()),
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:remote".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:remote".to_string()],
            metadata: None,
        },
    )
    .expect("open session");

    let partial = AppendCanonicalMessageRequest {
        id: None,
        session_id: "session:stream".to_string(),
        sender_identity_id: "agent:remote".to_string(),
        sender_role: "external-agent".to_string(),
        message_kind: "agent-turn".to_string(),
        content_text: "hiu — what can".to_string(),
        content: Some(serde_json::json!({ "deliveryState": "processing" })),
        created_at_ms: Some(1_000),
        parent_message_id: None,
        delegated_exchange_id: None,
        status: Some("processing".to_string()),
        source_transport: Some("desktop-bridge".to_string()),
        source_event_id: Some("bridge:message-1".to_string()),
    };
    message_reconcile::append_or_reconcile_message_from_sync(
        &conn,
        partial,
        "desktop-bridge-ui",
        5_000,
    )
    .expect("append partial");

    message_reconcile::append_or_reconcile_message_from_sync(
        &conn,
        AppendCanonicalMessageRequest {
            id: None,
            session_id: "session:stream".to_string(),
            sender_identity_id: "agent:remote".to_string(),
            sender_role: "external-agent".to_string(),
            message_kind: "agent-turn".to_string(),
            content_text: "hiu — what can I help with?".to_string(),
            content: Some(serde_json::json!({ "deliveryState": "responded" })),
            created_at_ms: Some(1_100),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("responded".to_string()),
            source_transport: Some("desktop-bridge".to_string()),
            source_event_id: Some("bridge:message-1".to_string()),
        },
        "desktop-bridge-ui",
        5_000,
    )
    .expect("update final");

    let state = commands::load_state_from_db(&conn).expect("load state");
    assert_eq!(state.messages.len(), 1);
    assert_eq!(
        state.messages[0].content_text,
        "hiu — what can I help with?"
    );
    assert_eq!(state.messages[0].status, "responded");
}

#[test]
fn source_event_reconcile_keeps_distinct_same_transport_messages() {
    let conn = test_conn();
    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:same-transport-source-events".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Reconcile".to_string()),
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:local".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:local".to_string()],
            metadata: None,
        },
    )
    .expect("open session");

    for (id, source_event_id) in [
        ("msg:runtime-target", "desktop-chat:event-target"),
        ("msg:runtime-other", "desktop-chat:event-other"),
    ] {
        append_message_in_db(
            &conn,
            AppendCanonicalMessageRequest {
                id: Some(id.to_string()),
                session_id: session.id.clone(),
                sender_identity_id: "agent:local".to_string(),
                sender_role: "owned-agent".to_string(),
                message_kind: "text".to_string(),
                content_text: "same response".to_string(),
                content: Some(serde_json::json!({
                    "sender": "Kordi",
                    "timeLabel": "12:00",
                    "timestampMs": 1_000,
                })),
                created_at_ms: Some(1_000),
                parent_message_id: None,
                delegated_exchange_id: None,
                status: Some("sent".to_string()),
                source_transport: Some("desktop-chat".to_string()),
                source_event_id: Some(source_event_id.to_string()),
            },
        )
        .expect("append runtime message");
    }

    message_reconcile::append_or_reconcile_message_from_sync(
        &conn,
        AppendCanonicalMessageRequest {
            id: None,
            session_id: session.id.clone(),
            sender_identity_id: "agent:local".to_string(),
            sender_role: "owned-agent".to_string(),
            message_kind: "text".to_string(),
            content_text: "same response".to_string(),
            content: Some(serde_json::json!({
                "sender": "Kordi",
                "timeLabel": "12:00",
                "timestampMs": 1_000,
            })),
            created_at_ms: Some(1_000),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: Some("desktop-chat".to_string()),
            source_event_id: Some("desktop-chat:event-target".to_string()),
        },
        "desktop-chat",
        5_000,
    )
    .expect("reconcile exact source event");

    let source_events: Vec<String> = conn
        .prepare(
            "SELECT source_event_id
             FROM session_messages
             WHERE session_id = ?1
             ORDER BY sequence_num ASC",
        )
        .expect("prepare messages")
        .query_map(rusqlite::params![session.id], |row| row.get::<_, String>(0))
        .expect("query messages")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect messages");

    assert_eq!(
        source_events,
        vec![
            "desktop-chat:event-target".to_string(),
            "desktop-chat:event-other".to_string(),
        ]
    );
}

#[test]
fn synced_user_message_reconciles_stale_profile_optimistic_ui_message_after_bridge_activation() {
    let conn = test_conn();
    let stale_human_identity_id =
        local_profile_human_identity_id(&conn, "You").expect("fallback human identity");
    let active_human_identity_id = "human:kh_self";
    upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some(active_human_identity_id.to_string()),
            kind: "human".to_string(),
            display_name: "Test User".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: Some("bridge_host".to_string()),
            bridge_node_id: Some("kd_self".to_string()),
            human_id: Some("kh_self".to_string()),
            agent_id: None,
            avatar_key: Some("kh_self".to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("upsert active bridge human");
    update_local_profile_identities(
        &conn,
        Some(active_human_identity_id),
        None,
        Some("Test User"),
    )
    .expect("activate bridge human");
    let agent = seed_identity(&conn, "agent:local", "Kordi", "agent");
    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:reconcile-after-profile-activation".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Reconcile".to_string()),
            status: None,
            created_by_identity_id: active_human_identity_id.to_string(),
            primary_identity_id: Some(agent.id),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![],
            metadata: None,
        },
    )
    .expect("open session");

    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:ui:stale-profile".to_string()),
            session_id: session.id.clone(),
            sender_identity_id: stale_human_identity_id,
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "hello".to_string(),
            content: Some(serde_json::json!({
                "sender": "Me",
                "timeLabel": "12:00",
                "timestampMs": 1_000,
            })),
            created_at_ms: Some(1_000),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sending".to_string()),
            source_transport: Some("desktop-chat-ui".to_string()),
            source_event_id: Some(
                "desktop-chat-ui:session:reconcile-after-profile-activation:1000".to_string(),
            ),
        },
    )
    .expect("append stale optimistic message");

    let reconciled = message_reconcile::append_or_reconcile_message_from_sync(
        &conn,
        AppendCanonicalMessageRequest {
            id: None,
            session_id: session.id.clone(),
            sender_identity_id: active_human_identity_id.to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "hello".to_string(),
            content: Some(serde_json::json!({
                "sender": "You",
                "timeLabel": "12:00",
                "timestampMs": 1_001,
            })),
            created_at_ms: Some(1_001),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: Some("desktop-chat".to_string()),
            source_event_id: Some("desktop-chat:event-after-profile-activation".to_string()),
        },
        "desktop-chat-ui",
        5_000,
    )
    .expect("reconcile message");

    let messages: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT id, sender_identity_id, status
             FROM session_messages
             WHERE session_id = ?1
             ORDER BY sequence_num ASC",
        )
        .expect("prepare messages")
        .query_map(rusqlite::params![session.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .expect("query messages")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect messages");

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].0, "msg:ui:stale-profile");
    assert_eq!(messages[0].1, active_human_identity_id);
    assert_eq!(messages[0].2, "sent");
    assert_eq!(reconciled.id, "msg:ui:stale-profile");
}

#[test]
fn synced_user_message_removes_stale_profile_optimistic_duplicate_when_runtime_source_exists() {
    let conn = test_conn();
    let stale_human_identity_id =
        local_profile_human_identity_id(&conn, "You").expect("fallback human identity");
    let active_human_identity_id = "human:kh_self";
    upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some(active_human_identity_id.to_string()),
            kind: "human".to_string(),
            display_name: "Test User".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: Some("bridge_host".to_string()),
            bridge_node_id: Some("kd_self".to_string()),
            human_id: Some("kh_self".to_string()),
            agent_id: None,
            avatar_key: Some("kh_self".to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("upsert active bridge human");
    update_local_profile_identities(
        &conn,
        Some(active_human_identity_id),
        None,
        Some("Test User"),
    )
    .expect("activate bridge human");
    let agent = seed_identity(&conn, "agent:local", "Kordi", "agent");
    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:existing-runtime-source".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Reconcile".to_string()),
            status: None,
            created_by_identity_id: active_human_identity_id.to_string(),
            primary_identity_id: Some(agent.id),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![],
            metadata: None,
        },
    )
    .expect("open session");

    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:ui:stale-profile-existing".to_string()),
            session_id: session.id.clone(),
            sender_identity_id: stale_human_identity_id,
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "hello".to_string(),
            content: Some(serde_json::json!({
                "sender": "Me",
                "timeLabel": "12:00",
                "timestampMs": 1_000,
            })),
            created_at_ms: Some(1_000),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sending".to_string()),
            source_transport: Some("desktop-chat-ui".to_string()),
            source_event_id: Some(
                "desktop-chat-ui:session:existing-runtime-source:1000".to_string(),
            ),
        },
    )
    .expect("append stale optimistic message");
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:runtime-existing".to_string()),
            session_id: session.id.clone(),
            sender_identity_id: active_human_identity_id.to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "hello".to_string(),
            content: Some(serde_json::json!({
                "sender": "You",
                "timeLabel": "12:00",
                "timestampMs": 1_001,
            })),
            created_at_ms: Some(1_001),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: Some("desktop-chat".to_string()),
            source_event_id: Some("desktop-chat:event-existing".to_string()),
        },
    )
    .expect("append existing runtime source");

    let reconciled = message_reconcile::append_or_reconcile_message_from_sync(
        &conn,
        AppendCanonicalMessageRequest {
            id: None,
            session_id: session.id.clone(),
            sender_identity_id: active_human_identity_id.to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "hello".to_string(),
            content: Some(serde_json::json!({
                "sender": "You",
                "timeLabel": "12:00",
                "timestampMs": 1_001,
            })),
            created_at_ms: Some(1_001),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: Some("desktop-chat".to_string()),
            source_event_id: Some("desktop-chat:event-existing".to_string()),
        },
        "desktop-chat-ui",
        5_000,
    )
    .expect("reconcile existing runtime source");

    let messages: Vec<(String, String)> = conn
        .prepare(
            "SELECT id, status
             FROM session_messages
             WHERE session_id = ?1
             ORDER BY sequence_num ASC",
        )
        .expect("prepare messages")
        .query_map(rusqlite::params![session.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query messages")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect messages");

    assert_eq!(
        messages,
        vec![(
            "msg:ui:stale-profile-existing".to_string(),
            "sent".to_string()
        )]
    );
    assert_eq!(reconciled.id, "msg:ui:stale-profile-existing");
}

#[test]
fn synced_user_message_reconciles_optimistic_ui_message() {
    let conn = test_conn();
    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:reconcile".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Reconcile".to_string()),
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:local".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:local".to_string()],
            metadata: None,
        },
    )
    .expect("open session");

    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: None,
            session_id: session.id.clone(),
            sender_identity_id: "human:local".to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "hello".to_string(),
            content: Some(serde_json::json!({
                "sender": "You",
                "timeLabel": "12:00",
                "timestampMs": 1_000,
            })),
            created_at_ms: Some(1_000),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sending".to_string()),
            source_transport: Some("desktop-chat-ui".to_string()),
            source_event_id: Some("desktop-chat-ui:session:reconcile:1000".to_string()),
        },
    )
    .expect("append optimistic message");

    let reconciled = message_reconcile::append_or_reconcile_message_from_sync(
        &conn,
        AppendCanonicalMessageRequest {
            id: None,
            session_id: session.id,
            sender_identity_id: "human:local".to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "hello".to_string(),
            content: Some(serde_json::json!({
                "sender": "You",
                "timeLabel": "12:00",
                "timestampMs": 1_001,
            })),
            created_at_ms: Some(1_001),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: Some("desktop-chat".to_string()),
            source_event_id: Some("desktop-chat:event-1".to_string()),
        },
        "desktop-chat-ui",
        5_000,
    )
    .expect("reconcile message");

    let state = commands::load_state_from_db(&conn).expect("load state");
    assert_eq!(state.messages.len(), 1);
    assert_eq!(reconciled.status, "sent");
    assert_eq!(reconciled.source_transport.as_deref(), Some("desktop-chat"));
    assert_eq!(
        reconciled.source_event_id.as_deref(),
        Some("desktop-chat:event-1")
    );
}
