use super::*;

#[test]
fn direct_agent_outreach_sync_keeps_owner_out_of_private_parent_participants() {
    let conn = test_conn();
    seed_identity(&conn, "human:local", "Me", "human");
    upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("human:owner".to_string()),
            kind: "human".to_string(),
            display_name: "Owner".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: Some("host-1".to_string()),
            bridge_node_id: Some("node-owner".to_string()),
            human_id: Some("human-owner".to_string()),
            agent_id: None,
            avatar_key: Some("human-owner".to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("owner identity");
    upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("agent:remote".to_string()),
            kind: "agent".to_string(),
            display_name: "Owner's Kordi".to_string(),
            owner_identity_id: Some("human:owner".to_string()),
            source: Some("bridge".to_string()),
            source_host_id: Some("host-1".to_string()),
            bridge_node_id: Some("node-owner".to_string()),
            human_id: None,
            agent_id: Some("agent-remote".to_string()),
            avatar_key: Some("agent-remote".to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("agent identity");
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:direct-agent:private".to_string()),
            kind: "direct-agent".to_string(),
            title: Some("Owner's Kordi".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:remote".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:remote".to_string()],
            metadata: Some(serde_json::json!({ "createdFrom": "chat-create-flow" })),
        },
    )
    .expect("open direct agent session");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some("session:direct-agent:private".to_string()),
        parent_session_title: Some("Owner's Kordi".to_string()),
        parent_session_kind: Some("direct-agent".to_string()),
        parent_group_space_id: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        permission_policy_hash: None,
        participant_graph_hash: None,
        parent_turn_id: None,
        parent_message_id: Some("msg:request".to_string()),
        bridge_host_id: "host-1".to_string(),
        bridge_conversation_id: Some("bridge:host-1:node-owner".to_string()),
        bridge_request_id: Some("bridge_req_private".to_string()),
        delivery_state: None,
        target_node_id: "node-owner".to_string(),
        target_human_id: Some("human-owner".to_string()),
        target_agent_id: Some("agent-remote".to_string()),
        target_display_name: "Owner's Kordi".to_string(),
        target_owner_name: Some("Owner".to_string()),
        target_runtime: Some("kordi-desktop".to_string()),
        request_text: "fresh private question".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("recent-window".to_string()),
        project_id: None,
        project_name: None,
        status: "complete".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 2_000,
        completed_at_ms: Some(2_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host-1:node-owner".to_string(),
        canonical_session_id: String::new(),
        host_id: "host-1".to_string(),
        peer_node_id: "node-owner".to_string(),
        peer_display_name: Some("Owner's Kordi".to_string()),
        peer_owner_name: Some("Owner".to_string()),
        peer_runtime: "kordi-desktop".to_string(),
        project_id: None,
        project_name: None,
        title: "Owner's Kordi".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 2_000,
        updated_at_label: "14:11".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: Some(outreach.clone()),
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_response".to_string(),
        direction: "inbound-response".to_string(),
        sender: Some("Owner's Kordi".to_string()),
        text: "fresh private answer".to_string(),
        time_label: "14:11".to_string(),
        timestamp_ms: 2_000,
        request_id: Some("bridge_req_private".to_string()),
        delivery_state: Some("responded".to_string()),
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
        Some("human:owner"),
        "agent:remote",
        true,
    )
    .expect("sync private direct-agent response");

    let participants: Vec<String> = conn
        .prepare("SELECT identity_id FROM session_participants WHERE session_id = ?1 ORDER BY identity_id")
        .expect("prepare participants")
        .query_map(["session:direct-agent:private"], |row| row.get::<_, String>(0))
        .expect("query participants")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect participants");

    assert_eq!(participants, vec!["agent:remote", "human:local"]);
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
        parent_group_space_id: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        permission_policy_hash: None,
        participant_graph_hash: None,
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
        parent_group_space_id: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: vec![crate::bridge::DesktopBridgeSessionThreadMessage {
            role: "user".to_string(),
            sender: Some("You".to_string()),
            text: "check todays weather again for jeddah".to_string(),
            time_label: Some("22:07".to_string()),
            index: Some(0),
        }],
        initiator_identity: None,
        self_target_identity: None,
        permission_policy_hash: None,
        participant_graph_hash: None,
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
