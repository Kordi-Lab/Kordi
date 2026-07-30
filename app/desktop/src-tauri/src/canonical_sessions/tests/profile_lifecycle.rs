use super::*;

#[test]
fn local_profile_remains_bound_to_an_initialized_connection_when_storage_root_changes() {
    let storage =
        crate::test_support::ScopedKordiStorageRoot::new("canonical-profile-connection-scope");
    let conn = test_conn();
    let original_human_id =
        local_profile_human_identity_id(&conn, "Original Profile").expect("local profile");
    let original_profile = schema::ensure_local_profile(&conn).expect("original profile");
    let changed_root = storage.root().join("changed-root");
    let changed_profile_id = stable_profile_id(&changed_root);
    conn.execute(
        "INSERT INTO local_profile(
             id, display_name, human_identity_id, active_agent_identity_id,
             storage_root, created_at_ms, updated_at_ms
         ) VALUES(?1, 'Raced Profile', NULL, NULL, ?2, ?3, ?3)",
        params![
            changed_profile_id,
            changed_root.display().to_string(),
            now_ms()
        ],
    )
    .expect("seed second profile left by the old environment race");

    std::env::set_var("KORDI_STORAGE_ROOT", &changed_root);

    let profile_after_change =
        schema::ensure_local_profile(&conn).expect("profile after process root change");
    assert_eq!(profile_after_change.id, original_profile.id);
    assert_eq!(
        profile_after_change.human_identity_id.as_deref(),
        Some(original_human_id.as_str())
    );
}

#[test]
fn cloud_profile_identity_adoption_clears_a_removed_profile_image_url() {
    let mut conn = test_conn();
    let with_avatar = adopt_cloud_profile_identity_in_db(
        &mut conn,
        AdoptCloudProfileIdentityRequest {
            account_id: "acct_avatar".to_string(),
            display_name: "Cloud Name".to_string(),
            avatar_key: Some("acct_avatar".to_string()),
            profile_image_url: Some("https://example.invalid/avatar.png".to_string()),
        },
    )
    .expect("adopt cloud profile with avatar");
    assert_eq!(
        with_avatar.identity.profile_image_url.as_deref(),
        Some("https://example.invalid/avatar.png")
    );

    let without_avatar = adopt_cloud_profile_identity_in_db(
        &mut conn,
        AdoptCloudProfileIdentityRequest {
            account_id: "acct_avatar".to_string(),
            display_name: "Cloud Name".to_string(),
            avatar_key: Some("acct_avatar".to_string()),
            profile_image_url: None,
        },
    )
    .expect("adopt cloud profile after avatar removal");

    assert_eq!(without_avatar.identity.profile_image_url, None);
    assert_eq!(
        select_identity(&conn, "human:acct_avatar")
            .expect("select adopted identity")
            .expect("adopted identity exists")
            .profile_image_url,
        None
    );
}

#[test]
fn cloud_group_open_keeps_local_profile_as_only_self_even_when_remote_created() {
    let conn = test_conn();
    let local_human_id = local_profile_human_identity_id(&conn, "You").expect("local profile");
    let remote_creator = seed_identity_with_source(
        &conn,
        "human:acct_remote_creator",
        "Remote Creator",
        "human",
        "bridge",
        None,
    );
    let remote_peer = seed_identity_with_source(
        &conn,
        "human:acct_remote_peer",
        "Remote Peer",
        "human",
        "bridge",
        None,
    );

    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:cloud-remote-created".to_string()),
            kind: "group".to_string(),
            title: Some("Cloud group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: remote_creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![local_human_id.clone(), remote_peer.id.clone()],
            metadata: Some(serde_json::json!({
                "createdFrom": "cloud-group-sync",
                "adminIdentityIds": [remote_creator.id.clone()],
                "initialContactIds": ["cloud:acct_remote_creator", "cloud:acct_remote_peer", "cloud:acct_local"]
            })),
        },
    )
    .expect("open replicated cloud group");

    let roles = conn
        .prepare(
            "SELECT identity_id, role FROM session_participants
             WHERE session_id = 'session:group:cloud-remote-created'
             ORDER BY identity_id",
        )
        .expect("prepare roles")
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query roles")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect roles");

    assert_eq!(
        roles.iter().filter(|(_, role)| role == "self").count(),
        1,
        "group must have exactly one self participant",
    );
    assert!(roles
        .iter()
        .any(|(identity_id, role)| identity_id == &local_human_id && role == "self"));
    assert!(roles
        .iter()
        .any(|(identity_id, role)| identity_id == &remote_creator.id && role == "admin"));
}
