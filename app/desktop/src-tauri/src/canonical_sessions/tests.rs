use std::collections::HashSet;

use rusqlite::Connection;

use super::*;

fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    schema::initialize_schema(&conn).expect("initialize schema");
    conn
}

fn canonical_desktop_project_group_id(project_root: &str) -> Option<String> {
    let normalized = project_root.trim();
    if normalized.is_empty() {
        None
    } else {
        Some(format!("project:{normalized}"))
    }
}

fn seed_identity(conn: &Connection, id: &str, display_name: &str, kind: &str) -> CanonicalIdentity {
    upsert_identity_in_db(
        conn,
        UpsertCanonicalIdentityRequest {
            id: Some(id.to_string()),
            kind: kind.to_string(),
            display_name: display_name.to_string(),
            owner_identity_id: None,
            source: Some("local".to_string()),
            source_host_id: None,
            bridge_node_id: None,
            human_id: kind
                .eq_ignore_ascii_case("human")
                .then(|| id.trim_start_matches("human:").to_string()),
            agent_id: kind
                .eq_ignore_ascii_case("agent")
                .then(|| id.trim_start_matches("agent:").to_string()),
            avatar_key: Some(id.to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("seed identity")
}

#[test]
fn canonical_group_metadata_and_participant_role_mutations_are_stable() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:me", "Me", "human");
    let alice = seed_identity(&conn, "human:alice", "Alice", "human");
    let bob = seed_identity(&conn, "human:bob", "Bob", "human");
    let group = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:test".to_string()),
            kind: "group".to_string(),
            title: Some("Alice, Bob".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![alice.id.clone(), bob.id.clone()],
            metadata: Some(serde_json::json!({
                "adminIdentityIds": [creator.id.clone()],
                "customName": null,
            })),
        },
    )
    .expect("create group");
    let alice_initial_role: String = conn
        .query_row(
            "SELECT role FROM session_participants WHERE session_id = ?1 AND identity_id = ?2",
            rusqlite::params![group.id, alice.id],
            |row| row.get(0),
        )
        .expect("alice initial role");
    assert_eq!(alice_initial_role, "person");

    rename_session_in_db(&conn, &group.id, "Design crew").expect("rename");
    set_session_metadata_in_db(
        &conn,
        &group.id,
        serde_json::json!({
            "adminIdentityIds": [creator.id.clone(), alice.id.clone()],
            "customName": "Design crew",
        }),
    )
    .expect("metadata");
    set_session_participant_role_in_db(&conn, &group.id, &alice.id, "admin").expect("admin role");
    remove_session_participant_in_db(&conn, &group.id, &bob.id).expect("remove member");

    let selected = select_session(&conn, &group.id)
        .expect("select")
        .expect("session");
    assert_eq!(selected.id, "session:group:test");
    assert_eq!(selected.title, "Design crew");
    assert_eq!(selected.metadata.unwrap()["customName"], "Design crew");
    let bob_state: String = conn
        .query_row(
            "SELECT state FROM session_participants WHERE session_id = ?1 AND identity_id = ?2",
            rusqlite::params![group.id, bob.id],
            |row| row.get(0),
        )
        .expect("bob state");
    assert_eq!(bob_state, "left");
}

#[test]
fn canonical_group_role_mutation_rejects_last_admin_removal() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:me", "Me", "human");
    let alice = seed_identity(&conn, "human:alice", "Alice", "human");
    let group = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:admin".to_string()),
            kind: "group".to_string(),
            title: Some("Alice".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![alice.id.clone()],
            metadata: Some(serde_json::json!({ "adminIdentityIds": [creator.id.clone()] })),
        },
    )
    .expect("create group");

    let error = set_session_participant_role_in_db(&conn, &group.id, &creator.id, "person")
        .expect_err("last admin rejected");
    assert!(error.contains("at least one admin"));
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
fn local_agent_identity_uses_delegate_name_stable_agent_id_and_owner() {
    let conn = test_conn();
    let human_identity_id = local_profile_human_identity_id(&conn, "You").expect("human identity");
    let workspace_root = "/tmp/kordi/workspace";

    let agent_identity_id = local_agent_identity_id(
        &conn,
        &human_identity_id,
        "issue-63-agent-outreach",
        workspace_root,
    )
    .expect("local agent identity");
    let same_agent_identity_id = local_agent_identity_id(
        &conn,
        &human_identity_id,
        "renamed-runtime-label",
        workspace_root,
    )
    .expect("same local agent identity");

    assert_eq!(agent_identity_id, same_agent_identity_id);
    let identity = select_identity(&conn, &agent_identity_id)
        .expect("select identity")
        .expect("identity exists");
    assert_eq!(identity.display_name, "Kordi");
    assert_eq!(
        identity.owner_identity_id.as_deref(),
        Some(human_identity_id.as_str())
    );
    assert!(identity
        .agent_id
        .as_deref()
        .unwrap_or_default()
        .starts_with("local:"));
    assert_eq!(identity.avatar_key, identity.agent_id.clone().unwrap());
    assert_eq!(
        identity
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("delegateAgentName"))
            .and_then(|value| value.as_str()),
        Some("Kordi"),
    );
}

#[test]
fn direct_person_sessions_do_not_keep_auto_agent_participants() {
    let conn = test_conn();
    for (id, kind, display_name, owner) in [
        ("human:local", "human", "Local", None),
        ("human:remote", "human", "Remote", None),
        ("agent:local", "agent", "Kordi", Some("human:local")),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: kind.to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: owner.map(ToString::to_string),
                source: Some("local".to_string()),
                source_host_id: None,
                bridge_node_id: None,
                human_id: None,
                agent_id: (kind == "agent").then(|| "local:test-agent".to_string()),
                avatar_key: Some(id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("identity");
    }

    for session_id in ["session:no-agent", "session:mentioned-agent"] {
        open_or_create_session_in_db(
            &conn,
            OpenCanonicalSessionRequest {
                id: Some(session_id.to_string()),
                kind: "direct-person".to_string(),
                title: Some("Remote".to_string()),
                status: None,
                created_by_identity_id: "human:local".to_string(),
                primary_identity_id: Some("human:remote".to_string()),
                project_id: None,
                project_name: None,
                relationship_identity_id: Some("human:remote".to_string()),
                participant_identity_ids: vec![
                    "human:remote".to_string(),
                    "agent:local".to_string(),
                ],
                metadata: None,
            },
        )
        .expect("session");
    }

    create_delegated_exchange_in_db(
        &conn,
        CreateCanonicalDelegatedExchangeRequest {
            id: Some("delegation:test".to_string()),
            session_id: "session:mentioned-agent".to_string(),
            initiator_identity_id: "human:local".to_string(),
            target_identity_id: "agent:local".to_string(),
            trigger_message_id: None,
            request_message_id: None,
            response_message_id: None,
            transport: Some("bridge".to_string()),
            bridge_host_id: None,
            bridge_conversation_id: None,
            bridge_request_id: None,
            context_policy: None,
            status: None,
            error: None,
        },
    )
    .expect("delegation");

    cleanup_unmentioned_agent_participants(&conn, "session:no-agent").expect("cleanup no-agent");
    cleanup_unmentioned_agent_participants(&conn, "session:mentioned-agent")
        .expect("cleanup mentioned-agent");

    let no_agent_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE session_id = 'session:no-agent' AND identity_id = 'agent:local'",
            [],
            |row| row.get(0),
        )
        .expect("no-agent count");
    let mentioned_agent_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE session_id = 'session:mentioned-agent' AND identity_id = 'agent:local'",
            [],
            |row| row.get(0),
        )
        .expect("mentioned-agent count");

    assert_eq!(no_agent_count, 0);
    assert_eq!(mentioned_agent_count, 1);
}

