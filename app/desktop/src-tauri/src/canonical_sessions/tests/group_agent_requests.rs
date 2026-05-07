use super::*;

#[test]
fn group_agent_response_without_top_level_context_rejoins_session_message_group() {
    let request_outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some("session:group:test".to_string()),
        parent_session_title: Some("Group".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some("session:group:test".to_string()),
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        parent_turn_id: None,
        parent_message_id: Some("msg:ui:request".to_string()),
        bridge_host_id: "bridge-local".to_string(),
        bridge_conversation_id: Some("bridge:local:remote".to_string()),
        bridge_request_id: Some("bridge_req_group_agent".to_string()),
        delivery_state: Some("responded".to_string()),
        target_node_id: "kd_remote".to_string(),
        target_human_id: Some("kh_remote".to_string()),
        target_agent_id: Some("ka_remote".to_string()),
        target_display_name: "Remote Kordi".to_string(),
        target_owner_name: Some("Remote".to_string()),
        target_runtime: Some("kordi-desktop".to_string()),
        request_text: "@RemoteKordi hello".to_string(),
        trigger_text: Some("@RemoteKordi hello".to_string()),
        context_text: None,
        context_policy: Some("session-message".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 2_000,
        completed_at_ms: Some(2_000),
        error: None,
    };
    let mut response_outreach = request_outreach.clone();
    response_outreach.context_policy = None;
    response_outreach.request_text = "hello back".to_string();

    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:local:remote".to_string(),
        canonical_session_id: "session:group:test".to_string(),
        host_id: "bridge-local".to_string(),
        peer_node_id: "kd_remote".to_string(),
        peer_display_name: Some("Remote Kordi".to_string()),
        peer_owner_name: Some("Remote".to_string()),
        peer_runtime: "kordi-desktop".to_string(),
        project_id: None,
        project_name: None,
        title: "Remote Kordi".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 2_000,
        updated_at_label: "Now".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: vec![
            crate::bridge::DesktopBridgeConversationMessage {
                id: "msg-request".to_string(),
                direction: "outbound".to_string(),
                sender: Some("Local".to_string()),
                text: "@RemoteKordi hello".to_string(),
                time_label: "10:00".to_string(),
                timestamp_ms: 1_000,
                request_id: Some("bridge_req_group_agent".to_string()),
                delivery_state: Some("responded".to_string()),
                outreach: Some(request_outreach),
                attachments: Vec::new(),
            },
            crate::bridge::DesktopBridgeConversationMessage {
                id: "msg-response".to_string(),
                direction: "inbound-response".to_string(),
                sender: Some("Remote Kordi".to_string()),
                text: "hello back".to_string(),
                time_label: "10:01".to_string(),
                timestamp_ms: 2_000,
                request_id: Some("bridge_req_group_agent".to_string()),
                delivery_state: Some("responded".to_string()),
                outreach: Some(response_outreach),
                attachments: Vec::new(),
            },
        ],
    };

    let groups = message_scoped_outreach_groups(&conversation);

    assert_eq!(groups.len(), 1);
    assert_eq!(
        groups[0].0.context_policy.as_deref(),
        Some("session-message")
    );
    assert_eq!(groups[0].1.len(), 2);
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
            parent_group_space_id: None,
            parent_session_participants: Vec::new(),
            parent_session_messages: Vec::new(),
            initiator_identity: None,
            self_target_identity: None,
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
fn group_bridge_agent_session_message_keeps_request_and_response() {
    let conn = test_conn();
    for (id, kind, display_name, human_id, node_id, owner_id, agent_id) in [
        (
            "human:local",
            "human",
            "Agent Owner",
            Some("kh_local"),
            Some("kd_local"),
            None,
            None,
        ),
        (
            "human:requester",
            "human",
            "Requester",
            Some("kh_requester"),
            Some("kd_requester"),
            None,
            None,
        ),
        (
            "agent:local",
            "agent",
            "Agent Owner's Kordi",
            None,
            Some("kd_local"),
            Some("human:local"),
            Some("ka_local"),
        ),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: kind.to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: owner_id.map(ToString::to_string),
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: node_id.map(ToString::to_string),
                human_id: human_id.map(ToString::to_string),
                agent_id: agent_id.map(ToString::to_string),
                avatar_key: human_id.or(agent_id).map(ToString::to_string),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let parent_session_id = "session:group:bridge-agent";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![
                "human:local".to_string(),
                "human:requester".to_string(),
                "agent:local".to_string(),
            ],
            metadata: Some(serde_json::json!({ "source": "chat-create-flow" })),
        },
    )
    .expect("seed group");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Group".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some(parent_session_id.to_string()),
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        parent_turn_id: None,
        parent_message_id: Some("msg:group-request".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:requester".to_string()),
        bridge_request_id: Some("bridge_req_group_bridge_agent".to_string()),
        delivery_state: Some("responded".to_string()),
        target_node_id: "kd_local".to_string(),
        target_human_id: Some("kh_local".to_string()),
        target_agent_id: Some("ka_local".to_string()),
        target_display_name: "Agent Owner's Kordi".to_string(),
        target_owner_name: Some("Agent Owner".to_string()),
        target_runtime: Some("kordi-desktop".to_string()),
        request_text: "@AgentOwnersKordi should we go golfing?".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-message".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 2_000,
        completed_at_ms: Some(2_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:requester".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_requester".to_string(),
        peer_display_name: Some("Requester".to_string()),
        peer_owner_name: Some("Requester".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Requester".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 2_000,
        updated_at_label: "10:03".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:stale-legacy-agent-request".to_string()),
            session_id: parent_session_id.to_string(),
            sender_identity_id: "agent:local".to_string(),
            sender_role: "external-agent".to_string(),
            message_kind: "agent-turn".to_string(),
            content_text: "@AgentOwnersKordi should we go golfing?".to_string(),
            content: Some(serde_json::json!({
                "kind": "mention-request",
                "direction": "inbound-response",
                "bridgeConversationId": "bridge:host:requester",
            })),
            created_at_ms: Some(2_000),
            parent_message_id: Some("msg:group-request".to_string()),
            delegated_exchange_id: None,
            status: Some("complete".to_string()),
            source_transport: Some("desktop-bridge-outreach".to_string()),
            source_event_id: Some(
                "desktop-bridge-outreach:bridge:host:requester:bridge_msg_response:request"
                    .to_string(),
            ),
        },
    )
    .expect("seed stale legacy response row");

    let messages = vec![
        crate::bridge::DesktopBridgeConversationMessage {
            id: "bridge_msg_request".to_string(),
            direction: "inbound".to_string(),
            sender: Some("Requester".to_string()),
            text: "@AgentOwnersKordi should we go golfing?".to_string(),
            time_label: "10:02".to_string(),
            timestamp_ms: 1_000,
            request_id: outreach.bridge_request_id.clone(),
            delivery_state: Some("delivered".to_string()),
            outreach: Some(outreach.clone()),
            attachments: Vec::new(),
        },
        crate::bridge::DesktopBridgeConversationMessage {
            id: "bridge_msg_response".to_string(),
            direction: "outbound-response".to_string(),
            sender: Some("Agent Owner's Kordi".to_string()),
            text: "Yes, it looks good to go golfing today.".to_string(),
            time_label: "10:03".to_string(),
            timestamp_ms: 2_000,
            request_id: outreach.bridge_request_id.clone(),
            delivery_state: Some("responded".to_string()),
            outreach: Some(outreach.clone()),
            attachments: Vec::new(),
        },
    ];

    sync_bridge_outreach_into_parent_session(
        &conn,
        &conversation,
        &messages,
        &outreach,
        "human:local",
        Some("agent:local"),
        Some("human:requester"),
        "human:requester",
        false,
    )
    .expect("sync bridge-agent group request and response");

    let rows = conn
        .prepare(
            "SELECT sender_role, message_kind, content_text FROM session_messages WHERE session_id = ?1 ORDER BY created_at_ms, sequence_num",
        )
        .expect("prepare messages")
        .query_map(rusqlite::params![parent_session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .expect("query messages")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect messages");

    assert!(rows.iter().any(
        |(_, kind, text)| kind == "status" && text == "Agent Owner's Kordi joined via @mention"
    ));
    let visible_turns = rows
        .iter()
        .filter(|(_, kind, _)| kind != "status")
        .collect::<Vec<_>>();
    assert_eq!(visible_turns.len(), 2);
    assert_eq!(visible_turns[0].0, "person");
    assert_eq!(visible_turns[0].1, "text");
    assert_eq!(
        visible_turns[0].2,
        "@AgentOwnersKordi should we go golfing?"
    );
    assert_eq!(visible_turns[1].0, "owned-agent");
    assert_eq!(visible_turns[1].1, "agent-turn");
    assert_eq!(
        visible_turns[1].2,
        "Yes, it looks good to go golfing today."
    );
}

#[test]
fn inbound_group_bridge_agent_request_emits_join_even_when_agent_already_participates() {
    let conn = test_conn();
    for (id, kind, display_name, human_id, node_id, owner_id, agent_id) in [
        (
            "human:local",
            "human",
            "Testuser6",
            Some("kh_local"),
            Some("kd_local"),
            None,
            None,
        ),
        (
            "human:requester",
            "human",
            "Testuser4",
            Some("kh_requester"),
            Some("kd_requester"),
            None,
            None,
        ),
        (
            "agent:local",
            "agent",
            "Testuser6's Kordi",
            None,
            Some("kd_local"),
            Some("human:local"),
            Some("ka_local"),
        ),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: kind.to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: owner_id.map(ToString::to_string),
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: node_id.map(ToString::to_string),
                human_id: human_id.map(ToString::to_string),
                agent_id: agent_id.map(ToString::to_string),
                avatar_key: human_id.or(agent_id).map(ToString::to_string),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let parent_session_id = "session:group:local-agent-join";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![
                "human:local".to_string(),
                "human:requester".to_string(),
                "agent:local".to_string(),
            ],
            metadata: Some(serde_json::json!({ "source": "chat-create-flow" })),
        },
    )
    .expect("seed group");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Group".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some(parent_session_id.to_string()),
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        parent_turn_id: None,
        parent_message_id: Some("msg:agent-request".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:requester:person".to_string()),
        bridge_request_id: Some("bridge_req_local_agent_request".to_string()),
        delivery_state: Some("processing".to_string()),
        target_node_id: "kd_local".to_string(),
        target_human_id: Some("kh_local".to_string()),
        target_agent_id: Some("ka_local".to_string()),
        target_display_name: "Testuser6's Kordi".to_string(),
        target_owner_name: Some("Testuser6".to_string()),
        target_runtime: Some("kordi-desktop".to_string()),
        request_text: "@Testuser6sKordi easy food?".to_string(),
        trigger_text: Some("@Testuser6sKordi easy food?".to_string()),
        context_text: None,
        context_policy: Some("session-message".to_string()),
        project_id: None,
        project_name: None,
        status: "processing".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        completed_at_ms: None,
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:requester:person".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_requester".to_string(),
        peer_display_name: Some("Testuser4".to_string()),
        peer_owner_name: Some("Testuser4".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Testuser4".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 1_000,
        updated_at_label: "11:45".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_local_agent_request".to_string(),
        direction: "inbound".to_string(),
        sender: Some("Testuser4".to_string()),
        text: "@Testuser6sKordi easy food?".to_string(),
        time_label: "11:45".to_string(),
        timestamp_ms: 1_000,
        request_id: outreach.bridge_request_id.clone(),
        delivery_state: Some("processing".to_string()),
        outreach: Some(outreach.clone()),
        attachments: Vec::new(),
    }];

    sync_bridge_outreach_into_parent_session(
        &conn,
        &conversation,
        &messages,
        &outreach,
        "human:local",
        Some("agent:local"),
        Some("human:requester"),
        "human:requester",
        false,
    )
    .expect("sync local agent request");

    let join_text: String = conn
        .query_row(
            "SELECT content_text FROM session_messages WHERE session_id = ?1 AND content_text LIKE '%joined via @mention%'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("join row");
    assert_eq!(join_text, "Testuser6's Kordi joined via @mention");
}


#[test]
fn group_bridge_agent_session_message_creates_delegated_exchange_task() {
    let conn = test_conn();
    for (id, kind, display_name, human_id, node_id, owner_id, agent_id) in [
        ("human:local", "human", "Local", Some("kh_local"), Some("kd_local"), None, None),
        ("human:remote", "human", "Remote", Some("kh_remote"), Some("kd_remote"), None, None),
        ("agent:remote", "agent", "Remote Kordi", None, Some("kd_remote"), Some("human:remote"), Some("ka_remote")),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: kind.to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: owner_id.map(ToString::to_string),
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: node_id.map(ToString::to_string),
                human_id: human_id.map(ToString::to_string),
                agent_id: agent_id.map(ToString::to_string),
                avatar_key: human_id.or(agent_id).map(ToString::to_string),
                profile_image_url: None,
                metadata: None,
            },
        ).expect("upsert identity");
    }

    let parent_session_id = "session:group:task-sync";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Task group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:local".to_string(), "human:remote".to_string(), "agent:remote".to_string()],
            metadata: Some(serde_json::json!({ "source": "chat-create-flow" })),
        },
    ).expect("seed group");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Task group".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some(parent_session_id.to_string()),
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        parent_turn_id: None,
        parent_message_id: Some("msg:parent:request".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:remote-agent".to_string()),
        bridge_request_id: Some("bridge_req_group_task".to_string()),
        delivery_state: Some("processing".to_string()),
        target_node_id: "kd_remote".to_string(),
        target_human_id: Some("kh_remote".to_string()),
        target_agent_id: Some("ka_remote".to_string()),
        target_display_name: "Remote Kordi".to_string(),
        target_owner_name: Some("Remote".to_string()),
        target_runtime: Some("kordi-desktop".to_string()),
        request_text: "@RemoteKordi summarize the plan".to_string(),
        trigger_text: Some("@RemoteKordi summarize the plan".to_string()),
        context_text: None,
        context_policy: Some("session-message".to_string()),
        project_id: None,
        project_name: None,
        status: "processing".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_500,
        completed_at_ms: None,
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:remote-agent".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_remote".to_string(),
        peer_display_name: Some("Remote Kordi".to_string()),
        peer_owner_name: Some("Remote".to_string()),
        peer_runtime: "kordi-desktop".to_string(),
        project_id: None,
        project_name: None,
        title: "Remote Kordi".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 1_500,
        updated_at_label: "10:00".to_string(),
        awaiting_reply: true,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_group_task_request".to_string(),
        direction: "outbound".to_string(),
        sender: Some("Local".to_string()),
        text: "@RemoteKordi summarize the plan".to_string(),
        time_label: "10:00".to_string(),
        timestamp_ms: 1_000,
        request_id: outreach.bridge_request_id.clone(),
        delivery_state: Some("processing".to_string()),
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
        Some("human:local"),
        "agent:remote",
        true,
    ).expect("sync group agent task");

    let row: (String, String, String, String, Option<String>, String, String) = conn.query_row(
        "SELECT id, session_id, initiator_identity_id, target_identity_id, bridge_request_id, context_policy, status
         FROM delegated_exchanges WHERE session_id = ?1",
        rusqlite::params![parent_session_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).expect("delegated exchange");

    assert_eq!(row.0, "delegation:bridge-session-message:session:group:task-sync:bridge_req_group_task");
    assert_eq!(row.1, parent_session_id);
    assert_eq!(row.2, "human:local");
    assert_eq!(row.3, "agent:remote");
    assert_eq!(row.4.as_deref(), Some("bridge_req_group_task"));
    assert_eq!(row.5, "session-message");
    assert_eq!(row.6, "processing");
}

