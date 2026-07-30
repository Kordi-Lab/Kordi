use super::*;

#[test]
fn canonical_wire_uses_neutral_source_fields_and_reads_legacy_aliases() {
    let legacy_identity: UpsertCanonicalIdentityRequest =
        serde_json::from_value(serde_json::json!({
            "kind": "human",
            "displayName": "Legacy person",
            "bridgeNodeId": "legacy-node"
        }))
        .expect("deserialize legacy identity alias");
    assert_eq!(
        legacy_identity.bridge_node_id.as_deref(),
        Some("legacy-node")
    );

    let identity = CanonicalIdentity {
        id: "human:legacy".to_string(),
        kind: "human".to_string(),
        display_name: "Legacy person".to_string(),
        owner_identity_id: None,
        source: "cloud".to_string(),
        source_host_id: Some("cloud".to_string()),
        bridge_node_id: Some("acct_legacy".to_string()),
        human_id: Some("acct_legacy".to_string()),
        agent_id: None,
        avatar_key: "acct_legacy".to_string(),
        profile_image_url: None,
        metadata: None,
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    let identity_json = serde_json::to_value(identity).expect("serialize identity");
    assert_eq!(
        identity_json
            .get("sourceIdentityId")
            .and_then(serde_json::Value::as_str),
        Some("acct_legacy")
    );
    assert!(identity_json.get("bridgeNodeId").is_none());

    let legacy_exchange: CreateCanonicalDelegatedExchangeRequest =
        serde_json::from_value(serde_json::json!({
            "sessionId": "session:test",
            "initiatorIdentityId": "human:self",
            "targetIdentityId": "agent:remote",
            "bridgeHostId": "cloud",
            "bridgeConversationId": "legacy-conversation",
            "bridgeRequestId": "legacy-request"
        }))
        .expect("deserialize legacy exchange aliases");
    assert_eq!(legacy_exchange.bridge_host_id.as_deref(), Some("cloud"));
    assert_eq!(
        legacy_exchange.bridge_conversation_id.as_deref(),
        Some("legacy-conversation")
    );
    assert_eq!(
        legacy_exchange.bridge_request_id.as_deref(),
        Some("legacy-request")
    );

    let exchange = CanonicalDelegatedExchange {
        id: "exchange:test".to_string(),
        session_id: "session:test".to_string(),
        initiator_identity_id: "human:self".to_string(),
        target_identity_id: "agent:remote".to_string(),
        trigger_message_id: None,
        request_message_id: None,
        response_message_id: None,
        transport: "cloud".to_string(),
        bridge_host_id: Some("cloud".to_string()),
        bridge_conversation_id: Some("conversation:test".to_string()),
        bridge_request_id: Some("request:test".to_string()),
        context_policy: "last-message".to_string(),
        status: "pending".to_string(),
        error: None,
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    let exchange_json = serde_json::to_value(exchange).expect("serialize exchange");
    assert_eq!(
        exchange_json
            .get("sourceHostId")
            .and_then(serde_json::Value::as_str),
        Some("cloud")
    );
    assert_eq!(
        exchange_json
            .get("sourceConversationId")
            .and_then(serde_json::Value::as_str),
        Some("conversation:test")
    );
    assert_eq!(
        exchange_json
            .get("sourceRequestId")
            .and_then(serde_json::Value::as_str),
        Some("request:test")
    );
    assert!(exchange_json.get("bridgeHostId").is_none());
    assert!(exchange_json.get("bridgeConversationId").is_none());
    assert!(exchange_json.get("bridgeRequestId").is_none());
}

#[test]
fn source_identity_fallback_reuses_legacy_ids_and_creates_neutral_ids() {
    let conn = test_conn();
    let legacy = upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("human:bridge-node:legacy-node".to_string()),
            kind: "human".to_string(),
            display_name: "Legacy person".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: Some("legacy-host".to_string()),
            bridge_node_id: Some("legacy-node".to_string()),
            human_id: None,
            agent_id: None,
            avatar_key: None,
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("seed legacy identity");

    let reused = upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: None,
            kind: "human".to_string(),
            display_name: "Legacy person".to_string(),
            owner_identity_id: None,
            source: Some("cloud".to_string()),
            source_host_id: Some("cloud".to_string()),
            bridge_node_id: Some("legacy-node".to_string()),
            human_id: None,
            agent_id: None,
            avatar_key: None,
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("reuse legacy identity");
    assert_eq!(reused.id, legacy.id);

    let created = upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: None,
            kind: "human".to_string(),
            display_name: "New person".to_string(),
            owner_identity_id: None,
            source: Some("cloud".to_string()),
            source_host_id: Some("cloud".to_string()),
            bridge_node_id: Some("new-node".to_string()),
            human_id: None,
            agent_id: None,
            avatar_key: None,
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("create neutral identity");
    assert_eq!(created.id, "human:source:new-node");
}

#[test]
fn upsert_identity_preserves_existing_profile_image_when_update_has_none() {
    let conn = test_conn();
    let first = upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("human:cloud-acct".to_string()),
            kind: "human".to_string(),
            display_name: "Cloud Person".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: Some("cloud".to_string()),
            bridge_node_id: Some("acct_123".to_string()),
            human_id: Some("acct_123".to_string()),
            agent_id: None,
            avatar_key: Some("acct_123".to_string()),
            profile_image_url: Some("https://images.test/person.png".to_string()),
            metadata: None,
        },
    )
    .expect("insert identity with profile image");
    assert_eq!(
        first.profile_image_url.as_deref(),
        Some("https://images.test/person.png"),
    );

    let updated = upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("human:cloud-acct".to_string()),
            kind: "human".to_string(),
            display_name: "Cloud Person".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: Some("cloud".to_string()),
            bridge_node_id: Some("acct_123".to_string()),
            human_id: Some("acct_123".to_string()),
            agent_id: None,
            avatar_key: Some("acct_123".to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("update identity without profile image");

    assert_eq!(
        updated.profile_image_url.as_deref(),
        Some("https://images.test/person.png"),
    );
}

#[test]
fn identity_context_renderer_preserves_people_agents_and_permissions() {
    let rendered = render_multi_participant_identity_context(&IdentityContextRequest {
        self_identity: IdentityContextRole {
            identity_id: "agent:alice-kordi".to_string(),
            display_name: "Alice's Kordi".to_string(),
            kind: "agent".to_string(),
            owner_identity_id: Some("human:alice".to_string()),
            owner_display_name: Some("Alice".to_string()),
            locality: Some("local".to_string()),
        },
        requester: Some(IdentityContextRole {
            identity_id: "human:alice".to_string(),
            display_name: "Alice".to_string(),
            kind: "human".to_string(),
            owner_identity_id: None,
            owner_display_name: None,
            locality: Some("local".to_string()),
        }),
        target: Some(IdentityContextRole {
            identity_id: "agent:bob-kordi".to_string(),
            display_name: "Bob's Kordi".to_string(),
            kind: "agent".to_string(),
            owner_identity_id: Some("human:bob".to_string()),
            owner_display_name: Some("Bob".to_string()),
            locality: Some("non-local".to_string()),
        }),
        participants: vec![
            IdentityContextParticipant {
                identity_id: "human:bob".to_string(),
                display_name: "Bob".to_string(),
                kind: "human".to_string(),
                role: "member".to_string(),
                owner_identity_id: None,
                owner_display_name: None,
                bridge_node_id: Some("bob-node".to_string()),
                human_id: Some("bob".to_string()),
                agent_id: None,
                runtime: Some("person".to_string()),
                locality: Some("non-local".to_string()),
            },
            IdentityContextParticipant {
                identity_id: "agent:bob-kordi".to_string(),
                display_name: "Bob's Kordi".to_string(),
                kind: "agent".to_string(),
                role: "delegate".to_string(),
                owner_identity_id: Some("human:bob".to_string()),
                owner_display_name: Some("Bob".to_string()),
                bridge_node_id: Some("bob-agent-node".to_string()),
                human_id: None,
                agent_id: Some("bob-kordi".to_string()),
                runtime: Some("kordi-desktop".to_string()),
                locality: Some("non-local".to_string()),
            },
        ],
        permissions: IdentityContextPermissions {
            reply_as_identity_id: "agent:alice-kordi".to_string(),
            context_policy: "recent-window".to_string(),
            requires_approval: false,
        },
        session_id: Some("session:alice-bob".to_string()),
        session_kind: Some("group".to_string()),
        project_name: None,
    });

    assert!(rendered.contains("<multi_participant_identity_context version=\"v1\">"));
    assert!(rendered.contains("- replyAs: agent:alice-kordi only"));
    assert!(rendered.contains("Requester / initiator:"));
    assert!(rendered.contains("Current target:"));
    assert!(rendered.contains("agent:bob-kordi | Bob's Kordi | agent"));
    assert!(rendered.contains("owner: Bob (human:bob)"));
}