#[test]
fn bridge_fallback_node_identity_can_be_reconciled_to_human_id() {
    let conn = test_conn();
    upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: None,
            kind: "human".to_string(),
            display_name: "Alice".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: Some("host-1".to_string()),
            bridge_node_id: Some("kd_alice".to_string()),
            human_id: None,
            agent_id: None,
            avatar_key: None,
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("upsert fallback identity");
    let human = upsert_identity_in_db(
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
            avatar_key: Some("kh_alice".to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("upsert canonical human identity");

    let resolved = bridge_human_identity_for_node(&conn, "host-1", "kd_alice")
        .expect("resolve peer human")
        .expect("human identity");
    assert_eq!(resolved.id, human.id);

    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:bridge:alice".to_string()),
            kind: "direct-person".to_string(),
            title: None,
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("human:bridge-node:kd_alice".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:bridge-node:kd_alice".to_string()),
            participant_identity_ids: vec!["human:bridge-node:kd_alice".to_string()],
            metadata: None,
        },
    )
    .expect("open fallback session");
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("message:1".to_string()),
            session_id: "session:bridge:alice".to_string(),
            sender_identity_id: "human:bridge-node:kd_alice".to_string(),
            sender_role: "person".to_string(),
            message_kind: "text".to_string(),
            content_text: "hello".to_string(),
            content: None,
            created_at_ms: Some(1),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: None,
            source_transport: None,
            source_event_id: None,
        },
    )
    .expect("append fallback message");

    cleanup_bridge_fallback_identity_for_session(
        &conn,
        "session:bridge:alice",
        "kd_alice",
        &human.id,
    )
    .expect("cleanup fallback identity");

    let state = commands::load_state_from_db(&conn).expect("load state");
    assert!(state
        .participants
        .iter()
        .all(|participant| participant.identity_id != "human:bridge-node:kd_alice"));
    assert_eq!(state.messages[0].sender_identity_id, human.id);
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
fn canonical_desktop_project_group_id_uses_project_prefix() {
    assert_eq!(
        canonical_desktop_project_group_id("/tmp/workspace").as_deref(),
        Some("project:/tmp/workspace")
    );
    assert_eq!(canonical_desktop_project_group_id("   "), None);
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
        parent_session_title: Some("Parent".to_string()),
        parent_session_kind: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        parent_turn_id: None,
        parent_message_id: None,
        bridge_host_id: "host-1".to_string(),
        bridge_conversation_id: Some("bridge:host-1:remote".to_string()),
        bridge_request_id: Some("bridge_req_test".to_string()),
        delivery_state: None,
        target_node_id: "kd_remote".to_string(),
        target_human_id: Some("kh_remote".to_string()),
        target_agent_id: Some("ka_remote".to_string()),
        target_display_name: "Remote Kordi".to_string(),
        target_owner_name: Some("Remote".to_string()),
        target_runtime: Some("kordi".to_string()),
        request_text: "Can you check this?".to_string(),
        trigger_text: Some("@Remote Kordi Can you check this?".to_string()),
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
fn active_desktop_chat_without_explicit_project_membership_stays_self_agent() {
    let state = crate::chat::DesktopChatState {
        cwd: "/tmp/workspace".to_string(),
        active_session_id: "session:local".to_string(),
        sessions: vec![kordi_cli::desktop_runtime::DesktopChatSessionSummary {
            id: "session:local".to_string(),
            title: "Plan backend refactor".to_string(),
            subtitle: "Plan backend refactor".to_string(),
            updated_at_label: "Now".to_string(),
            message_count: 1,
            draft: false,
        }],
        projects: Vec::new(),
        active_session: kordi_cli::desktop_runtime::DesktopChatSessionDetail {
            id: "session:local".to_string(),
            title: "Plan backend refactor".to_string(),
            subtitle: "Plan backend refactor".to_string(),
            provider: "openai".to_string(),
            provider_label: "OpenAI".to_string(),
            model: "gpt-5".to_string(),
            model_label: "gpt-5".to_string(),
            thinking: "medium".to_string(),
            thinking_label: "Medium".to_string(),
            thinking_levels: vec!["off".to_string(), "medium".to_string()],
            updated_at_label: "Now".to_string(),
            message_count: 1,
            draft: false,
            cache_monitor_text: None,
            context_window_text: "0 / 0".to_string(),
            context_window_status: kordi_cli::desktop_runtime::DesktopChatContextWindowStatus {
                context_window: 0,
                used_tokens: None,
                used_percent: None,
                auto_compaction: false,
                compaction_threshold_percent: 90,
            },
            project: Some(kordi_cli::desktop_runtime::DesktopChatProjectInfo {
                name: "src-tauri".to_string(),
                root: "/tmp/workspace/app/desktop/src-tauri".to_string(),
                shared_context: None,
                background_system: None,
                shared_sources: Vec::new(),
            }),
            messages: vec![kordi_cli::desktop_runtime::DesktopChatMessage {
                role: "user".to_string(),
                sender: Some("You".to_string()),
                text: "Plan backend refactor".to_string(),
                detail: None,
                time_label: "Now".to_string(),
                timestamp_ms: 1,
                thinking_text: None,
                tools: Vec::new(),
                attachments: Vec::new(),
                failed: false,
            }],
        },
        local_agent: kordi_cli::desktop_runtime::DesktopChatAgentProfile {
            label: "Kordi".to_string(),
            system_prompt: String::new(),
            loaded_skills: Vec::new(),
            loaded_tools: Vec::new(),
            loaded_plugins: Vec::new(),
            identity_files: Vec::new(),
            default_provider: "openai".to_string(),
            default_model: "gpt-5".to_string(),
            workspace_root: "/tmp/workspace".to_string(),
            last_activities: Vec::new(),
        },
        model_options: Vec::new(),
        slash_commands: Vec::new(),
    };

    assert_eq!(
        explicit_desktop_project_membership(&state, "session:local"),
        None
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
        thinking_levels: vec!["off".to_string(), "medium".to_string()],
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
            compaction_threshold_percent: 90,
        },
        project: None,
        messages: Vec::new(),
    };

    assert!(!should_sync_desktop_chat_summary(&blank_summary));
    assert!(!should_sync_desktop_chat_detail(&blank_detail));
}

#[test]
fn shared_bridge_local_agent_runtime_prompt_is_not_synced_as_extra_user_message() {
    let message = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "user".to_string(),
        sender: Some("You".to_string()),
        text: "@Kordi hi do a review".to_string(),
        detail: None,
        time_label: "Now".to_string(),
        timestamp_ms: 1,
        thinking_text: None,
        tools: Vec::new(),
        attachments: Vec::new(),
        failed: false,
    };

    assert!(should_skip_shared_local_agent_runtime_prompt(
        "session:bridge:humans:test",
        &message,
    ));
    assert!(!should_skip_shared_local_agent_runtime_prompt(
        "session:local:test",
        &message,
    ));

    let normal_message = kordi_cli::desktop_runtime::DesktopChatMessage {
        text: "hello".to_string(),
        ..message
    };
    assert!(!should_skip_shared_local_agent_runtime_prompt(
        "session:bridge:humans:test",
        &normal_message,
    ));
}

