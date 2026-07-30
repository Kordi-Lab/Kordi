use super::*;

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
fn self_agent_title_reconciliation_marks_new_auto_titles_and_preserves_legacy_titles() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:title-policy", "Me", "human");
    let agent = seed_identity(&conn, "agent:title-policy", "Kordi", "agent");
    let request = |id: &str, title: &str| OpenCanonicalSessionRequest {
        id: Some(id.to_string()),
        kind: "self-agent".to_string(),
        title: Some(title.to_string()),
        status: Some("active".to_string()),
        created_by_identity_id: creator.id.clone(),
        primary_identity_id: Some(agent.id.clone()),
        project_id: None,
        project_name: None,
        relationship_identity_id: None,
        participant_identity_ids: vec![agent.id.clone()],
        metadata: Some(serde_json::json!({ "source": "test" })),
    };

    let automatic = open_or_create_session_in_db(
        &conn,
        request("session:self-agent:new-auto", "Release readiness review"),
    )
    .expect("create automatic title");
    assert_eq!(
        automatic
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("sessionTitleSource"))
            .and_then(|value| value.as_str()),
        Some("auto")
    );

    open_or_create_session_in_db(
        &conn,
        request("session:self-agent:legacy", "Verified legacy title"),
    )
    .expect("create legacy fixture");
    conn.execute(
        "UPDATE sessions SET metadata_json = '{}' WHERE id = 'session:self-agent:legacy'",
        [],
    )
    .expect("simulate pre-policy metadata");
    open_or_create_session_in_db(
        &conn,
        request("session:self-agent:legacy", "Replacement automatic title"),
    )
    .expect("reconcile legacy title");
    let legacy = select_session(&conn, "session:self-agent:legacy")
        .expect("read legacy session")
        .expect("legacy session exists");
    assert_eq!(legacy.title, "Verified legacy title");
    assert_eq!(
        legacy
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("sessionTitleSource"))
            .and_then(|value| value.as_str()),
        Some("legacy")
    );

    open_or_create_session_in_db(
        &conn,
        request(
            "session:self-agent:known-legacy-auto",
            "which model are you",
        ),
    )
    .expect("create known legacy automatic fixture");
    conn.execute(
        "UPDATE sessions
         SET title = 'which model are you',
             metadata_json = '{\"sessionTitleSource\":\"legacy\",\"titleSource\":\"legacy\",\"sessionTitleRevision\":1}'
         WHERE id = 'session:self-agent:known-legacy-auto'",
        [],
    )
    .expect("simulate migrated known automatic title");
    let mut mapped_request = request("session:self-agent:known-legacy-auto", "Model and identity");
    mapped_request.metadata = Some(serde_json::json!({
        "sessionTitleSource": "auto",
        "titleSource": "auto",
        "sessionTitleRevision": 1,
        "sessionTitlePolicyVersion": 1,
        "sessionTitleUpdatedAtMs": 10,
    }));
    let mapped = open_or_create_session_in_db(&conn, mapped_request)
        .expect("backfill known legacy automatic title");
    assert_eq!(mapped.title, "Model and identity");
    assert_eq!(
        mapped
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("sessionTitleSource"))
            .and_then(|value| value.as_str()),
        Some("auto")
    );
}

#[test]
fn cloud_title_actor_tie_break_converges_and_local_rename_clears_remote_actor() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:title-conflict", "Me", "human");
    let agent = seed_identity(&conn, "agent:title-conflict", "Kordi", "agent");
    let request = |title: &str, metadata: serde_json::Value| OpenCanonicalSessionRequest {
        id: Some("session:self-agent:title-conflict".to_string()),
        kind: "self-agent".to_string(),
        title: Some(title.to_string()),
        status: Some("active".to_string()),
        created_by_identity_id: creator.id.clone(),
        primary_identity_id: Some(agent.id.clone()),
        project_id: None,
        project_name: None,
        relationship_identity_id: None,
        participant_identity_ids: vec![agent.id.clone()],
        metadata: Some(metadata),
    };

    open_or_create_session_in_db(
        &conn,
        request(
            "Unsynchronized equal-time edit",
            serde_json::json!({
                "sessionTitleSource": "manual",
                "titleSource": "manual",
                "sessionTitleRevision": 3,
                "sessionTitlePolicyVersion": 1,
                "sessionTitleUpdatedAtMs": 300,
            }),
        ),
    )
    .expect("create local title");

    let resolved = open_or_create_session_in_db(
        &conn,
        request(
            "Server-selected title",
            serde_json::json!({
                "sessionTitleSource": "manual",
                "titleSource": "manual",
                "sessionTitleRevision": 3,
                "sessionTitlePolicyVersion": 1,
                "sessionTitleUpdatedAtMs": 300,
                "sessionTitleUpdatedByAccountId": "acct_server",
            }),
        ),
    )
    .expect("apply server-selected title");
    assert_eq!(resolved.title, "Server-selected title");
    assert_eq!(
        resolved
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("sessionTitleUpdatedByAccountId"))
            .and_then(|value| value.as_str()),
        Some("acct_server")
    );

    rename_any_session_title_in_db(&conn, &resolved.id, "New local title").expect("rename locally");
    let renamed = select_session(&conn, &resolved.id)
        .expect("read renamed session")
        .expect("renamed session exists");
    assert_eq!(renamed.title, "New local title");
    assert!(renamed
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("sessionTitleUpdatedByAccountId"))
        .is_none());
}