#[test]
fn group_person_session_message_does_not_create_delegated_exchange_task() {
    let conn = test_conn();
    for (id, display_name, human_id, node_id) in [
        ("human:local", "Local", "kh_local", "kd_local"),
        ("human:remote", "Remote", "kh_remote", "kd_remote"),
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
        ).expect("upsert identity");
    }

    let parent_session_id = "session:group:person-fanout-not-task";
    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("People".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some(parent_session_id.to_string()),
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        parent_turn_id: None,
        parent_message_id: Some("msg:person".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:remote".to_string()),
        bridge_request_id: Some("bridge_req_person_only".to_string()),
        delivery_state: Some("delivered".to_string()),
        target_node_id: "kd_remote".to_string(),
        target_human_id: Some("kh_remote".to_string()),
        target_agent_id: None,
        target_display_name: "Remote".to_string(),
        target_owner_name: Some("Remote".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "hello everyone".to_string(),
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
        id: "bridge:host:remote".to_string(),
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
        updated_at_ms: 1_000,
        updated_at_label: "10:00".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_person_only".to_string(),
        direction: "outbound".to_string(),
        sender: Some("Local".to_string()),
        text: "hello everyone".to_string(),
        time_label: "10:00".to_string(),
        timestamp_ms: 1_000,
        request_id: outreach.bridge_request_id.clone(),
        delivery_state: Some("delivered".to_string()),
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
    ).expect("sync person fanout");

    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM delegated_exchanges WHERE session_id = ?1",
        rusqlite::params![parent_session_id],
        |row| row.get(0),
    ).expect("exchange count");
    assert_eq!(count, 0);
}
