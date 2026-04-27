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
fn message_scoped_outreach_groups_include_same_request_response_without_message_outreach() {
    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some("session:bridge:humans:test".to_string()),
        parent_session_title: Some("hello".to_string()),
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
        },
    );
    assert!(bridge_conversation_has_unrouted_direct_messages(
        &conversation_with_direct_message,
        &handled
    ));
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

    assert!(
        !should_update_desktop_session_shell(&conn, "session:bridge:humans:test")
            .expect("bridge shell check")
    );
    assert!(
        should_update_desktop_session_shell(&conn, "local-session").expect("desktop shell check")
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
