use std::collections::HashSet;

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
fn message_scoped_outreach_groups_include_same_request_response_without_message_outreach() {
    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some("session:bridge:humans:test".to_string()),
        parent_session_title: Some("hello".to_string()),
        parent_session_kind: None,
        parent_group_space_id: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
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
    let storage =
        crate::test_support::ScopedKordiStorageRoot::new("kordi-direct-person-title-test");

    let session_id = "session:bridge:humans:stable-pair";
    let first_message_outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(session_id.to_string()),
        parent_session_title: None,
        parent_session_kind: None,
        parent_group_space_id: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
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
            human_visibility_policy: "server-approval".to_string(),
            contact_approval_policy: "approval-required".to_string(),
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
                human_visibility_policy: Some("server-approval".to_string()),
                contact_approval_policy: Some("approval-required".to_string()),
                agent_reachability_policy: Some("contacts".to_string()),
                is_contact: true,
                contact_request_status: Some("contact".to_string()),
                contact_request_direction: None,
            }],
            visible_peer_count: 1,
            projects: Vec::new(),
            contact_requests: Vec::new(),
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

    drop(storage);
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
        parent_group_space_id: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
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
fn direct_bridge_agent_response_preserves_task_tools_for_dashboard() {
    let conn = test_conn();
    for (id, kind, display_name, owner_identity_id, human_id, agent_id, node_id) in [
        (
            "human:local-user2",
            "human",
            "Kordi User 2",
            None,
            Some("kh_user2"),
            None,
            Some("kd_user2"),
        ),
        (
            "human:remote-user3",
            "human",
            "Kordi User 3",
            None,
            Some("kh_user3"),
            None,
            Some("kd_user3"),
        ),
        (
            "agent:remote-user3-kordi",
            "agent",
            "Kordi User 3's Kordi",
            Some("human:remote-user3"),
            None,
            Some("ka_user3"),
            Some("kd_user3"),
        ),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: kind.to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: owner_identity_id.map(ToString::to_string),
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: node_id.map(ToString::to_string),
                human_id: human_id.map(ToString::to_string),
                agent_id: agent_id.map(ToString::to_string),
                avatar_key: None,
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");
    }

    let parent_session_id = "session:bridge:humans:user2-user3";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "direct-person".to_string(),
            title: Some("Kordi User 3's Kordi".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local-user2".to_string(),
            primary_identity_id: Some("agent:remote-user3-kordi".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:remote-user3".to_string()),
            participant_identity_ids: vec!["agent:remote-user3-kordi".to_string()],
            metadata: Some(serde_json::json!({ "source": "desktop-bridge-conversation" })),
        },
    )
    .expect("open direct agent session");

    let tool = serde_json::json!({
        "id": "tool-task-operator",
        "name": "task_operator",
        "status": "done",
        "arguments": "{\"action\":\"create\",\"taskId\":\"finish_kordi_issue_317_review\",\"taskTitle\":\"Finish Kordi Issue 317 Review\",\"involvedParticipants\":[\"Kordi User 2\",\"Kordi User 3's Kordi\"]}",
        "resultText": "Task created: Finish Kordi Issue 317 Review",
        "isError": false
    });
    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Kordi User 3's Kordi".to_string()),
        parent_session_kind: None,
        parent_group_space_id: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: vec![crate::bridge::DesktopBridgeSessionThreadMessage {
            role: "assistant".to_string(),
            sender: Some("Kordi User 3's Kordi".to_string()),
            text: "Created the task: **Finish Kordi Issue 317 Review**".to_string(),
            time_label: Some("14:14".to_string()),
            index: None,
            tools: vec![tool],
        }],
        initiator_identity: None,
        self_target_identity: None,
        parent_turn_id: None,
        parent_message_id: Some("msg:ui:request-task".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:user3-agent".to_string()),
        bridge_request_id: Some("bridge_req_issue_317_task".to_string()),
        delivery_state: Some("responded".to_string()),
        target_node_id: "kd_user3".to_string(),
        target_human_id: Some("kh_user3".to_string()),
        target_agent_id: Some("ka_user3".to_string()),
        target_display_name: "Kordi User 3's Kordi".to_string(),
        target_owner_name: Some("Kordi User 3".to_string()),
        target_runtime: Some("kordi-desktop".to_string()),
        request_text: "create a task for issue 317".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("recent-window".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 2_000,
        completed_at_ms: Some(2_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:user3-agent".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_user3".to_string(),
        peer_display_name: Some("Kordi User 3's Kordi".to_string()),
        peer_owner_name: Some("Kordi User 3".to_string()),
        peer_runtime: "kordi-desktop".to_string(),
        project_id: None,
        project_name: None,
        title: "Kordi User 3's Kordi".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 2_001,
        updated_at_label: "14:14".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![
        crate::bridge::DesktopBridgeConversationMessage {
            id: "bridge_msg_request".to_string(),
            direction: "outbound".to_string(),
            sender: Some("Kordi User 2".to_string()),
            text: "@KordiUser3sKordi create a task for issue 317".to_string(),
            time_label: "14:13".to_string(),
            timestamp_ms: 1_000,
            request_id: Some("bridge_req_issue_317_task".to_string()),
            delivery_state: Some("responded".to_string()),
            outreach: Some(outreach.clone()),
            attachments: Vec::new(),
        },
        crate::bridge::DesktopBridgeConversationMessage {
            id: "bridge_msg_response".to_string(),
            direction: "inbound-response".to_string(),
            sender: Some("Kordi User 3's Kordi".to_string()),
            text: "Created the task: **Finish Kordi Issue 317 Review**".to_string(),
            time_label: "14:14".to_string(),
            timestamp_ms: 2_000,
            request_id: Some("bridge_req_issue_317_task".to_string()),
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
        "human:local-user2",
        None,
        Some("human:remote-user3"),
        "agent:remote-user3-kordi",
        true,
    )
    .expect("sync direct agent task response");

    let synced_tool_name: String = conn
        .query_row(
            "SELECT json_extract(content_json, '$.tools[0].name')
             FROM session_messages
             WHERE session_id = ?1
               AND message_kind = 'agent-turn'
               AND content_text LIKE 'Created the task:%'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("synced task tool name");
    assert_eq!(synced_tool_name, "task_operator");

    let synced_tool_arguments: String = conn
        .query_row(
            "SELECT json_extract(content_json, '$.tools[0].arguments')
             FROM session_messages
             WHERE session_id = ?1
               AND message_kind = 'agent-turn'
               AND content_text LIKE 'Created the task:%'",
            rusqlite::params![parent_session_id],
            |row| row.get(0),
        )
        .expect("synced task tool arguments");
    assert!(synced_tool_arguments.contains("Finish Kordi Issue 317 Review"));
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
        parent_group_space_id: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        initiator_identity: None,
        self_target_identity: None,
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