#[test]
fn desktop_sync_enriches_similar_bridge_agent_message_with_local_runtime_details() {
    let conn = test_conn();
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:bridge-final".to_string()),
            session_id: "session:bridge:humans:test".to_string(),
            sender_identity_id: "agent:local".to_string(),
            sender_role: "owned-agent".to_string(),
            message_kind: "agent-turn".to_string(),
            content_text: "Final answer".to_string(),
            content: Some(serde_json::json!({
                "sender": "My Kordi",
                "timeLabel": "10:57",
                "thinkingText": null,
                "tools": [],
            })),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("complete".to_string()),
            source_transport: Some("desktop-bridge-session-relay".to_string()),
            source_event_id: Some("bridge-response-1".to_string()),
            created_at_ms: Some(1_000),
        },
    )
    .expect("seed bridge response");

    let desktop_message = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("My Kordi".to_string()),
        text: "Final answer".to_string(),
        detail: None,
        time_label: "10:57".to_string(),
        timestamp_ms: 1_100,
        thinking_text: Some("local reasoning trace".to_string()),
        tools: vec![kordi_cli::desktop_runtime::DesktopChatStoredTool {
            id: "tool-1".to_string(),
            name: "read".to_string(),
            status: "complete".to_string(),
            arguments: "{}".to_string(),
            live_output: String::new(),
            result_text: Some("file contents".to_string()),
            detail: None,
            is_error: false,
        }],
        attachments: Vec::new(),
        failed: false,
    };

    assert!(enrich_similar_bridge_agent_message_with_desktop_runtime(
        &conn,
        "session:bridge:humans:test",
        "Final answer",
        1_100,
        30_000,
        &desktop_message,
    )
    .expect("enrich bridge response"));

    let (thinking, tool_count): (String, i64) = conn
        .query_row(
            "SELECT json_extract(content_json, '$.thinkingText'),
                    json_array_length(json_extract(content_json, '$.tools'))
             FROM session_messages
             WHERE id = 'msg:bridge-final'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read enriched response");

    assert_eq!(thinking, "local reasoning trace");
    assert_eq!(tool_count, 1);
}

#[test]
fn desktop_sync_enriches_bridge_agent_message_when_relay_collapses_whitespace() {
    let conn = test_conn();
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:bridge-final".to_string()),
            session_id: "session:bridge:humans:test".to_string(),
            sender_identity_id: "agent:local".to_string(),
            sender_role: "owned-agent".to_string(),
            message_kind: "agent-turn".to_string(),
            content_text: "I’ll check current web weather info for Thuwal today and summarize it.Today in **Thuwal, Saudi Arabia**:\n\n- **Current temperature:** about **29°C**".to_string(),
            content: Some(serde_json::json!({
                "sender": "My Kordi",
                "timeLabel": "13:37",
                "thinkingText": null,
                "tools": [],
            })),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("complete".to_string()),
            source_transport: Some("desktop-bridge-session-relay".to_string()),
            source_event_id: Some("bridge-response-1".to_string()),
            created_at_ms: Some(1_000),
        },
    )
    .expect("seed bridge response");

    let desktop_message = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("My Kordi".to_string()),
        text: "I’ll check current web weather info for Thuwal today and summarize it.\n\nToday in **Thuwal, Saudi Arabia**:\n\n- **Current temperature:** about **29°C**".to_string(),
        detail: None,
        time_label: "13:37".to_string(),
        timestamp_ms: 1_100,
        thinking_text: Some("local reasoning trace".to_string()),
        tools: vec![kordi_cli::desktop_runtime::DesktopChatStoredTool {
            id: "tool-1".to_string(),
            name: "web_fetch".to_string(),
            status: "complete".to_string(),
            arguments: "{}".to_string(),
            live_output: String::new(),
            result_text: Some("weather".to_string()),
            detail: None,
            is_error: false,
        }],
        attachments: Vec::new(),
        failed: false,
    };

    assert!(enrich_similar_bridge_agent_message_with_desktop_runtime(
        &conn,
        "session:bridge:humans:test",
        &desktop_message.text,
        1_100,
        30_000,
        &desktop_message,
    )
    .expect("enrich whitespace-collapsed bridge response"));

    let (content_text, thinking, tool_count): (String, String, i64) = conn
        .query_row(
            "SELECT content_text,
                    json_extract(content_json, '$.thinkingText'),
                    json_array_length(json_extract(content_json, '$.tools'))
             FROM session_messages
             WHERE id = 'msg:bridge-final'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read enriched response");

    assert_eq!(content_text, desktop_message.text);
    assert_eq!(thinking, "local reasoning trace");
    assert_eq!(tool_count, 1);
}

#[test]
fn desktop_sync_replaces_processing_bridge_agent_placeholder_with_local_runtime_details() {
    let conn = test_conn();
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:processing-placeholder".to_string()),
            session_id: "session:bridge:humans:test".to_string(),
            sender_identity_id: "agent:local".to_string(),
            sender_role: "owned-agent".to_string(),
            message_kind: "agent-turn".to_string(),
            content_text: "processing...".to_string(),
            content: Some(serde_json::json!({
                "kind": "session-relay",
                "sender": "My Kordi",
                "timeLabel": "11:24",
                "deliveryState": "processing",
            })),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("processing".to_string()),
            source_transport: Some("desktop-bridge-session-relay".to_string()),
            source_event_id: Some("bridge-processing-1".to_string()),
            created_at_ms: Some(1_000),
        },
    )
    .expect("seed processing placeholder");

    let desktop_message = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("My Kordi".to_string()),
        text: "Final local answer".to_string(),
        detail: None,
        time_label: "11:24".to_string(),
        timestamp_ms: 10_000,
        thinking_text: Some("private reasoning".to_string()),
        tools: vec![kordi_cli::desktop_runtime::DesktopChatStoredTool {
            id: "tool-1".to_string(),
            name: "web_fetch".to_string(),
            status: "complete".to_string(),
            arguments: "{}".to_string(),
            live_output: String::new(),
            result_text: Some("repo page".to_string()),
            detail: None,
            is_error: false,
        }],
        attachments: Vec::new(),
        failed: false,
    };

    assert!(
        reconcile_processing_bridge_agent_placeholder_with_desktop_runtime(
            &conn,
            "session:bridge:humans:test",
            "Final local answer",
            10_000,
            30_000,
            &desktop_message,
        )
        .expect("replace processing placeholder")
    );

    let (content_text, status, delivery_state, thinking, tool_count): (
        String,
        String,
        Option<String>,
        String,
        i64,
    ) = conn
        .query_row(
            "SELECT content_text,
                    status,
                    json_extract(content_json, '$.deliveryState'),
                    json_extract(content_json, '$.thinkingText'),
                    json_array_length(json_extract(content_json, '$.tools'))
             FROM session_messages
             WHERE id = 'msg:processing-placeholder'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("read reconciled placeholder");

    assert_eq!(content_text, "Final local answer");
    assert_eq!(status, "complete");
    assert_eq!(delivery_state, None);
    assert_eq!(thinking, "private reasoning");
    assert_eq!(tool_count, 1);
}

