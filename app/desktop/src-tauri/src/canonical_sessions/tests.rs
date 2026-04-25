use rusqlite::Connection;

use super::*;

fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    schema::initialize_schema(&conn).expect("initialize schema");
    conn
}

#[test]
fn identity_uses_canonical_human_id_and_avatar_key() {
    let conn = test_conn();
    let identity = upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: None,
            kind: "human".to_string(),
            display_name: "Alice".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: Some("host-1".to_string()),
            bridge_node_id: Some("kd_alice".to_string()),
            human_id: Some("kh_alice".to_string()),
            agent_id: None,
            avatar_key: None,
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("upsert identity");

    assert_eq!(identity.id, "human:kh_alice");
    assert_eq!(identity.avatar_key, "kh_alice");
}

#[test]
fn open_session_is_deterministic_and_adds_participants() {
    let conn = test_conn();
    let request = OpenCanonicalSessionRequest {
        id: None,
        kind: "relationship".to_string(),
        title: Some("Alice".to_string()),
        status: None,
        created_by_identity_id: "human:local".to_string(),
        primary_identity_id: Some("human:kh_alice".to_string()),
        project_id: None,
        project_name: None,
        relationship_identity_id: Some("human:kh_alice".to_string()),
        participant_identity_ids: vec!["human:kh_alice".to_string(), "agent:ka_alice".to_string()],
        metadata: None,
    };
    let first = open_or_create_session_in_db(&conn, request.clone()).expect("open first");
    let second = open_or_create_session_in_db(&conn, request).expect("open second");
    assert_eq!(first.id, second.id);

    let state = commands::load_state_from_db(&conn).expect("load state");
    assert_eq!(state.sessions.len(), 1);
    assert_eq!(state.participants.len(), 3);
}

#[test]
fn default_session_title_uses_first_receiver_display_name() {
    let conn = test_conn();
    upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("human:bob".to_string()),
            kind: "human".to_string(),
            display_name: "Bob".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: None,
            bridge_node_id: None,
            human_id: None,
            agent_id: None,
            avatar_key: None,
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("upsert Bob");
    upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("agent:bob-kordi".to_string()),
            kind: "agent".to_string(),
            display_name: "Bob's Kordi".to_string(),
            owner_identity_id: Some("human:bob".to_string()),
            source: Some("bridge".to_string()),
            source_host_id: None,
            bridge_node_id: None,
            human_id: None,
            agent_id: None,
            avatar_key: None,
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("upsert Bob's Kordi");

    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: None,
            kind: "relationship".to_string(),
            title: None,
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("human:bob".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:bob".to_string()),
            participant_identity_ids: vec!["human:bob".to_string(), "agent:bob-kordi".to_string()],
            metadata: None,
        },
    )
    .expect("open session");

    assert_eq!(session.title, "Bob");
    assert!(session.id.starts_with("session:"));
}

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
fn outreach_context_snapshot_is_session_scoped() {
    let conn = test_conn();
    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:parent".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Parent".to_string()),
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:local".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:local".to_string(), "agent:remote".to_string()],
            metadata: None,
        },
    )
    .expect("open session");
    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some(session.id.clone()),
        parent_turn_id: None,
        parent_message_id: None,
        bridge_host_id: "host-1".to_string(),
        bridge_conversation_id: Some("bridge:host-1:remote".to_string()),
        target_node_id: "kd_remote".to_string(),
        target_human_id: Some("kh_remote".to_string()),
        target_agent_id: Some("ka_remote".to_string()),
        target_display_name: "Remote Kordi".to_string(),
        target_owner_name: Some("Remote".to_string()),
        target_runtime: Some("kordi".to_string()),
        request_text: "Can you check this?".to_string(),
        context_text: Some("Recent parent context".to_string()),
        context_policy: Some("recent-window".to_string()),
        project_id: Some("project-1".to_string()),
        project_name: Some("Project".to_string()),
        status: "awaitingReply".to_string(),
        created_at_ms: 1000,
        updated_at_ms: 1000,
        completed_at_ms: None,
        error: None,
    };

    store_outreach_context_snapshot(
        &conn,
        &session.id,
        "agent:local",
        "agent:remote",
        "delegation:test",
        &outreach,
        "recent-window",
    )
    .expect("store snapshot");

    let state = commands::load_state_from_db(&conn).expect("load state");
    assert_eq!(state.context_snapshots.len(), 1);
    let snapshot = &state.context_snapshots[0];
    assert_eq!(snapshot.session_id, "session:parent");
    assert_eq!(snapshot.agent_identity_id, "agent:local");
    assert_eq!(snapshot.provider, "desktop-bridge");
    assert_eq!(
        snapshot.summary_text.as_deref(),
        Some("Recent parent context")
    );
}

#[test]
fn blank_desktop_drafts_do_not_sync_into_canonical_sessions() {
    let blank_summary = kordi_cli::desktop_runtime::DesktopChatSessionSummary {
        id: "draft:local-chat".to_string(),
        title: "New session".to_string(),
        subtitle: String::new(),
        updated_at_label: "Draft".to_string(),
        message_count: 0,
        draft: true,
    };
    let blank_detail = kordi_cli::desktop_runtime::DesktopChatSessionDetail {
        id: "draft:local-chat".to_string(),
        title: "New session".to_string(),
        subtitle: String::new(),
        provider: "openai".to_string(),
        provider_label: "OpenAI".to_string(),
        model: "gpt-5".to_string(),
        model_label: "gpt-5".to_string(),
        thinking: "medium".to_string(),
        thinking_label: "Medium".to_string(),
        updated_at_label: "Draft".to_string(),
        message_count: 0,
        draft: true,
        cache_monitor_text: None,
        context_window_text: "0 / 0".to_string(),
        context_window_status: kordi_cli::desktop_runtime::DesktopChatContextWindowStatus {
            context_window: 0,
            used_tokens: None,
            used_percent: None,
            auto_compaction: false,
        },
        project: None,
        messages: Vec::new(),
    };

    assert!(!should_sync_desktop_chat_summary(&blank_summary));
    assert!(!should_sync_desktop_chat_detail(&blank_detail));
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
