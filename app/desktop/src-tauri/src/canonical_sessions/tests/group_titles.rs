use super::*;

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
fn opening_existing_group_session_preserves_group_name_when_title_is_not_manual() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:me", "Me", "human");
    let alice = seed_identity(&conn, "human:alice", "Alice", "human");
    let group = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:custom-name-preserve".to_string()),
            kind: "group".to_string(),
            title: Some("Original thread".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![alice.id.clone()],
            metadata: Some(serde_json::json!({
                "customName": "Good group",
                "groupId": "group-space:custom-name-preserve",
                "groupSpaceId": "group-space:custom-name-preserve"
            })),
        },
    )
    .expect("create group");

    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(group.id.clone()),
            kind: "group".to_string(),
            title: Some("New session".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![alice.id.clone()],
            metadata: Some(serde_json::json!({
                "groupId": "group-space:custom-name-preserve",
                "groupSpaceId": "group-space:custom-name-preserve"
            })),
        },
    )
    .expect("refresh group shell without custom name");

    let refreshed = select_session(&conn, &group.id)
        .expect("select refreshed")
        .expect("session exists");
    assert_eq!(refreshed.title, "New session");
    let metadata = refreshed.metadata.expect("metadata preserved");
    assert_eq!(metadata["customName"], "Good group");
}

#[test]
fn opening_existing_manual_group_session_preserves_session_title_and_group_name() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:me", "Me", "human");
    let alice = seed_identity(&conn, "human:alice", "Alice", "human");
    let group = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:manual-preserve".to_string()),
            kind: "group".to_string(),
            title: Some("Original thread".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![alice.id.clone()],
            metadata: Some(serde_json::json!({
                "customName": "Original group",
                "groupId": "group-space:manual-preserve",
                "groupSpaceId": "group-space:manual-preserve"
            })),
        },
    )
    .expect("create group");
    rename_session_in_db(&conn, &group.id, "Manual session title").expect("manual session rename");

    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(group.id.clone()),
            kind: "group".to_string(),
            title: Some("New session".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![alice.id.clone()],
            metadata: Some(serde_json::json!({
                "customName": null,
                "groupId": "group-space:manual-preserve",
                "groupSpaceId": "group-space:manual-preserve"
            })),
        },
    )
    .expect("refresh group shell");

    let refreshed = select_session(&conn, &group.id)
        .expect("select refreshed")
        .expect("session exists");
    assert_eq!(refreshed.title, "Manual session title");
    let metadata = refreshed.metadata.expect("metadata preserved");
    assert_eq!(metadata["customName"], "Original group");
    assert_eq!(metadata["sessionTitleSource"], "manual");
}

#[test]
fn canonical_group_session_title_rename_requires_group_admin() {
    let _storage =
        crate::test_support::ScopedKordiStorageRoot::new("group-session-title-non-admin");
    let conn = open_db().expect("open db");
    let creator = seed_identity(&conn, "human:acct_creator", "Me", "human");
    let alice = seed_identity(&conn, "human:alice", "Alice", "human");
    let group = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:non-admin-title".to_string()),
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
                "customName": "Me, Alice",
                "groupId": "session:group:non-admin-title",
                "groupSpaceId": "session:group:non-admin-title"
            })),
        },
    )
    .expect("create group");

    let error = commands::desktop_canonical_rename_session(RenameCanonicalSessionRequest {
        session_id: group.id.clone(),
        title: "Alice's thread title".to_string(),
        requested_by_identity_id: Some(alice.id.clone()),
    })
    .expect_err("non-admin participant cannot rename session title");
    assert!(error.contains("Only group admins can rename this group"));

    let state = commands::desktop_canonical_rename_session(RenameCanonicalSessionRequest {
        session_id: group.id.clone(),
        title: "Creator's thread title".to_string(),
        requested_by_identity_id: Some(creator.id.clone()),
    })
    .expect("group creator can rename session title");

    let renamed = state
        .sessions
        .iter()
        .find(|session| session.id == group.id)
        .expect("renamed session exists");
    assert_eq!(renamed.title, "Creator's thread title");
    let metadata = renamed.metadata.as_ref().expect("metadata preserved");
    assert_eq!(metadata["customName"], "Me, Alice");
    assert_eq!(metadata["sessionTitleSource"], "manual");
    assert_eq!(metadata["sessionTitleUpdatedByAccountId"], "acct_creator");
}