#[test]
fn message_scoped_outreach_groups_include_same_request_response_without_message_outreach() {
    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some("session:bridge:humans:test".to_string()),
        parent_session_title: Some("hello".to_string()),
        parent_session_kind: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        parent_turn_id: None,
        parent_message_id: Some("msg:ui:request".to_string()),
        bridge_host_id: "bridge-local".to_string(),
        bridge_conversation_id: Some("bridge:local:remote".to_string()),
        bridge_request_id: Some("bridge_req_weather".to_string()),
        delivery_state: None,
        target_node_id: "kd_remote".to_string(),
        target_human_id: Some("kh_remote".to_string()),
        target_agent_id: Some("ka_remote".to_string()),
        target_display_name: "user b's Kordi".to_string(),
        target_owner_name: Some("user b".to_string()),
        target_runtime: Some("kordi-desktop".to_string()),
        request_text: "what is the jeddah weather".to_string(),
        trigger_text: Some("@user b's Kordi what is the jeddah weather".to_string()),
        context_text: None,
        context_policy: Some("parent-session".to_string()),
        project_id: None,
        project_name: None,
        status: "processing".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        completed_at_ms: None,
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:local:remote".to_string(),
        canonical_session_id: "session:bridge:humans:test".to_string(),
        host_id: "bridge-local".to_string(),
        peer_node_id: "kd_remote".to_string(),
        peer_display_name: Some("user b's Kordi".to_string()),
        peer_owner_name: Some("user b".to_string()),
        peer_runtime: "kordi-desktop".to_string(),
        project_id: None,
        project_name: None,
        title: "user b's Kordi".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 2_000,
        updated_at_label: "Now".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: Some(outreach.clone()),
        identity: None,
        messages: vec![
            crate::bridge::DesktopBridgeConversationMessage {
                id: "msg-request".to_string(),
                direction: "outbound".to_string(),
                sender: Some("User A".to_string()),
                text: "what is the jeddah weather".to_string(),
                time_label: "20:48".to_string(),
                timestamp_ms: 1_000,
                request_id: Some("bridge_req_weather".to_string()),
                delivery_state: Some("responded".to_string()),
                outreach: Some(outreach),
                attachments: Vec::new(),
            },
            crate::bridge::DesktopBridgeConversationMessage {
                id: "msg-response".to_string(),
                direction: "inbound-response".to_string(),
                sender: Some("user b's Kordi".to_string()),
                text: "Jeddah right now is partly cloudy.".to_string(),
                time_label: "20:49".to_string(),
                timestamp_ms: 2_000,
                request_id: Some("bridge_req_weather".to_string()),
                delivery_state: Some("responded".to_string()),
                outreach: None,
                attachments: Vec::new(),
            },
        ],
    };

    let groups = message_scoped_outreach_groups(&conversation);

    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].1.len(), 2);
    assert!(groups[0]
        .1
        .iter()
        .any(|message| message.id == "msg-response"));

    let handled = groups[0]
        .1
        .iter()
        .map(|message| message.id.clone())
        .collect::<HashSet<_>>();
    assert!(!bridge_conversation_has_unrouted_direct_messages(
        &conversation,
        &handled
    ));

    let mut conversation_with_direct_message = conversation.clone();
    conversation_with_direct_message.messages.push(
        crate::bridge::DesktopBridgeConversationMessage {
            id: "msg-direct".to_string(),
            direction: "inbound".to_string(),
            sender: Some("user b".to_string()),
            text: "plain direct message".to_string(),
            time_label: "20:50".to_string(),
            timestamp_ms: 3_000,
            request_id: None,
            delivery_state: None,
            outreach: None,
            attachments: Vec::new(),
        },
    );
    assert!(bridge_conversation_has_unrouted_direct_messages(
        &conversation_with_direct_message,
        &handled
    ));
}

