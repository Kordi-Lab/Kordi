use super::*;
use crate::canonical_sessions::desktop_sync::sync_desktop_chat_message;

mod response_reconciliation;

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
            updated_at_ms: 1,
            message_count: 1,
            draft: false,
            background_status: None,
            forked_from_session_id: None,
            forked_from_message_id: None,
        }],
        projects: Vec::new(),
        active_session: kordi_cli::desktop_runtime::DesktopChatSessionDetail {
            id: "session:local".to_string(),
            cwd: "/tmp/workspace".to_string(),
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
            updated_at_ms: 1,
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
            reflection_lesson_artifacts: Vec::new(),
            forked_from_session_id: None,
            forked_from_message_id: None,
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
                cancelled: false,
                entry_id: None,
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
        cancelled: false,
        entry_id: None,
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
fn desktop_sync_preserves_cancelled_agent_turn_status() {
    let conn = test_conn();
    let message = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("Kordi".to_string()),
        text: String::new(),
        detail: Some("openai/gpt-test • aborted".to_string()),
        time_label: "17:10".to_string(),
        timestamp_ms: 2_100,
        thinking_text: None,
        tools: Vec::new(),
        attachments: Vec::new(),
        failed: false,
        cancelled: true,
        entry_id: None,
    };

    let message_id = sync_desktop_chat_message(
        &conn,
        "session:local",
        "human:local",
        "agent:local",
        0,
        &message,
        None,
    )
    .expect("sync cancellation")
    .expect("cancelled message id");

    let (status, delivery_state): (String, String) = conn
        .query_row(
            "SELECT status, json_extract(content_json, '$.deliveryState')
             FROM session_messages
             WHERE id = ?1",
            [&message_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read cancellation");
    assert_eq!(status, "cancelled");
    assert_eq!(delivery_state, "cancelled");
}

#[test]
fn cloud_self_agent_upsert_reuses_existing_desktop_chat_user_echo() {
    let conn = test_conn();
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:desktop-user".to_string()),
            session_id: "session:new".to_string(),
            sender_identity_id: "human:local".to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "check disk usage".to_string(),
            content: Some(serde_json::json!({ "sender": "You" })),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            created_at_ms: Some(1_000),
            source_transport: Some("desktop-chat".to_string()),
            source_event_id: Some("desktop-chat:session:new:0:user:abc".to_string()),
        },
    )
    .expect("append desktop user");

    let synced = upsert_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:cloud:self:cloud-message-1".to_string()),
            session_id: "session:new".to_string(),
            sender_identity_id: "human:local".to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "check disk usage".to_string(),
            content: Some(serde_json::json!({ "sender": "You" })),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            created_at_ms: Some(1_000),
            source_transport: Some("cloud-self-agent".to_string()),
            source_event_id: Some("cloud-message-1".to_string()),
        },
    )
    .expect("upsert cloud self-agent echo");

    assert_eq!(synced.id, "msg:desktop-user");
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT id, source_transport FROM session_messages WHERE session_id = ?1 ORDER BY sequence_num")
        .expect("prepare messages")
        .query_map(["session:new"], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .expect("query messages")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect messages");
    assert_eq!(
        rows,
        vec![("msg:desktop-user".to_string(), "desktop-chat".to_string())]
    );
}

#[test]
fn desktop_sync_reuses_fork_snapshot_messages_for_inherited_history() {
    let conn = test_conn();
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:snapshot-user".to_string()),
            session_id: "session:fork".to_string(),
            sender_identity_id: "human:local".to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "inherited request".to_string(),
            content: Some(serde_json::json!({ "sender": "You" })),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            created_at_ms: Some(1_000),
            source_transport: Some("canonical-fork-snapshot".to_string()),
            source_event_id: Some("snapshot-user".to_string()),
        },
    )
    .expect("append snapshot user");
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:snapshot-answer".to_string()),
            session_id: "session:fork".to_string(),
            sender_identity_id: "agent:local".to_string(),
            sender_role: "owned-agent".to_string(),
            message_kind: "agent-turn".to_string(),
            content_text: "inherited answer".to_string(),
            content: Some(serde_json::json!({ "sender": "Kordi" })),
            parent_message_id: Some("msg:snapshot-user".to_string()),
            delegated_exchange_id: None,
            status: Some("complete".to_string()),
            created_at_ms: Some(2_000),
            source_transport: Some("canonical-fork-snapshot".to_string()),
            source_event_id: Some("snapshot-answer".to_string()),
        },
    )
    .expect("append snapshot answer");

    let user = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "user".to_string(),
        sender: Some("You".to_string()),
        text: "inherited request".to_string(),
        detail: None,
        time_label: "17:09".to_string(),
        timestamp_ms: 1_000,
        thinking_text: None,
        tools: Vec::new(),
        attachments: Vec::new(),
        failed: false,
        cancelled: false,
        entry_id: None,
    };
    let assistant = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("Kordi".to_string()),
        text: "inherited answer".to_string(),
        detail: Some("completed".to_string()),
        time_label: "17:09".to_string(),
        timestamp_ms: 2_000,
        thinking_text: None,
        tools: Vec::new(),
        attachments: Vec::new(),
        failed: false,
        cancelled: false,
        entry_id: None,
    };

    let user_id = sync_desktop_chat_message(
        &conn,
        "session:fork",
        "human:local",
        "agent:local",
        0,
        &user,
        None,
    )
    .expect("sync user")
    .expect("user id");
    let assistant_id = sync_desktop_chat_message(
        &conn,
        "session:fork",
        "human:local",
        "agent:local",
        1,
        &assistant,
        Some(user_id.as_str()),
    )
    .expect("sync assistant")
    .expect("assistant id");

    assert_eq!(user_id, "msg:snapshot-user");
    assert_eq!(assistant_id, "msg:snapshot-answer");
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT id, source_transport FROM session_messages WHERE session_id = ?1 ORDER BY sequence_num")
        .expect("prepare messages")
        .query_map(["session:fork"], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .expect("query messages")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect messages");
    assert_eq!(
        rows,
        vec![
            (
                "msg:snapshot-user".to_string(),
                "canonical-fork-snapshot".to_string()
            ),
            (
                "msg:snapshot-answer".to_string(),
                "canonical-fork-snapshot".to_string()
            ),
        ]
    );
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
            artifact_path: None,
            tool_layer: Some("observation".to_string()),
            is_error: false,
        }],
        attachments: Vec::new(),
        failed: false,
        cancelled: false,
        entry_id: None,
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
            artifact_path: None,
            tool_layer: Some("observation".to_string()),
            is_error: false,
        }],
        attachments: Vec::new(),
        failed: false,
        cancelled: false,
        entry_id: None,
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
            artifact_path: None,
            tool_layer: Some("observation".to_string()),
            is_error: false,
        }],
        attachments: Vec::new(),
        failed: false,
        cancelled: false,
        entry_id: None,
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
