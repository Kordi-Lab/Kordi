use super::*;

#[test]
fn inbound_group_session_message_reconstructs_group_parent_and_members() {
    let conn = test_conn();
    for (id, display_name, human_id, _node_id) in [
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
                source: Some("local".to_string()),
                source_host_id: None,
                bridge_node_id: None,
                human_id: None,
                agent_id: None,
                avatar_key: Some(human_id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let group_space_id = "session:group:triad";
    let parent_session_id = "session:group:triad-child";
    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Alice, Bob, Carol".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some(group_space_id.to_string()),
        parent_session_participants: vec![
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:local-alice".to_string()),
                display_name: "Alice".to_string(),
                kind: None,
                role: Some("self".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_alice".to_string()),
                human_id: Some("kh_alice".to_string()),
                agent_id: None,
                runtime: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:remote-bob".to_string()),
                display_name: "Bob".to_string(),
                kind: None,
                role: Some("person".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_bob".to_string()),
                human_id: Some("kh_bob".to_string()),
                agent_id: None,
                runtime: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:carol".to_string()),
                display_name: "Carol".to_string(),
                kind: None,
                role: Some("person".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_carol".to_string()),
                human_id: Some("kh_carol".to_string()),
                agent_id: None,
                runtime: None,
            },
        ],
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        permission_policy_hash: None,
        participant_graph_hash: None,
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
        Some(group_space_id),
    );
    assert_eq!(
        session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("groupSpaceId"))
            .and_then(|value| value.as_str()),
        Some(group_space_id),
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

    let enriched_identities: Vec<(String, Option<String>, Option<String>, Option<String>)> = conn
        .prepare(
            "SELECT id, source_host_id, bridge_node_id, human_id
             FROM identities
             WHERE id IN ('human:local-alice', 'human:remote-bob', 'human:carol')
             ORDER BY id",
        )
        .expect("prepare enriched identities")
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .expect("query enriched identities")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect enriched identities");
    assert_eq!(
        enriched_identities,
        vec![
            (
                "human:carol".to_string(),
                Some("bridge-host".to_string()),
                Some("kd_carol".to_string()),
                Some("kh_carol".to_string()),
            ),
            (
                "human:local-alice".to_string(),
                Some("bridge-host".to_string()),
                Some("kd_alice".to_string()),
                Some("kh_alice".to_string()),
            ),
            (
                "human:remote-bob".to_string(),
                Some("bridge-host".to_string()),
                Some("kd_bob".to_string()),
                Some("kh_bob".to_string()),
            ),
        ],
    );
}

#[test]
fn outbound_group_session_message_sent_ack_reconciles_as_delivered_with_attachments() {
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

    let parent_session_id = "session:bridge:group-child";
    let group_space_id = "session:group:triad";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Alice, Bob, Carol".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local-alice".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![
                "human:remote-bob".to_string(),
                "human:carol".to_string(),
            ],
            metadata: Some(serde_json::json!({
                "groupSpaceId": group_space_id,
            })),
        },
    )
    .expect("open group");
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:group-parent".to_string()),
            session_id: parent_session_id.to_string(),
            sender_identity_id: "human:local-alice".to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "hi group".to_string(),
            content: Some(serde_json::json!({
                "sender": "Me",
                "timeLabel": "13:27",
                "attachments": [{
                    "kind": "image",
                    "name": "Screenshot.png",
                    "formatLabel": "PNG",
                    "localPath": "/tmp/Screenshot.png"
                }],
            })),
            created_at_ms: Some(1_000),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: Some("desktop-bridge-ui".to_string()),
            source_event_id: Some(format!("desktop-bridge-ui:{parent_session_id}:1000")),
        },
    )
    .expect("append optimistic group message");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Alice, Bob, Carol".to_string()),
        parent_session_kind: None,
        parent_group_space_id: Some(group_space_id.to_string()),
        parent_session_participants: vec![
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:local-alice".to_string()),
                display_name: "Alice".to_string(),
                kind: None,
                role: Some("self".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_alice".to_string()),
                human_id: Some("kh_alice".to_string()),
                agent_id: None,
                runtime: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:remote-bob".to_string()),
                display_name: "Bob".to_string(),
                kind: None,
                role: Some("person".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_bob".to_string()),
                human_id: Some("kh_bob".to_string()),
                agent_id: None,
                runtime: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:carol".to_string()),
                display_name: "Carol".to_string(),
                kind: None,
                role: Some("person".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_carol".to_string()),
                human_id: Some("kh_carol".to_string()),
                agent_id: None,
                runtime: None,
            },
        ],
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        permission_policy_hash: None,
        participant_graph_hash: None,
        parent_turn_id: None,
        parent_message_id: Some("msg:group-parent".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:bob:person".to_string()),
        bridge_request_id: Some("bridge_req_group".to_string()),
        delivery_state: None,
        target_node_id: "kd_bob".to_string(),
        target_human_id: Some("kh_bob".to_string()),
        target_agent_id: None,
        target_display_name: "Bob".to_string(),
        target_owner_name: Some("Bob".to_string()),
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
        id: "bridge_msg_group".to_string(),
        direction: "outbound".to_string(),
        sender: Some("Alice".to_string()),
        text: "hi group".to_string(),
        time_label: "13:27".to_string(),
        timestamp_ms: 1_001,
        request_id: Some("bridge_req_group".to_string()),
        delivery_state: Some("sent".to_string()),
        outreach: Some(outreach.clone()),
        attachments: vec![crate::bridge::DesktopBridgeMessageAttachment {
            kind: "image".to_string(),
            name: "Screenshot.png".to_string(),
            format_label: Some("PNG".to_string()),
            mime_type: Some("image/png".to_string()),
            size_bytes: Some(130_000),
            local_path: Some("/tmp/Screenshot.png".to_string()),
        }],
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
    .expect("sync outbound group session message");

    let (message_count, message_id, status, delivery_state, attachment_count): (i64, String, String, String, i64) = conn
        .query_row(
            "SELECT COUNT(*) OVER (), id, status, json_extract(content_json, '$.deliveryState'), json_array_length(json_extract(content_json, '$.attachments'))
             FROM session_messages
             WHERE session_id = ?1",
            rusqlite::params![parent_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .expect("message status");
    assert_eq!(message_count, 1);
    assert_eq!(message_id, "msg:group-parent");
    assert_eq!(status, "delivered");
    assert_eq!(delivery_state, "delivered");
    assert_eq!(attachment_count, 1);
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
        parent_group_space_id: None,
        parent_session_participants: vec![
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:local-alice".to_string()),
                display_name: "Alice".to_string(),
                kind: None,
                role: Some("self".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_alice".to_string()),
                human_id: Some("kh_alice".to_string()),
                agent_id: None,
                runtime: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:remote-bob".to_string()),
                display_name: "Bob".to_string(),
                kind: None,
                role: Some("person".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_bob".to_string()),
                human_id: Some("kh_bob".to_string()),
                agent_id: None,
                runtime: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:carol".to_string()),
                display_name: "Carol".to_string(),
                kind: None,
                role: Some("person".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_carol".to_string()),
                human_id: Some("kh_carol".to_string()),
                agent_id: None,
                runtime: None,
            },
        ],
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        permission_policy_hash: None,
        participant_graph_hash: None,
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
fn inbound_group_session_invite_imports_snapshot_messages() {
    let conn = test_conn();
    for (id, display_name, human_id, node_id) in [
        ("human:local-alice", "Alice", "kh_alice", "kd_alice"),
        ("human:remote-bob", "Bob", "kh_bob", "kd_bob"),
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

    let parent_session_id = "session:group:invite-with-history";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local-alice".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:remote-bob".to_string()],
            metadata: Some(serde_json::json!({
                "groupSpaceId": "session:group:root",
            })),
        },
    )
    .expect("open group from earlier session message");
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:welcome-after-add".to_string()),
            session_id: parent_session_id.to_string(),
            sender_identity_id: "human:remote-bob".to_string(),
            sender_role: "person".to_string(),
            message_kind: "text".to_string(),
            content_text: "Welcome after add".to_string(),
            content: Some(serde_json::json!({
                "sender": "Bob",
                "timeLabel": "13:27",
            })),
            created_at_ms: Some(10_001),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("complete".to_string()),
            source_transport: Some("desktop-bridge-session-message".to_string()),
            source_event_id: Some("desktop-bridge-session-message:welcome-after-add".to_string()),
        },
    )
    .expect("append message that arrived before invite");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("thefirsttestgroup".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some("session:group:root".to_string()),
        parent_session_participants: vec![
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:local-alice".to_string()),
                display_name: "Alice".to_string(),
                kind: None,
                role: Some("self".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_alice".to_string()),
                human_id: Some("kh_alice".to_string()),
                agent_id: None,
                runtime: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:remote-bob".to_string()),
                display_name: "Bob".to_string(),
                kind: None,
                role: Some("admin".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_bob".to_string()),
                human_id: Some("kh_bob".to_string()),
                agent_id: None,
                runtime: None,
            },
        ],
        parent_session_messages: vec![
            crate::bridge::DesktopBridgeSessionThreadMessage {
                role: "person".to_string(),
                sender: Some("Bob".to_string()),
                text: "Earlier question".to_string(),
                time_label: Some("13:04".to_string()),
                index: Some(0),
            },
            crate::bridge::DesktopBridgeSessionThreadMessage {
                role: "person".to_string(),
                sender: Some("Bob".to_string()),
                text: "Earlier reply".to_string(),
                time_label: Some("13:05".to_string()),
                index: Some(1),
            },
        ],
        initiator_identity: None,
        self_target_identity: None,
        permission_policy_hash: None,
        participant_graph_hash: None,
        parent_turn_id: None,
        parent_message_id: None,
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:bob:person".to_string()),
        bridge_request_id: Some("bridge_req_invite_history".to_string()),
        delivery_state: None,
        target_node_id: "kd_alice".to_string(),
        target_human_id: Some("kh_alice".to_string()),
        target_agent_id: None,
        target_display_name: "Alice".to_string(),
        target_owner_name: Some("Alice".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "You were added to thefirsttestgroup".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-invite".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 10_000,
        updated_at_ms: 10_000,
        completed_at_ms: Some(10_000),
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
        updated_at_ms: 10_001,
        updated_at_label: "13:27".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_invite_history".to_string(),
        direction: "inbound".to_string(),
        sender: Some("Bob".to_string()),
        text: "You were added to thefirsttestgroup".to_string(),
        time_label: "13:27".to_string(),
        timestamp_ms: 10_001,
        request_id: Some("bridge_req_invite_history".to_string()),
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
    .expect("sync inbound group invite with history");

    let texts: Vec<String> = conn
        .prepare(
            "SELECT content_text FROM session_messages
             WHERE session_id = ?1
             ORDER BY created_at_ms ASC",
        )
        .expect("prepare message query")
        .query_map(rusqlite::params![parent_session_id], |row| row.get(0))
        .expect("query messages")
        .collect::<Result<Vec<String>, _>>()
        .expect("collect messages");
    assert_eq!(
        texts,
        vec!["Earlier question", "Earlier reply", "Welcome after add"]
    );
    let active_participant_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE session_id = ?1 AND state = 'active'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("active participant count");
    assert_eq!(active_participant_count, 2);

    let session = select_session(&conn, parent_session_id)
        .expect("select session")
        .expect("session exists");
    assert_eq!(session.title, "thefirsttestgroup");
    assert_eq!(
        session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("customName"))
            .and_then(|value| value.as_str()),
        Some("thefirsttestgroup"),
    );
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
        parent_group_space_id: None,
        parent_session_participants: vec![
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:local-alice".to_string()),
                display_name: "Alice".to_string(),
                kind: None,
                role: Some("person".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_alice".to_string()),
                human_id: Some("kh_alice".to_string()),
                agent_id: None,
                runtime: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:remote-bob".to_string()),
                display_name: "Bob".to_string(),
                kind: None,
                role: Some("admin".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_bob".to_string()),
                human_id: Some("kh_bob".to_string()),
                agent_id: None,
                runtime: None,
            },
            crate::bridge::DesktopBridgeSessionParticipant {
                identity_id: Some("human:carol".to_string()),
                display_name: "Carol".to_string(),
                kind: None,
                role: Some("person".to_string()),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("kd_carol".to_string()),
                human_id: Some("kh_carol".to_string()),
                agent_id: None,
                runtime: None,
            },
        ],
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
        permission_policy_hash: None,
        participant_graph_hash: None,
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