#[test]
fn direct_person_bridge_conversation_uses_first_message_title_without_renaming_participants() {
    let storage_root = std::env::temp_dir().join(format!(
        "kordi-direct-person-title-test-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::env::set_var("KORDI_STORAGE_ROOT", &storage_root);

    let session_id = "session:bridge:humans:stable-pair";
    let first_message_outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(session_id.to_string()),
        parent_session_title: None,
        parent_session_kind: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        parent_turn_id: None,
        parent_message_id: Some("msg:first".to_string()),
        bridge_host_id: "bridge-shenzhe".to_string(),
        bridge_conversation_id: Some("bridge:shenzhe:shuyang:person".to_string()),
        bridge_request_id: Some("bridge_req_first".to_string()),
        delivery_state: None,
        target_node_id: "kd_shuyang".to_string(),
        target_human_id: Some("kh_shuyang".to_string()),
        target_agent_id: None,
        target_display_name: "Shuyang".to_string(),
        target_owner_name: Some("Shuyang".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "hi shu, are you here?".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-message".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        completed_at_ms: Some(1_000),
        error: None,
    };
    let state = crate::bridge::DesktopBridgeState {
        config_path: String::new(),
        legacy_config_path: String::new(),
        conversations_path: String::new(),
        active_host_id: Some("bridge-shenzhe".to_string()),
        hosts: vec![crate::bridge::DesktopBridgeHost {
            id: "bridge-shenzhe".to_string(),
            registered: true,
            connected: true,
            server_url: "https://bridge.example.test".to_string(),
            node_id: Some("kd_shenzhe".to_string()),
            display_name: "Shenzhe's Kordi".to_string(),
            owner_name: "Shenzhe".to_string(),
            endpoint: "https://bridge.example.test/kd_shenzhe".to_string(),
            token_present: true,
            human_id: "kh_shenzhe".to_string(),
            discovery_mode: "open".to_string(),
            active_agent_id: None,
            agents: Vec::new(),
            visible_peers: vec![crate::bridge::DesktopBridgePeer {
                node_id: "kd_shuyang".to_string(),
                display_name: Some("Shuyang".to_string()),
                runtime: "person".to_string(),
                endpoint: "https://bridge.example.test/kd_shuyang".to_string(),
                owner_name: Some("Shuyang".to_string()),
                created_at: None,
                shared_projects: Vec::new(),
                human_id: Some("kh_shuyang".to_string()),
                agent_id: None,
                is_default_agent: false,
                discovery_mode: Some("open".to_string()),
            }],
            visible_peer_count: 1,
            projects: Vec::new(),
            last_error: None,
        }],
        conversations: vec![crate::bridge::DesktopBridgeConversation {
            id: "bridge:shenzhe:shuyang:person".to_string(),
            canonical_session_id: session_id.to_string(),
            host_id: "bridge-shenzhe".to_string(),
            peer_node_id: "kd_shuyang".to_string(),
            peer_display_name: Some("Shuyang".to_string()),
            peer_owner_name: Some("Shuyang".to_string()),
            peer_runtime: "person".to_string(),
            project_id: None,
            project_name: None,
            title: "Shuyang".to_string(),
            subtitle: String::new(),
            unread_count: 0,
            updated_at_ms: 2_000,
            updated_at_label: "13:47".to_string(),
            awaiting_reply: false,
            peer_typing: false,
            peer_last_heartbeat_label: None,
            outreach: None,
            identity: None,
            messages: vec![
                crate::bridge::DesktopBridgeConversationMessage {
                    id: "msg-first".to_string(),
                    direction: "outbound".to_string(),
                    sender: Some("Shenzhe".to_string()),
                    text: "hi shu, are you here?".to_string(),
                    time_label: "13:27".to_string(),
                    timestamp_ms: 1_000,
                    request_id: Some("bridge_req_first".to_string()),
                    delivery_state: None,
                    outreach: Some(first_message_outreach),
                    attachments: Vec::new(),
                },
                crate::bridge::DesktopBridgeConversationMessage {
                    id: "msg-reply".to_string(),
                    direction: "inbound".to_string(),
                    sender: Some("Shuyang".to_string()),
                    text: "i am good".to_string(),
                    time_label: "13:47".to_string(),
                    timestamp_ms: 2_000,
                    request_id: None,
                    delivery_state: None,
                    outreach: None,
                    attachments: Vec::new(),
                },
            ],
        }],
        local_server: crate::bridge::DesktopBridgeLocalServerStatus::default(),
        local_agent_routing: crate::bridge::DesktopBridgeAgentRouting::default(),
    };

    sync_bridge_state_identities(&state).expect("sync identities");
    let conn = open_db().expect("open db before sync");
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(session_id.to_string()),
            kind: "direct-person".to_string(),
            title: Some("i am good".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:kh_shenzhe".to_string(),
            primary_identity_id: Some("human:kh_shuyang".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:kh_shuyang".to_string()),
            participant_identity_ids: vec!["human:kh_shuyang".to_string()],
            metadata: Some(serde_json::json!({
                "source": "bridge-session-thread",
            })),
        },
    )
    .expect("seed stale later-message title");
    drop(conn);

    sync_bridge_state_sessions(&state).expect("sync sessions");

    let conn = open_db().expect("open db");
    let session = select_session(&conn, session_id)
        .expect("select session")
        .expect("session exists");
    assert_eq!(session.kind, "direct-person");
    assert_eq!(session.title, "hi shu, are you here?");
    assert_eq!(
        identity_display_name(&conn, "human:kh_shenzhe").expect("local identity"),
        Some("Shenzhe".to_string()),
    );
    assert_eq!(
        identity_display_name(&conn, "human:kh_shuyang").expect("remote identity"),
        Some("Shuyang".to_string()),
    );

    std::env::remove_var("KORDI_STORAGE_ROOT");
    let _ = std::fs::remove_dir_all(storage_root);
}

#[test]
fn inbound_session_message_creates_direct_person_parent_with_first_message_title() {
    let conn = test_conn();
    for (id, display_name, human_id, node_id) in [
        ("human:local-shuyang", "Shuyang", "kh_shuyang", "kd_shuyang"),
        (
            "human:remote-shenzhe",
            "Shenzhe",
            "kh_shenzhe",
            "kd_shenzhe",
        ),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: "human".to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: Some(node_id.to_string()),
                human_id: Some(human_id.to_string()),
                agent_id: None,
                avatar_key: Some(human_id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let parent_session_id = "session:bridge:humans:stable-pair";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "direct-person".to_string(),
            title: Some("Shenzhe".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local-shuyang".to_string(),
            primary_identity_id: Some("human:remote-shenzhe".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:remote-shenzhe".to_string()),
            participant_identity_ids: vec!["human:remote-shenzhe".to_string()],
            metadata: Some(serde_json::json!({
                "source": "desktop-bridge-conversation",
            })),
        },
    )
    .expect("open existing peer-named session");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: None,
        parent_session_kind: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        parent_turn_id: None,
        parent_message_id: Some("msg:sender-ui".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:remote:person".to_string()),
        bridge_request_id: Some("bridge_req_direct".to_string()),
        delivery_state: None,
        target_node_id: "kd_shuyang".to_string(),
        target_human_id: Some("kh_shuyang".to_string()),
        target_agent_id: None,
        target_display_name: "Shuyang".to_string(),
        target_owner_name: Some("Shuyang".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "hi shu, are you here?".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-message".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        completed_at_ms: Some(1_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:remote:person".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_shenzhe".to_string(),
        peer_display_name: Some("Shenzhe".to_string()),
        peer_owner_name: Some("Shenzhe".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Shenzhe".to_string(),
        subtitle: String::new(),
        unread_count: 1,
        updated_at_ms: 1_001,
        updated_at_label: "13:27".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_inbound".to_string(),
        direction: "inbound".to_string(),
        sender: Some("Shenzhe".to_string()),
        text: "hi shu, are you here?".to_string(),
        time_label: "13:27".to_string(),
        timestamp_ms: 1_001,
        request_id: Some("bridge_req_direct".to_string()),
        delivery_state: None,
        outreach: Some(outreach.clone()),
        attachments: Vec::new(),
    }];

    sync_bridge_outreach_into_parent_session(
        &conn,
        &conversation,
        &messages,
        &outreach,
        "human:local-shuyang",
        None,
        Some("human:remote-shenzhe"),
        "human:remote-shenzhe",
        false,
    )
    .expect("sync inbound session message");

    let session = select_session(&conn, parent_session_id)
        .expect("select session")
        .expect("session exists");
    assert_eq!(session.kind, "direct-person");
    assert_eq!(session.title, "hi shu, are you here?");
    assert_eq!(
        session.primary_identity_id.as_deref(),
        Some("human:remote-shenzhe"),
    );
    assert_eq!(
        session.relationship_identity_id.as_deref(),
        Some("human:remote-shenzhe"),
    );
    assert_eq!(
        session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("source"))
            .and_then(|value| value.as_str()),
        Some("desktop-bridge-conversation"),
    );
    assert_eq!(
        identity_display_name(&conn, "human:local-shuyang").expect("local identity"),
        Some("Shuyang".to_string()),
    );
    assert_eq!(
        identity_display_name(&conn, "human:remote-shenzhe").expect("remote identity"),
        Some("Shenzhe".to_string()),
    );
}

#[test]
fn inbound_group_session_message_reconstructs_group_parent_and_members() {
    let conn = test_conn();
    for (id, display_name, human_id, node_id) in [
        ("human:local-alice", "Alice", "kh_alice", "kd_alice"),
        ("human:remote-bob", "Bob", "kh_bob", "kd_bob"),
        ("human:carol", "Carol", "kh_carol", "kd_carol"),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: "human".to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: Some(node_id.to_string()),
                human_id: Some(human_id.to_string()),
                agent_id: None,
                avatar_key: Some(human_id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let parent_session_id = "session:group:triad";
    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Alice, Bob, Carol".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_session_participants: vec![
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:local-alice".to_string()),
                display_name: "Alice".to_string(),
                role: Some("self".to_string()),
                bridge_node_id: Some("kd_alice".to_string()),
                human_id: Some("kh_alice".to_string()),
                agent_id: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:remote-bob".to_string()),
                display_name: "Bob".to_string(),
                role: Some("person".to_string()),
                bridge_node_id: Some("kd_bob".to_string()),
                human_id: Some("kh_bob".to_string()),
                agent_id: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:carol".to_string()),
                display_name: "Carol".to_string(),
                role: Some("person".to_string()),
                bridge_node_id: Some("kd_carol".to_string()),
                human_id: Some("kh_carol".to_string()),
                agent_id: None,
            },
        ],
        parent_session_messages: Vec::new(),
        parent_turn_id: None,
        parent_message_id: Some("msg:group-parent".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:bob:person".to_string()),
        bridge_request_id: Some("bridge_req_group".to_string()),
        delivery_state: None,
        target_node_id: "kd_alice".to_string(),
        target_human_id: Some("kh_alice".to_string()),
        target_agent_id: None,
        target_display_name: "Alice".to_string(),
        target_owner_name: Some("Alice".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "hi group".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-message".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        completed_at_ms: Some(1_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:bob:person".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_bob".to_string(),
        peer_display_name: Some("Bob".to_string()),
        peer_owner_name: Some("Bob".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Bob".to_string(),
        subtitle: String::new(),
        unread_count: 1,
        updated_at_ms: 1_001,
        updated_at_label: "13:27".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_group".to_string(),
        direction: "inbound".to_string(),
        sender: Some("Bob".to_string()),
        text: "hi group".to_string(),
        time_label: "13:27".to_string(),
        timestamp_ms: 1_001,
        request_id: Some("bridge_req_group".to_string()),
        delivery_state: None,
        outreach: Some(outreach.clone()),
        attachments: Vec::new(),
    }];

    sync_bridge_outreach_into_parent_session(
        &conn,
        &conversation,
        &messages,
        &outreach,
        "human:local-alice",
        None,
        Some("human:remote-bob"),
        "human:remote-bob",
        false,
    )
    .expect("sync inbound group session message");

    let session = select_session(&conn, parent_session_id)
        .expect("select session")
        .expect("session exists");
    assert_eq!(session.kind, "group");
    assert_eq!(session.title, "Alice, Bob, Carol");
    assert_eq!(
        session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("groupId"))
            .and_then(|value| value.as_str()),
        Some(parent_session_id),
    );
    assert_eq!(
        session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("groupSpaceId"))
            .and_then(|value| value.as_str()),
        Some(parent_session_id),
    );
    assert_eq!(
        session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("customName"))
            .and_then(|value| value.as_str()),
        Some("Alice, Bob, Carol"),
    );
    let self_participant_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE session_id = ?1 AND role = 'self'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("self participant count");
    assert_eq!(self_participant_count, 1);
    let participant_roles: Vec<(String, String)> = conn
        .prepare(
            "SELECT identity_id, role FROM session_participants WHERE session_id = ?1 ORDER BY identity_id",
        )
        .expect("prepare participants")
        .query_map(rusqlite::params![parent_session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query participants")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect participants");
    assert_eq!(
        participant_roles,
        vec![
            ("human:carol".to_string(), "person".to_string()),
            ("human:local-alice".to_string(), "self".to_string()),
            ("human:remote-bob".to_string(), "person".to_string()),
        ],
    );
    let (sender_identity_id, content_text): (String, String) = conn
        .query_row(
            "SELECT sender_identity_id, content_text FROM session_messages WHERE session_id = ?1",
            rusqlite::params![parent_session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("message");
    assert_eq!(sender_identity_id, "human:remote-bob");
    assert_eq!(content_text, "hi group");
}

#[test]
fn group_admin_count_uses_group_metadata_not_local_self_role() {
    let conn = test_conn();
    for (id, display_name) in [
        ("human:creator", "Creator"),
        ("human:receiver", "Receiver"),
        ("human:other", "Other"),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: "human".to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: Some(format!("node-{id}")),
                human_id: Some(id.to_string()),
                agent_id: None,
                avatar_key: Some(id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let session_id = "session:group:admin-source";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:creator".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:receiver".to_string(), "human:other".to_string()],
            metadata: Some(serde_json::json!({
                "adminIdentityIds": ["human:creator"],
                "groupSpaceId": session_id,
            })),
        },
    )
    .expect("open group");
    conn.execute(
        "UPDATE session_participants SET role = 'self' WHERE session_id = ?1 AND identity_id = 'human:receiver'",
        rusqlite::params![session_id],
    )
    .expect("simulate receiver-local self role");

    assert_eq!(
        group_admin_identity_ids(&conn, session_id).expect("admin ids"),
        vec!["human:creator".to_string()],
    );
}

#[test]
fn inbound_group_session_invite_reconstructs_group_parent_without_visible_message() {
    let conn = test_conn();
    for (id, display_name, human_id, node_id) in [
        ("human:local-alice", "Alice", "kh_alice", "kd_alice"),
        ("human:remote-bob", "Bob", "kh_bob", "kd_bob"),
        ("human:carol", "Carol", "kh_carol", "kd_carol"),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: "human".to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: Some(node_id.to_string()),
                human_id: Some(human_id.to_string()),
                agent_id: None,
                avatar_key: Some(human_id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let parent_session_id = "session:group:invite";
    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Alice, Bob, Carol".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_session_participants: vec![
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:local-alice".to_string()),
                display_name: "Alice".to_string(),
                role: Some("self".to_string()),
                bridge_node_id: Some("kd_alice".to_string()),
                human_id: Some("kh_alice".to_string()),
                agent_id: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:remote-bob".to_string()),
                display_name: "Bob".to_string(),
                role: Some("person".to_string()),
                bridge_node_id: Some("kd_bob".to_string()),
                human_id: Some("kh_bob".to_string()),
                agent_id: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:carol".to_string()),
                display_name: "Carol".to_string(),
                role: Some("person".to_string()),
                bridge_node_id: Some("kd_carol".to_string()),
                human_id: Some("kh_carol".to_string()),
                agent_id: None,
            },
        ],
        parent_session_messages: Vec::new(),
        parent_turn_id: None,
        parent_message_id: None,
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:bob:person".to_string()),
        bridge_request_id: Some("bridge_req_invite".to_string()),
        delivery_state: None,
        target_node_id: "kd_alice".to_string(),
        target_human_id: Some("kh_alice".to_string()),
        target_agent_id: None,
        target_display_name: "Alice".to_string(),
        target_owner_name: Some("Alice".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "You were added to Alice, Bob, Carol".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-invite".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        completed_at_ms: Some(1_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:bob:person".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_bob".to_string(),
        peer_display_name: Some("Bob".to_string()),
        peer_owner_name: Some("Bob".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Bob".to_string(),
        subtitle: String::new(),
        unread_count: 1,
        updated_at_ms: 1_001,
        updated_at_label: "13:27".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_invite".to_string(),
        direction: "inbound".to_string(),
        sender: Some("Bob".to_string()),
        text: "You were added to Alice, Bob, Carol".to_string(),
        time_label: "13:27".to_string(),
        timestamp_ms: 1_001,
        request_id: Some("bridge_req_invite".to_string()),
        delivery_state: None,
        outreach: Some(outreach.clone()),
        attachments: Vec::new(),
    }];

    sync_bridge_outreach_into_parent_session(
        &conn,
        &conversation,
        &messages,
        &outreach,
        "human:local-alice",
        None,
        Some("human:remote-bob"),
        "human:remote-bob",
        false,
    )
    .expect("sync inbound group invite");

    let session = select_session(&conn, parent_session_id)
        .expect("select session")
        .expect("session exists");
    assert_eq!(session.kind, "group");
    assert_eq!(
        session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("groupId"))
            .and_then(|value| value.as_str()),
        Some(parent_session_id),
    );
    assert_eq!(
        session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("groupSpaceId"))
            .and_then(|value| value.as_str()),
        Some(parent_session_id),
    );
    assert_eq!(
        session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("customName"))
            .and_then(|value| value.as_str()),
        Some("Alice, Bob, Carol"),
    );
    let self_participant_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE session_id = ?1 AND role = 'self'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("self participant count");
    assert_eq!(self_participant_count, 1);
    let participant_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE session_id = ?1 AND state = 'active'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("participant count");
    assert_eq!(participant_count, 3);
    let message_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("message count");
    assert_eq!(message_count, 0);
}

#[test]
fn inbound_group_session_update_renames_group_without_visible_message() {
    let conn = test_conn();
    for (id, display_name, human_id, node_id) in [
        ("human:local-alice", "Alice", "kh_alice", "kd_alice"),
        ("human:remote-bob", "Bob", "kh_bob", "kd_bob"),
        ("human:carol", "Carol", "kh_carol", "kd_carol"),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: "human".to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: Some(node_id.to_string()),
                human_id: Some(human_id.to_string()),
                agent_id: None,
                avatar_key: Some(human_id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let parent_session_id = "session:group:rename";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Old group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:remote-bob".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![
                "human:local-alice".to_string(),
                "human:carol".to_string(),
            ],
            metadata: Some(serde_json::json!({
                "customName": "Old group",
                "groupId": parent_session_id,
                "groupSpaceId": parent_session_id,
                "adminIdentityIds": ["human:remote-bob"],
            })),
        },
    )
    .expect("open group");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Renamed group".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_session_participants: vec![
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:local-alice".to_string()),
                display_name: "Alice".to_string(),
                role: Some("person".to_string()),
                bridge_node_id: Some("kd_alice".to_string()),
                human_id: Some("kh_alice".to_string()),
                agent_id: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:remote-bob".to_string()),
                display_name: "Bob".to_string(),
                role: Some("admin".to_string()),
                bridge_node_id: Some("kd_bob".to_string()),
                human_id: Some("kh_bob".to_string()),
                agent_id: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:carol".to_string()),
                display_name: "Carol".to_string(),
                role: Some("person".to_string()),
                bridge_node_id: Some("kd_carol".to_string()),
                human_id: Some("kh_carol".to_string()),
                agent_id: None,
            },
        ],
        parent_session_messages: Vec::new(),
        parent_turn_id: None,
        parent_message_id: None,
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:bob:person".to_string()),
        bridge_request_id: Some("bridge_req_rename".to_string()),
        delivery_state: None,
        target_node_id: "kd_alice".to_string(),
        target_human_id: Some("kh_alice".to_string()),
        target_agent_id: None,
        target_display_name: "Alice".to_string(),
        target_owner_name: Some("Alice".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "Group renamed to Renamed group".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-update".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        completed_at_ms: Some(1_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:bob:person".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_bob".to_string(),
        peer_display_name: Some("Bob".to_string()),
        peer_owner_name: Some("Bob".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Bob".to_string(),
        subtitle: String::new(),
        unread_count: 1,
        updated_at_ms: 1_001,
        updated_at_label: "13:27".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_rename".to_string(),
        direction: "inbound".to_string(),
        sender: Some("Bob".to_string()),
        text: "Group renamed to Renamed group".to_string(),
        time_label: "13:27".to_string(),
        timestamp_ms: 1_001,
        request_id: Some("bridge_req_rename".to_string()),
        delivery_state: None,
        outreach: Some(outreach.clone()),
        attachments: Vec::new(),
    }];

    sync_bridge_outreach_into_parent_session(
        &conn,
        &conversation,
        &messages,
        &outreach,
        "human:local-alice",
        None,
        Some("human:remote-bob"),
        "human:remote-bob",
        false,
    )
    .expect("sync inbound group update");

    let session = select_session(&conn, parent_session_id)
        .expect("select session")
        .expect("session exists");
    assert_eq!(session.title, "Renamed group");
    assert_eq!(session.created_by_identity_id, "human:remote-bob");
    assert_eq!(
        session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("customName"))
            .and_then(|value| value.as_str()),
        Some("Renamed group"),
    );
    let self_participant_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE session_id = ?1 AND role = 'self'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("self participant count");
    assert_eq!(self_participant_count, 1);
    let message_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("message count");
    assert_eq!(message_count, 0);
}

