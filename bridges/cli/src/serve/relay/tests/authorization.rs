//! Direct-relay authorization, reachability, and owner-agent policy scenarios.

use super::*;

#[tokio::test]
async fn direct_relay_allows_server_open_target_without_contact() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node(&state, "sender", "sender-key");
    seed_registered_node_with_policy(
        &state,
        "receiver",
        "receiver-key",
        RegisteredNodePolicy::human(
            "human-receiver",
            "server-open",
            "approval-required",
            "contacts",
        ),
    );

    let response = relay_message(
        State(state.clone()),
        Extension(AuthNode("sender".to_string())),
        Json(RelayReq {
            target_node_id: "receiver".to_string(),
            blob: "hello".to_string(),
            project_id: None,
            target_kind: Some("person".to_string()),
            client_message_id: None,
        }),
    )
    .await
    .unwrap()
    .0;

    assert!(response.delivered);
    let pending = poll_mailbox_v2(
        State(state),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(100),
            after: None,
        }),
    )
    .await
    .expect("poll mailbox")
    .0;
    assert_eq!(pending.entries.len(), 1);
    assert_eq!(pending.entries[0].from, "sender");
}

#[tokio::test]
async fn direct_relay_blocks_approval_required_target_without_contact() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node(&state, "sender", "sender-key");
    seed_registered_node_with_policy(
        &state,
        "receiver",
        "receiver-key",
        RegisteredNodePolicy::human(
            "human-receiver",
            "server-approval",
            "approval-required",
            "contacts",
        ),
    );

    let status = relay_message(
        State(state),
        Extension(AuthNode("sender".to_string())),
        Json(RelayReq {
            target_node_id: "receiver".to_string(),
            blob: "hello".to_string(),
            project_id: None,
            target_kind: Some("person".to_string()),
            client_message_id: None,
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn direct_relay_blocks_approval_required_target_when_only_shared_project() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node(&state, "sender", "sender-key");
    seed_registered_node_with_policy(
        &state,
        "receiver",
        "receiver-key",
        RegisteredNodePolicy::human(
            "human-receiver",
            "server-approval",
            "approval-required",
            "contacts",
        ),
    );
    seed_project_members(&state, "project-1", &["sender", "receiver"]);

    let status = relay_message(
        State(state),
        Extension(AuthNode("sender".to_string())),
        Json(RelayReq {
            target_node_id: "receiver".to_string(),
            blob: "hello".to_string(),
            project_id: None,
            target_kind: Some("person".to_string()),
            client_message_id: None,
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn direct_relay_allows_session_participant_without_contact() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node(&state, "sender", "sender-key");
    seed_registered_node_with_policy(
        &state,
        "receiver",
        "receiver-key",
        RegisteredNodePolicy::human(
            "human-receiver",
            "server-approval",
            "approval-required",
            "contacts",
        ),
    );

    let response = relay_message(
        State(state.clone()),
        Extension(AuthNode("sender".to_string())),
        Json(RelayReq {
            target_node_id: "receiver".to_string(),
            blob: "group session message".to_string(),
            project_id: None,
            target_kind: Some("session-participant".to_string()),
            client_message_id: None,
        }),
    )
    .await
    .unwrap()
    .0;

    assert!(response.delivered);
    let pending = poll_mailbox_v2(
        State(state),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(100),
            after: None,
        }),
    )
    .await
    .expect("poll mailbox")
    .0;
    assert_eq!(pending.entries.len(), 1);
    assert_eq!(pending.entries[0].blob, "group session message");
}

#[tokio::test]
async fn direct_relay_blocks_group_invite_to_server_open_non_contact() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node(&state, "sender", "sender-key");
    seed_registered_node_with_policy(
        &state,
        "receiver",
        "receiver-key",
        RegisteredNodePolicy::human("human-receiver", "server-open", "auto", "contacts"),
    );

    let status = relay_message(
        State(state),
        Extension(AuthNode("sender".to_string())),
        Json(RelayReq {
            target_node_id: "receiver".to_string(),
            blob: "invite".to_string(),
            project_id: None,
            target_kind: Some("person-invite".to_string()),
            client_message_id: None,
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn direct_relay_owner_agent_allows_same_human_and_blocks_other_humans() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node_with_policy(
        &state,
        "owner-device",
        "owner-key",
        RegisteredNodePolicy::human("human-owner", "private", "approval-required", "contacts"),
    );
    seed_registered_node_with_policy(
        &state,
        "owner-agent",
        "agent-key",
        RegisteredNodePolicy::agent("human-owner", "agent-owner", "owner"),
    );
    seed_registered_node_with_policy(
        &state,
        "stranger",
        "stranger-key",
        RegisteredNodePolicy::human("human-stranger", "private", "approval-required", "contacts"),
    );

    let accepted = relay_message(
        State(state.clone()),
        Extension(AuthNode("owner-device".to_string())),
        Json(RelayReq {
            target_node_id: "owner-agent".to_string(),
            blob: "ask".to_string(),
            project_id: None,
            target_kind: Some("agent".to_string()),
            client_message_id: None,
        }),
    )
    .await
    .expect("owner relay accepted")
    .0;
    assert!(accepted.delivered);

    let rejected = relay_message(
        State(state),
        Extension(AuthNode("stranger".to_string())),
        Json(RelayReq {
            target_node_id: "owner-agent".to_string(),
            blob: "ask".to_string(),
            project_id: None,
            target_kind: Some("agent".to_string()),
            client_message_id: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(rejected, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn direct_relay_owner_agent_blocks_contacts_from_other_humans() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node_with_policy(
        &state,
        "contact",
        "contact-key",
        RegisteredNodePolicy::human("human-contact", "private", "approval-required", "contacts"),
    );
    seed_registered_node_with_policy(
        &state,
        "owner-agent",
        "agent-key",
        RegisteredNodePolicy::agent("human-owner", "agent-owner", "owner"),
    );
    seed_contact(&state, "contact", "owner-agent");

    let rejected = relay_message(
        State(state),
        Extension(AuthNode("contact".to_string())),
        Json(RelayReq {
            target_node_id: "owner-agent".to_string(),
            blob: "ask".to_string(),
            project_id: None,
            target_kind: Some("agent".to_string()),
            client_message_id: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(rejected, StatusCode::FORBIDDEN);
}
