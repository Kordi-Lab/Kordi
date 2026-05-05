use super::*;

#[test]
fn group_local_agent_response_fanout_reconciles_duplicate_response_copies() {
    let conn = test_conn();
    for (id, kind, display_name, human_id, node_id, owner_id, agent_id) in [
        (
            "human:profile",
            "human",
            "You",
            Some("profile"),
            None,
            None,
            None,
        ),
        (
            "human:local",
            "human",
            "Local",
            Some("kh_local"),
            Some("kd_local"),
            None,
            None,
        ),
        (
            "human:remote",
            "human",
            "Remote",
            Some("kh_remote"),
            Some("kd_remote"),
            None,
            None,
        ),
        (
            "human:other",
            "human",
            "Other",
            Some("kh_other"),
            Some("kd_other"),
            None,
            None,
        ),
        (
            "agent:local",
            "agent",
            "Local Kordi",
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

    let parent_session_id = "session:group:fanout-agent";
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
            participant_identity_ids: vec![
                "human:local".to_string(),
                "human:remote".to_string(),
                "human:other".to_string(),
            ],
            metadata: Some(serde_json::json!({ "source": "chat-create-flow" })),
        },
    )
    .expect("seed local-created group");

    let request_id = "bridge_req_group_agent_response";
    for (conversation_id, message_id, target_node_id, target_human_id, target_name) in [
        (
            "bridge:host:remote:person",
            "bridge_msg_agent_copy_1",
            "kd_remote",
            "kh_remote",
            "Remote",
        ),
        (
            "bridge:host:other:person",
            "bridge_msg_agent_copy_2",
            "kd_other",
            "kh_other",
            "Other",
        ),
    ] {
        let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
            target_kind: "bridge-person".to_string(),
            parent_session_id: Some(parent_session_id.to_string()),
            parent_session_title: Some("Group".to_string()),
            parent_session_kind: Some("group".to_string()),
            parent_group_space_id: Some(parent_session_id.to_string()),
            parent_session_participants: Vec::new(),
            parent_session_messages: Vec::new(),
            initiator_identity: None,
            self_target_identity: None,
            permission_policy_hash: None,
            participant_graph_hash: None,
            parent_turn_id: Some("turn:local-agent".to_string()),
            parent_message_id: Some("msg:agent-request".to_string()),
            bridge_host_id: "bridge-host".to_string(),
            bridge_conversation_id: Some(conversation_id.to_string()),
            bridge_request_id: Some(request_id.to_string()),
            delivery_state: Some("responded".to_string()),
            target_node_id: target_node_id.to_string(),
            target_human_id: Some(target_human_id.to_string()),
            target_agent_id: None,
            target_display_name: target_name.to_string(),
            target_owner_name: Some(target_name.to_string()),
            target_runtime: Some("person".to_string()),
            request_text: "weather answer".to_string(),
            trigger_text: None,
            context_text: None,
            context_policy: Some("session-relay".to_string()),
            project_id: None,
            project_name: None,
            status: "completed".to_string(),
            created_at_ms: 2_000,
            updated_at_ms: 2_000,
            completed_at_ms: Some(2_000),
            error: None,
        };
        let conversation = crate::bridge::DesktopBridgeConversation {
            id: conversation_id.to_string(),
            canonical_session_id: parent_session_id.to_string(),
            host_id: "bridge-host".to_string(),
            peer_node_id: target_node_id.to_string(),
            peer_display_name: Some(target_name.to_string()),
            peer_owner_name: Some(target_name.to_string()),
            peer_runtime: "person".to_string(),
            project_id: None,
            project_name: None,
            title: target_name.to_string(),
            subtitle: String::new(),
            unread_count: 0,
            updated_at_ms: 2_001,
            updated_at_label: "10:03".to_string(),
            awaiting_reply: false,
            peer_typing: false,
            peer_last_heartbeat_label: None,
            outreach: None,
            identity: None,
            messages: Vec::new(),
        };
        let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
            id: message_id.to_string(),
            direction: "outbound-response".to_string(),
            sender: Some("Local Kordi".to_string()),
            text: "weather answer".to_string(),
            time_label: "10:03".to_string(),
            timestamp_ms: 2_001,
            request_id: Some(request_id.to_string()),
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
            Some("agent:local"),
            Some("human:remote"),
            "human:remote",
            false,
        )
        .expect("sync group local-agent response fanout copy");
    }

    let message_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1 AND message_kind = 'agent-turn'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("agent response count");
    assert_eq!(message_count, 1);
}

