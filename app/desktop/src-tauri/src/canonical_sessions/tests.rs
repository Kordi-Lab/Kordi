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
    upsert_identity_in_db(
        conn,
        UpsertCanonicalIdentityRequest {
            id: Some(id.to_string()),
            kind: kind.to_string(),
            display_name: display_name.to_string(),
            owner_identity_id: None,
            source: Some("local".to_string()),
            source_host_id: None,
            bridge_node_id: None,
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

fn identity_context_role(
    identity_id: &str,
    display_name: &str,
    kind: &str,
    owner_identity_id: Option<&str>,
    owner_display_name: Option<&str>,
    locality: Option<&str>,
) -> IdentityContextRole {
    IdentityContextRole {
        identity_id: identity_id.to_string(),
        display_name: display_name.to_string(),
        kind: kind.to_string(),
        owner_identity_id: owner_identity_id.map(ToString::to_string),
        owner_display_name: owner_display_name.map(ToString::to_string),
        locality: locality.map(ToString::to_string),
    }
}

fn identity_context_participant(
    identity_id: &str,
    display_name: &str,
    kind: &str,
    role: &str,
    owner_identity_id: Option<&str>,
    owner_display_name: Option<&str>,
) -> IdentityContextParticipant {
    IdentityContextParticipant {
        identity_id: identity_id.to_string(),
        display_name: display_name.to_string(),
        kind: kind.to_string(),
        role: role.to_string(),
        owner_identity_id: owner_identity_id.map(ToString::to_string),
        owner_display_name: owner_display_name.map(ToString::to_string),
        bridge_node_id: None,
        human_id: kind
            .eq_ignore_ascii_case("human")
            .then(|| identity_id.trim_start_matches("human:").to_string()),
        agent_id: kind
            .eq_ignore_ascii_case("agent")
            .then(|| identity_id.trim_start_matches("agent:").to_string()),
        runtime: None,
        locality: Some("local".to_string()),
    }
}

fn alice_bob_identity_context_request() -> IdentityContextRequest {
    IdentityContextRequest {
        self_identity: identity_context_role(
            "agent:alice-kordi",
            "Alice's Kordi",
            "agent",
            Some("human:alice"),
            Some("Alice"),
            Some("local"),
        ),
        requester: Some(identity_context_role(
            "human:alice",
            "Alice",
            "human",
            None,
            None,
            Some("local"),
        )),
        target: Some(identity_context_role(
            "agent:bob-kordi",
            "Bob's Kordi",
            "agent",
            Some("human:bob"),
            Some("Bob"),
            Some("non-local"),
        )),
        participants: vec![
            identity_context_participant("human:bob", "Bob", "human", "participant", None, None),
            identity_context_participant(
                "agent:bob-kordi",
                "Bob's Kordi",
                "agent",
                "delegate",
                Some("human:bob"),
                Some("Bob"),
            ),
            identity_context_participant("human:alice", "Alice", "human", "requester", None, None),
            identity_context_participant(
                "agent:alice-kordi",
                "Alice's Kordi",
                "agent",
                "self",
                Some("human:alice"),
                Some("Alice"),
            ),
        ],
        permissions: IdentityContextPermissions {
            reply_as_identity_id: "agent:alice-kordi".to_string(),
            allowed_targets: vec!["agent:bob-kordi".to_string(), "human:bob".to_string()],
            reach_out_allowed: true,
            context_policy: "recent-window".to_string(),
            requires_approval: false,
        },
        session_id: Some("session:alice-bob".to_string()),
        session_kind: Some("group".to_string()),
        project_name: None,
    }
}

#[test]
fn identity_context_renders_versioned_frame_and_sorted_participants() {
    let request = alice_bob_identity_context_request();

    let rendered = render_multi_participant_identity_context(&request);

    for marker in [
        "<multi_participant_identity_context version=\"v1\">",
        "Current model/self:",
        "Requester / initiator:",
        "Current target:",
        "Session participants:",
        "Permissions:",
        "Rules:",
        "identityId: agent:alice-kordi",
        "owner: Alice (human:alice)",
        "replyAs: agent:alice-kordi only",
        "reachOut: allowed only for explicit non-local @Person/@Agent mentions in the current user message",
    ] {
        assert!(rendered.contains(marker), "missing marker {marker:?}\n{rendered}");
    }

    let alice_agent = rendered
        .find("- agent:alice-kordi | Alice's Kordi | agent")
        .unwrap();
    let bob_agent = rendered
        .find("- agent:bob-kordi | Bob's Kordi | agent")
        .unwrap();
    let alice_human = rendered.find("- human:alice | Alice | human").unwrap();
    let bob_human = rendered.find("- human:bob | Bob | human").unwrap();
    assert!(alice_agent < bob_agent);
    assert!(bob_agent < alice_human);
    assert!(alice_human < bob_human);
}

#[test]
fn identity_context_renders_denied_reach_out_policy() {
    let mut request = alice_bob_identity_context_request();
    request.permissions.allowed_targets = Vec::new();
    request.permissions.reach_out_allowed = false;

    let rendered = render_multi_participant_identity_context(&request);

    for marker in [
        "reachOut: disabled; ask the local user when a non-local target is ambiguous or not permitted",
        "allowedTargets: []",
        "mayImpersonate: none",
    ] {
        assert!(rendered.contains(marker), "missing marker {marker:?}\n{rendered}");
    }
}

mod desktop_sync;
mod direct_message_sync;
mod group_agent_requests;
mod group_agent_responses;
mod group_message_sync;

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
