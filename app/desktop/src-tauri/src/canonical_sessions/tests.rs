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
    seed_identity_with_source(conn, id, display_name, kind, "local", None)
}

fn seed_identity_with_source(
    conn: &Connection,
    id: &str,
    display_name: &str,
    kind: &str,
    source: &str,
    owner_identity_id: Option<&str>,
) -> CanonicalIdentity {
    upsert_identity_in_db(
        conn,
        UpsertCanonicalIdentityRequest {
            id: Some(id.to_string()),
            kind: kind.to_string(),
            display_name: display_name.to_string(),
            owner_identity_id: owner_identity_id.map(ToString::to_string),
            source: Some(source.to_string()),
            source_host_id: source
                .eq_ignore_ascii_case("bridge")
                .then(|| "bridge-host".to_string()),
            bridge_node_id: source
                .eq_ignore_ascii_case("bridge")
                .then(|| format!("node-{}", id.replace(':', "-"))),
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

mod desktop_sync;
mod direct_message_sync;
mod group_agent_requests;
mod group_agent_responses;
mod group_message_sync;

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
            allowed_targets: vec!["agent:bob-kordi".to_string()],
            reach_out_allowed: true,
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
    assert!(rendered.contains("allowedTargets: [\"agent:bob-kordi\"]"));
}

#[test]
fn bridge_agent_prompt_includes_inline_identity_frame_for_parent_session() {
    let storage = crate::test_support::ScopedKordiStorageRoot::new("identity-context-prompt");
    let conn = open_db().expect("open db");
    seed_identity_with_source(&conn, "human:alice", "Alice", "human", "local", None);
    seed_identity_with_source(
        &conn,
        "agent:alice-kordi",
        "Alice's Kordi",
        "agent",
        "local",
        Some("human:alice"),
    );
    seed_identity_with_source(&conn, "human:bob", "Bob", "human", "bridge", None);
    seed_identity_with_source(
        &conn,
        "agent:bob-kordi",
        "Bob's Kordi",
        "agent",
        "bridge",
        Some("human:bob"),
    );
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:alice-bob".to_string()),
            kind: "group".to_string(),
            title: Some("Alice and Bob".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:alice".to_string(),
            primary_identity_id: Some("agent:alice-kordi".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![
                "human:alice".to_string(),
                "agent:alice-kordi".to_string(),
                "human:bob".to_string(),
                "agent:bob-kordi".to_string(),
            ],
            metadata: None,
        },
    )
    .expect("seed group session");
    drop(conn);

    let prompt = bridge_agent_parent_session_prompt(
        Some("session:alice-bob"),
        "Bob's Kordi",
        Some("Bob"),
        "Can you review this?",
        None,
    )
    .expect("prompt");

    assert!(prompt.contains("<multi_participant_identity_context version=\"v1\">"));
    assert!(prompt.contains("- replyAs: agent:bob-kordi only"));
    assert!(prompt.contains("- identityId: human:alice"));
    assert!(prompt.contains("agent:bob-kordi | Bob's Kordi | agent"));
    assert!(prompt
        .contains("If the request asks you to create, manage, persist, search, or close a task"));
    assert!(prompt.contains("use task_operator"));
    assert!(prompt.contains("action=create"));
    assert!(prompt.contains("action=search"));
    assert!(prompt.contains("action=close"));
    assert!(prompt.contains("involvedParticipants"));
    assert!(!prompt.contains("taskTarget"));
    assert!(!prompt.contains("right task panel"));
    assert!(!prompt.contains("Session identity file:"));
    drop(storage);
}

#[test]
fn shared_agent_display_name_keeps_already_scoped_remote_agent_name() {
    let conn = test_conn();
    upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("human:remote".to_string()),
            kind: "human".to_string(),
            display_name: "Me".to_string(),
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: Some("bridge-host".to_string()),
            bridge_node_id: Some("kd_remote".to_string()),
            human_id: Some("kh_remote".to_string()),
            agent_id: None,
            avatar_key: Some("kh_remote".to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("seed remote human");
    let agent = upsert_identity_in_db(
        &conn,
        UpsertCanonicalIdentityRequest {
            id: Some("agent:remote".to_string()),
            kind: "agent".to_string(),
            display_name: "Testuser2's Kordi".to_string(),
            owner_identity_id: Some("human:remote".to_string()),
            source: Some("bridge".to_string()),
            source_host_id: Some("bridge-host".to_string()),
            bridge_node_id: Some("kd_remote".to_string()),
            human_id: Some("kh_remote".to_string()),
            agent_id: Some("ka_remote".to_string()),
            avatar_key: Some("ka_remote".to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("seed remote agent");

    assert_eq!(
        shared_agent_display_name(&conn, &agent.id).expect("shared agent label"),
        Some("Testuser2's Kordi".to_string())
    );
}

#[test]
fn renaming_non_group_session_marks_title_as_manual_metadata() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:me", "Me", "human");
    let alice = seed_identity(&conn, "human:alice", "Alice", "human");
    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:direct-person:rename-test".to_string()),
            kind: "direct-person".to_string(),
            title: Some("Alice".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: Some(alice.id.clone()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some(alice.id.clone()),
            participant_identity_ids: vec![alice.id.clone()],
            metadata: Some(serde_json::json!({
                "createdFrom": "chat-create-flow",
                "subtitle": "old preview",
            })),
        },
    )
    .expect("create direct session");

    rename_any_session_title_in_db(&conn, &session.id, "Renamed lunch thread")
        .expect("rename session");

    let renamed = select_session(&conn, &session.id)
        .expect("select renamed session")
        .expect("renamed session exists");
    assert_eq!(renamed.title, "Renamed lunch thread");
    let metadata = renamed.metadata.expect("metadata preserved");
    assert_eq!(
        metadata.get("titleSource").and_then(|value| value.as_str()),
        Some("manual")
    );
    assert_eq!(
        metadata
            .get("sessionTitleSource")
            .and_then(|value| value.as_str()),
        Some("manual")
    );
    assert_eq!(
        metadata.get("createdFrom").and_then(|value| value.as_str()),
        Some("chat-create-flow")
    );
    assert_eq!(
        metadata.get("subtitle").and_then(|value| value.as_str()),
        Some("old preview")
    );
}

#[test]
fn manual_title_metadata_survives_session_shell_upsert() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:me", "Me", "human");
    let agent = seed_identity(&conn, "agent:local", "Kordi", "agent");
    let session = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:self-agent:rename-test".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Initial prompt title".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: Some(agent.id.clone()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![agent.id.clone()],
            metadata: Some(serde_json::json!({ "source": "desktop-chat-summary" })),
        },
    )
    .expect("create self-agent session");
    rename_any_session_title_in_db(&conn, &session.id, "Renamed runtime thread")
        .expect("rename session");

    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(session.id.clone()),
            kind: "self-agent".to_string(),
            title: Some("Renamed runtime thread".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: Some(agent.id.clone()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![agent.id.clone()],
            metadata: Some(serde_json::json!({
                "source": "desktop-chat-detail",
                "messageCount": 2,
            })),
        },
    )
    .expect("upsert refreshed shell");

    let refreshed = select_session(&conn, &session.id)
        .expect("select refreshed session")
        .expect("refreshed session exists");
    assert_eq!(refreshed.title, "Renamed runtime thread");
    let metadata = refreshed.metadata.expect("metadata preserved");
    assert_eq!(
        metadata.get("titleSource").and_then(|value| value.as_str()),
        Some("manual")
    );
    assert_eq!(
        metadata
            .get("sessionTitleSource")
            .and_then(|value| value.as_str()),
        Some("manual")
    );
    assert_eq!(
        metadata.get("source").and_then(|value| value.as_str()),
        Some("desktop-chat-detail")
    );
    assert_eq!(
        metadata
            .get("messageCount")
            .and_then(|value| value.as_i64()),
        Some(2)
    );
}

#[test]
fn renaming_group_session_preserves_group_name_as_separate_metadata() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:me", "Me", "human");
    let alice = seed_identity(&conn, "human:alice", "Alice", "human");
    let group = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:rename-test".to_string()),
            kind: "group".to_string(),
            title: Some("First group thread".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![alice.id.clone()],
            metadata: Some(serde_json::json!({
                "adminIdentityIds": [creator.id.clone()],
                "customName": "Alice group",
                "groupNameUpdatedAtMs": 12_345,
                "groupId": "session:group:rename-test",
                "groupSpaceId": "session:group:rename-test"
            })),
        },
    )
    .expect("create group");

    rename_session_in_db(&conn, &group.id, "Renamed thread").expect("rename group session");

    let renamed = select_session(&conn, &group.id)
        .expect("select renamed group")
        .expect("renamed group exists");
    assert_eq!(renamed.title, "Renamed thread");
    let metadata = renamed.metadata.expect("metadata preserved");
    assert_eq!(
        metadata.get("titleSource").and_then(|value| value.as_str()),
        Some("manual")
    );
    assert_eq!(
        metadata
            .get("sessionTitleSource")
            .and_then(|value| value.as_str()),
        Some("manual")
    );
    assert_eq!(
        metadata.get("customName").and_then(|value| value.as_str()),
        Some("Alice group")
    );
    assert_eq!(
        metadata.get("groupId").and_then(|value| value.as_str()),
        Some("session:group:rename-test")
    );
    assert_eq!(
        metadata
            .get("groupSpaceId")
            .and_then(|value| value.as_str()),
        Some("session:group:rename-test")
    );
    assert_eq!(
        metadata
            .get("groupNameUpdatedAtMs")
            .and_then(|value| value.as_i64()),
        Some(12_345)
    );

    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(group.id.clone()),
            kind: "group".to_string(),
            title: Some("Renamed thread".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![alice.id.clone()],
            metadata: Some(serde_json::json!({
                "source": "desktop-chat-detail",
                "customName": "Alice group",
                "groupId": "session:group:rename-test",
                "groupSpaceId": "session:group:rename-test"
            })),
        },
    )
    .expect("upsert refreshed group shell");

    let refreshed = select_session(&conn, &group.id)
        .expect("select refreshed group")
        .expect("refreshed group exists");
    let refreshed_metadata = refreshed.metadata.expect("refreshed metadata preserved");
    assert_eq!(
        refreshed_metadata
            .get("groupNameUpdatedAtMs")
            .and_then(|value| value.as_i64()),
        Some(12_345)
    );
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