#[test]
fn group_session_fanout_reconciles_duplicate_parent_message_copies() {
    let conn = test_conn();
    for (id, display_name, human_id, node_id) in [
        ("human:profile", "You", "profile", ""),
        ("human:local", "Local", "kh_local", "kd_local"),
        ("human:remote", "Remote", "kh_remote", "kd_remote"),
        ("human:other", "Other", "kh_other", "kd_other"),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: "human".to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: Some(node_id.to_string()),
                human_id: Some(human_id.to_string()),
                agent_id: None,
                avatar_key: Some(human_id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let parent_session_id = "session:group:fanout";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:profile".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:remote".to_string(), "human:other".to_string()],
            metadata: Some(serde_json::json!({ "source": "chat-create-flow" })),
        },
    )
    .expect("seed local-created group");

    for (conversation_id, message_id) in [
        ("bridge:host:remote:person", "bridge_msg_copy_1"),
        ("bridge:host:other:person", "bridge_msg_copy_2"),
    ] {
        let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
            target_kind: "bridge-person".to_string(),
            parent_session_id: Some(parent_session_id.to_string()),
            parent_session_title: Some("Group".to_string()),
            parent_session_kind: Some("group".to_string()),
            parent_session_participants: Vec::new(),
            parent_session_messages: Vec::new(),
            parent_turn_id: None,
            parent_message_id: Some("msg:same-parent".to_string()),
            bridge_host_id: "bridge-host".to_string(),
            bridge_conversation_id: Some(conversation_id.to_string()),
            bridge_request_id: Some(format!("bridge_req_{message_id}")),
            delivery_state: None,
            target_node_id: "kd_remote".to_string(),
            target_human_id: Some("kh_remote".to_string()),
            target_agent_id: None,
            target_display_name: "Remote".to_string(),
            target_owner_name: Some("Remote".to_string()),
            target_runtime: Some("person".to_string()),
            request_text: "same group text".to_string(),
            trigger_text: None,
            context_text: None,
            context_policy: Some("session-message".to_string()),
            project_id: None,
            project_name: None,
            status: "completed".to_string(),
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
            completed_at_ms: Some(1_000),
            error: None,
        };
        let conversation = crate::bridge::DesktopBridgeConversation {
            id: conversation_id.to_string(),
            canonical_session_id: parent_session_id.to_string(),
            host_id: "bridge-host".to_string(),
            peer_node_id: "kd_remote".to_string(),
            peer_display_name: Some("Remote".to_string()),
            peer_owner_name: Some("Remote".to_string()),
            peer_runtime: "person".to_string(),
            project_id: None,
            project_name: None,
            title: "Remote".to_string(),
            subtitle: String::new(),
            unread_count: 0,
            updated_at_ms: 1_001,
            updated_at_label: "13:27".to_string(),
            awaiting_reply: false,
            peer_typing: false,
            peer_last_heartbeat_label: None,
            outreach: None,
            identity: None,
            messages: Vec::new(),
        };
        let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
            id: message_id.to_string(),
            direction: "outbound".to_string(),
            sender: Some("Local".to_string()),
            text: "same group text".to_string(),
            time_label: "13:27".to_string(),
            timestamp_ms: 1_001,
            request_id: outreach.bridge_request_id.clone(),
            delivery_state: None,
            outreach: Some(outreach.clone()),
            attachments: Vec::new(),
        }];
        sync_bridge_outreach_into_parent_session(
            &conn,
            &conversation,
            &messages,
            &outreach,
            "human:local",
            None,
            Some("human:remote"),
            "human:remote",
            false,
        )
        .expect("sync group fanout copy");
    }

    let message_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("message count");
    assert_eq!(message_count, 1);
    let local_bridge_self_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE session_id = ?1 AND identity_id = 'human:local'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("local bridge self count");
    assert_eq!(local_bridge_self_count, 0);
}

