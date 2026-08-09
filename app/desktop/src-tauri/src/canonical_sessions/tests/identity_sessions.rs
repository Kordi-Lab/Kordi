use super::*;

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
    assert!(identity.avatar_key.starts_with("local-agent:"));
    assert_eq!(
        identity
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("delegateAgentName"))
            .and_then(|value| value.as_str()),
        Some("Kordi"),
    );

    conn.execute(
        "UPDATE identities
         SET avatar_key = 'agent-avatar:chosen',
             profile_image_url = 'data:image/jpeg;base64,chosen'
         WHERE id = ?1",
        params![agent_identity_id],
    )
    .expect("assign agent avatar");
    let unrelated_agent = upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("agent:unrelated-local-agent".to_string()),
            kind: "agent".to_string(),
            display_name: "Another agent".to_string(),
            owner_identity_id: Some(human_identity_id.clone()),
            source: Some("local".to_string()),
            source_host_id: None,
            bridge_node_id: None,
            human_id: None,
            agent_id: Some("unrelated-local-agent".to_string()),
            avatar_key: Some("agent-avatar:unrelated".to_string()),
            profile_image_url: Some("data:image/jpeg;base64,unrelated".to_string()),
            metadata: Some(serde_json::json!({ "customAgent": true })),
        },
    )
    .expect("unrelated local agent");
    update_local_profile_identities(&conn, None, Some(&unrelated_agent.id), None)
        .expect("select unrelated local agent");
    let other_workspace_identity_id = local_agent_identity_id(
        &conn,
        &human_identity_id,
        "another-runtime-label",
        "/tmp/kordi/other-workspace",
    )
    .expect("other workspace identity");
    assert_ne!(agent_identity_id, other_workspace_identity_id);
    let other_workspace_identity = select_identity(&conn, &other_workspace_identity_id)
        .expect("select other workspace identity")
        .expect("other workspace identity exists");
    assert_eq!(other_workspace_identity.avatar_key, "agent-avatar:chosen");
    assert_eq!(
        other_workspace_identity.profile_image_url.as_deref(),
        Some("data:image/jpeg;base64,chosen"),
    );
}

#[test]
fn open_group_session_preserves_existing_fork_metadata_when_reopened_by_cloud_sync() {
    let conn = test_conn();
    let initial = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:fork:abc".to_string()),
            kind: "group".to_string(),
            title: Some("New session".to_string()),
            status: None,
            created_by_identity_id: "human:me".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:peer".to_string()],
            metadata: Some(serde_json::json!({
                "schemaVersion": 1,
                "kind": "chat-group",
                "groupId": "session:fork:abc",
                "groupSpaceId": "session:fork:abc",
                "createdFrom": "cloud-group-fork",
                "fork": {
                    "forkedFromSessionId": "session:group:source",
                    "forkedFromMessageId": "msg:source",
                    "forkMode": "cloud-group"
                }
            })),
        },
    )
    .expect("open fork group");
    assert_eq!(
        initial
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("fork"))
            .and_then(|fork| fork.get("forkedFromSessionId"))
            .and_then(|value| value.as_str()),
        Some("session:group:source")
    );

    let reopened = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:fork:abc".to_string()),
            kind: "group".to_string(),
            title: Some("New session".to_string()),
            status: None,
            created_by_identity_id: "human:me".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:peer".to_string()],
            metadata: Some(serde_json::json!({
                "schemaVersion": 1,
                "kind": "chat-group",
                "groupId": "session:fork:abc",
                "groupSpaceId": "session:fork:abc",
                "createdFrom": "cloud-group-sync"
            })),
        },
    )
    .expect("reopen fork group");

    let metadata = reopened.metadata.expect("metadata");
    assert_eq!(
        metadata
            .get("fork")
            .and_then(|fork| fork.get("forkedFromSessionId"))
            .and_then(|value| value.as_str()),
        Some("session:group:source")
    );
    assert_eq!(
        metadata
            .get("fork")
            .and_then(|fork| fork.get("forkedFromMessageId"))
            .and_then(|value| value.as_str()),
        Some("msg:source")
    );
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