#[test]
fn inbound_group_agent_response_fanout_join_uses_remote_agent_label() {
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
            "agent:local",
            "agent",
            "Testuser6's Kordi",
            None,
            Some("kd_local"),
            Some("human:local"),
            Some("ka_local"),
        ),
        (
            "human:remote",
            "human",
            "Testuser4",
            Some("kh_remote"),
            Some("kd_remote"),
            None,
            None,
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

    let parent_session_id = "session:group:remote-agent-label";
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
            participant_identity_ids: vec!["human:local".to_string(), "human:remote".to_string()],
            metadata: Some(serde_json::json!({ "source": "chat-create-flow" })),
        },
    )
    .expect("seed group");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Group".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some(parent_session_id.to_string()),
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        permission_policy_hash: None,
        participant_graph_hash: None,
        parent_turn_id: Some("turn:remote-agent".to_string()),
        parent_message_id: Some("msg:agent-request".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:remote:person".to_string()),
        bridge_request_id: Some("bridge_req_remote_agent_fanout".to_string()),
        delivery_state: Some("responded".to_string()),
        target_node_id: "kd_local".to_string(),
        target_human_id: Some("kh_local".to_string()),
        target_agent_id: None,
        target_display_name: "Testuser6".to_string(),
        target_owner_name: Some("Testuser6".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "remote answer".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-relay".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 2_000,
        completed_at_ms: Some(2_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:remote:person".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_remote".to_string(),
        peer_display_name: Some("Testuser4's Kordi".to_string()),
        peer_owner_name: Some("Testuser4".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Testuser4".to_string(),
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
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_remote_response".to_string(),
        direction: "inbound-response".to_string(),
        sender: Some("Testuser4's Kordi".to_string()),
        text: "remote answer".to_string(),
        time_label: "10:03".to_string(),
        timestamp_ms: 2_000,
        request_id: outreach.bridge_request_id.clone(),
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
        Some("agent:local"),
        Some("human:remote"),
        "human:remote",
        false,
    )
    .expect("sync inbound remote agent fanout");

    let join_text: String = conn
        .query_row(
            "SELECT content_text FROM session_messages WHERE session_id = ?1 AND content_text LIKE '%joined via @mention%'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("join row");
    assert_eq!(join_text, "Testuser4's Kordi joined via @mention");

    let response_sender: String = conn
        .query_row(
            "SELECT identities.display_name
             FROM session_messages
             JOIN identities ON identities.id = session_messages.sender_identity_id
             WHERE session_messages.session_id = ?1 AND session_messages.content_text = 'remote answer'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("response sender");
    assert_eq!(response_sender, "Testuser4's Kordi");
}

#[test]
fn inbound_group_local_agent_response_join_uses_response_sender_agent() {
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
            "agent:local",
            "agent",
            "Testuser6's Kordi",
            None,
            Some("kd_local"),
            Some("human:local"),
            Some("ka_local"),
        ),
        (
            "human:remote",
            "human",
            "Testuser5",
            Some("kh_remote"),
            Some("kd_remote"),
            None,
            None,
        ),
        (
            "agent:remote",
            "agent",
            "Testuser5's Kordi",
            None,
            Some("kd_remote"),
            Some("human:remote"),
            Some("ka_remote"),
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

    let parent_session_id = "session:group:remote-local-agent-label";
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
            participant_identity_ids: vec!["human:local".to_string(), "human:remote".to_string()],
            metadata: Some(serde_json::json!({ "source": "chat-create-flow" })),
        },
    )
    .expect("seed group");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Group".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some(parent_session_id.to_string()),
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        permission_policy_hash: None,
        participant_graph_hash: None,
        parent_turn_id: Some("turn:remote-local-agent".to_string()),
        parent_message_id: Some("msg:agent-request".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:remote:person".to_string()),
        bridge_request_id: Some("bridge_req_remote_local_agent_fanout".to_string()),
        delivery_state: Some("responded".to_string()),
        target_node_id: "kd_local".to_string(),
        target_human_id: Some("kh_local".to_string()),
        target_agent_id: None,
        target_display_name: "Testuser6".to_string(),
        target_owner_name: Some("Testuser6".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "remote local-agent answer".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-relay".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 2_000,
        completed_at_ms: Some(2_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:remote:person".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_remote".to_string(),
        peer_display_name: Some("Testuser5".to_string()),
        peer_owner_name: Some("Testuser5".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Testuser5".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 2_000,
        updated_at_label: "11:27".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_remote_local_agent_response".to_string(),
        direction: "inbound-response".to_string(),
        sender: Some("Testuser5's Kordi".to_string()),
        text: "remote local-agent answer".to_string(),
        time_label: "11:27".to_string(),
        timestamp_ms: 2_000,
        request_id: outreach.bridge_request_id.clone(),
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
        Some("agent:local"),
        Some("human:remote"),
        "human:remote",
        false,
    )
    .expect("sync inbound remote local-agent fanout");

    let join_text: String = conn
        .query_row(
            "SELECT content_text FROM session_messages WHERE session_id = ?1 AND content_text LIKE '%joined via @mention%'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("join row");
    assert_eq!(join_text, "Testuser5's Kordi joined via @mention");

    let response_sender: String = conn
        .query_row(
            "SELECT identities.display_name
             FROM session_messages
             JOIN identities ON identities.id = session_messages.sender_identity_id
             WHERE session_messages.session_id = ?1 AND session_messages.content_text = 'remote local-agent answer'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("response sender");
    assert_eq!(response_sender, "Testuser5's Kordi");
}