#[test]
fn attachment_only_session_message_syncs_into_parent_session() {
    let conn = test_conn();
    for (id, display_name, human_id, node_id) in [
        ("human:local-shuyang", "Shuyang", "kh_shuyang", "kd_shuyang"),
        (
            "human:remote-shenzhe",
            "Shenzhe",
            "kh_shenzhe",
            "kd_shenzhe",
        ),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: "human".to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: Some(node_id.to_string()),
                human_id: Some(human_id.to_string()),
                agent_id: None,
                avatar_key: Some(human_id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let parent_session_id = "session:bridge:humans:stable-pair";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "direct-person".to_string(),
            title: Some("Shenzhe".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local-shuyang".to_string(),
            primary_identity_id: Some("human:remote-shenzhe".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:remote-shenzhe".to_string()),
            participant_identity_ids: vec!["human:remote-shenzhe".to_string()],
            metadata: Some(serde_json::json!({
                "source": "desktop-bridge-conversation",
            })),
        },
    )
    .expect("open existing peer-named session");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: None,
        parent_session_kind: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        parent_turn_id: None,
        parent_message_id: Some("msg:sender-ui".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:remote:person".to_string()),
        bridge_request_id: Some("bridge_req_attachment".to_string()),
        delivery_state: None,
        target_node_id: "kd_shuyang".to_string(),
        target_human_id: Some("kh_shuyang".to_string()),
        target_agent_id: None,
        target_display_name: "Shuyang".to_string(),
        target_owner_name: Some("Shuyang".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-message".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        completed_at_ms: Some(1_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:remote:person".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_shenzhe".to_string(),
        peer_display_name: Some("Shenzhe".to_string()),
        peer_owner_name: Some("Shenzhe".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Shenzhe".to_string(),
        subtitle: String::new(),
        unread_count: 1,
        updated_at_ms: 1_001,
        updated_at_label: "13:27".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_attachment".to_string(),
        direction: "inbound".to_string(),
        sender: Some("Shenzhe".to_string()),
        text: "".to_string(),
        time_label: "13:27".to_string(),
        timestamp_ms: 1_001,
        request_id: Some("bridge_req_attachment".to_string()),
        delivery_state: None,
        outreach: Some(outreach.clone()),
        attachments: vec![crate::bridge::DesktopBridgeMessageAttachment {
            kind: "image".to_string(),
            name: "image.png".to_string(),
            format_label: Some("PNG".to_string()),
            mime_type: Some("image/png".to_string()),
            size_bytes: Some(30_070),
            local_path: Some("/tmp/image.png".to_string()),
        }],
    }];

    sync_bridge_outreach_into_parent_session(
        &conn,
        &conversation,
        &messages,
        &outreach,
        "human:local-shuyang",
        None,
        Some("human:remote-shenzhe"),
        "human:remote-shenzhe",
        false,
    )
    .expect("sync attachment-only session message");

    let (content_text, attachments_len): (String, i64) = conn
        .query_row(
            "SELECT content_text, json_array_length(json_extract(content_json, '$.attachments'))
             FROM session_messages
             WHERE source_event_id = ?1",
            ["desktop-bridge-parent:session:bridge:humans:stable-pair:msg:sender-ui"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("select synced attachment-only message");

    assert_eq!(content_text, "");
    assert_eq!(attachments_len, 1);
}

#[test]
fn desktop_sync_does_not_reclassify_bridge_sessions() {
    let conn = test_conn();
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:bridge:humans:test".to_string()),
            kind: "direct-person".to_string(),
            title: Some("User A".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("human:remote".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:remote".to_string()),
            participant_identity_ids: vec!["human:remote".to_string()],
            metadata: Some(serde_json::json!({ "source": "desktop-bridge-conversation" })),
        },
    )
    .expect("open bridge session");
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("local-session".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Local".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:local".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:local".to_string()],
            metadata: Some(serde_json::json!({ "source": "desktop-chat-summary" })),
        },
    )
    .expect("open desktop session");
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("selected-agent-session".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Selected agent".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:selected".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:selected".to_string()],
            metadata: Some(serde_json::json!({ "createdFrom": "chat-create-flow" })),
        },
    )
    .expect("open selected agent session");

    assert!(
        !should_update_desktop_session_shell(&conn, "session:bridge:humans:test")
            .expect("bridge shell check")
    );
    assert!(
        should_update_desktop_session_shell(&conn, "local-session").expect("desktop shell check")
    );
    assert!(
        !should_update_desktop_session_shell(&conn, "selected-agent-session")
            .expect("selected agent shell check")
    );
}

#[test]
fn bridge_human_display_name_strips_scoped_kordi_label() {
    assert_eq!(bridge_human_display_name("User A's Kordi"), "User A");
    assert_eq!(bridge_human_display_name("user b’s Kordi"), "user b");
    assert_eq!(bridge_human_display_name("user b"), "user b");
}

#[test]
fn snapshot_you_sender_uses_remote_human_name_for_receiver() {
    let conn = test_conn();
    upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("human:local".to_string()),
            kind: "human".to_string(),
            display_name: "user b".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: None,
            bridge_node_id: Some("kd_local".to_string()),
            human_id: Some("kh_local".to_string()),
            agent_id: None,
            avatar_key: Some("kh_local".to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("local human identity");
    upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("human:remote".to_string()),
            kind: "human".to_string(),
            display_name: "User A".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: None,
            bridge_node_id: Some("kd_remote".to_string()),
            human_id: Some("kh_remote".to_string()),
            agent_id: None,
            avatar_key: Some("kh_remote".to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("remote human identity");
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:snapshot".to_string()),
            kind: "relationship".to_string(),
            title: Some("Shared".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("human:remote".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:remote".to_string()),
            participant_identity_ids: vec!["human:remote".to_string()],
            metadata: Some(serde_json::json!({ "source": "bridge-session-thread" })),
        },
    )
    .expect("open snapshot session");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some("session:snapshot".to_string()),
        parent_session_title: Some("Shared".to_string()),
        parent_session_kind: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: vec![crate::bridge::DesktopBridgeSessionThreadMessage {
            role: "user".to_string(),
            sender: Some("You".to_string()),
            text: "check todays weather again for jeddah".to_string(),
            time_label: Some("22:07".to_string()),
            index: Some(0),
        }],
        parent_turn_id: None,
        parent_message_id: None,
        bridge_host_id: "bridge-local".to_string(),
        bridge_conversation_id: None,
        bridge_request_id: Some("bridge_req".to_string()),
        delivery_state: None,
        target_node_id: "kd_local".to_string(),
        target_human_id: Some("kh_local".to_string()),
        target_agent_id: None,
        target_display_name: "user b".to_string(),
        target_owner_name: Some("user b".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "let's talk".to_string(),
        trigger_text: Some("@user b let's talk".to_string()),
        context_text: None,
        context_policy: Some("recent-window".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 2_000,
        updated_at_ms: 2_000,
        completed_at_ms: Some(2_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:local:remote:person".to_string(),
        canonical_session_id: "session:snapshot".to_string(),
        host_id: "bridge-local".to_string(),
        peer_node_id: "kd_remote".to_string(),
        peer_display_name: Some("User A".to_string()),
        peer_owner_name: Some("User A".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "User A".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 2_000,
        updated_at_label: "22:07".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: Some(outreach.clone()),
        identity: None,
        messages: Vec::new(),
    };

    sync_parent_session_snapshot_messages(
        &conn,
        "session:snapshot",
        &conversation,
        &outreach,
        "human:local",
        None,
        "human:remote",
    )
    .expect("sync snapshot messages");

    let sender: String = conn
        .query_row(
            "SELECT json_extract(content_json, '$.sender')
             FROM session_messages
             WHERE session_id = 'session:snapshot'
               AND content_text = 'check todays weather again for jeddah'",
            [],
            |row| row.get(0),
        )
        .expect("snapshot sender");
    assert_eq!(sender, "User A");
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
