use super::*;

#[test]
fn cloud_profile_identity_adoption_migrates_local_self_to_stable_account_id() {
    let mut conn = test_conn();
    let old_local_human_id =
        local_profile_human_identity_id(&conn, "Old Device Name").expect("local profile");
    seed_identity(&conn, "agent:old-local", "Kordi", "agent");
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:local-before-cloud".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Local before cloud".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: old_local_human_id.clone(),
            primary_identity_id: Some("agent:old-local".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:old-local".to_string()],
            metadata: Some(serde_json::json!({ "adminIdentityIds": [old_local_human_id.clone()] })),
        },
    )
    .expect("create local session");
    let migrated_participant_metadata = serde_json::json!({
        "identityId": old_local_human_id.clone(),
        "partial": format!("prefix:{old_local_human_id}"),
    });
    let updated_migrated_participant = conn
        .execute(
            "UPDATE session_participants
             SET role = 'person', state = 'left', added_by_identity_id = ?1, added_at_ms = 41,
                 last_seen_at_ms = 51, last_read_message_id = 'msg:migrated-read', metadata_json = ?2
             WHERE session_id = 'session:local-before-cloud' AND identity_id = ?1",
            params![
                old_local_human_id.as_str(),
                migrated_participant_metadata.to_string()
            ],
        )
        .expect("seed migrated-only participant fields");
    assert_eq!(updated_migrated_participant, 1);
    seed_identity_with_source(
        &conn,
        "human:acct_same",
        "Cloud Name",
        "human",
        "bridge",
        None,
    );
    let remote = seed_identity_with_source(
        &conn,
        "human:acct_remote",
        "Remote",
        "human",
        "bridge",
        None,
    );
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:arrived-before-adoption".to_string()),
            kind: "group".to_string(),
            title: Some("Remote group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: remote.id,
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:acct_same".to_string()],
            metadata: Some(serde_json::json!({ "createdFrom": "cloud-group-sync" })),
        },
    )
    .expect("create pre-adoption cloud group");
    upsert_participant(
        &conn,
        "session:group:arrived-before-adoption",
        &old_local_human_id,
        "admin",
        Some(&old_local_human_id),
        42,
    )
    .expect("seed old participant collision");
    let collision_participant_metadata = serde_json::json!({
        "identityId": old_local_human_id.clone(),
        "source": "stable",
    });
    let updated_collision_participant = conn
        .execute(
            "UPDATE session_participants
             SET role = 'person', state = 'left', added_by_identity_id = 'human:acct_remote', added_at_ms = 43,
                 last_seen_at_ms = 53, last_read_message_id = 'msg:collision-read', metadata_json = ?1
             WHERE session_id = 'session:group:arrived-before-adoption' AND identity_id = 'human:acct_same'",
            params![collision_participant_metadata.to_string()],
        )
        .expect("seed stable collision participant fields");
    assert_eq!(updated_collision_participant, 1);
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:old-local-user".to_string()),
            session_id: "session:local-before-cloud".to_string(),
            sender_identity_id: old_local_human_id.clone(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "hello before cloud".to_string(),
            content: None,
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            created_at_ms: Some(1),
            source_transport: Some("desktop-chat-ui".to_string()),
            source_event_id: Some("old-local-user".to_string()),
        },
    )
    .expect("append old local message");

    let delta = adopt_cloud_profile_identity_in_db(
        &mut conn,
        AdoptCloudProfileIdentityRequest {
            account_id: "acct_same".to_string(),
            display_name: "Cloud Name".to_string(),
            avatar_key: Some("acct_same".to_string()),
            profile_image_url: Some("https://example.invalid/avatar.png".to_string()),
        },
    )
    .expect("adopt cloud profile");

    assert_eq!(
        delta.previous_identity_id.as_deref(),
        Some(old_local_human_id.as_str())
    );
    assert_eq!(delta.identity.id, "human:acct_same");
    assert_eq!(
        delta.profile.human_identity_id.as_deref(),
        Some("human:acct_same")
    );
    assert_eq!(
        delta.group_self_session_ids,
        vec!["session:group:arrived-before-adoption".to_string()]
    );
    let delta_json = serde_json::to_value(&delta).expect("serialize identity delta");
    assert_eq!(
        delta_json
            .as_object()
            .expect("delta object")
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        [
            "groupSelfSessionIds",
            "identity",
            "previousIdentityId",
            "profile",
        ]
        .into_iter()
        .map(ToString::to_string)
        .collect()
    );

    let profile = schema::ensure_local_profile(&conn).expect("profile");
    assert_eq!(
        profile.human_identity_id.as_deref(),
        Some("human:acct_same")
    );
    assert_eq!(profile.display_name.as_deref(), Some("Cloud Name"));

    let migrated_participant = conn
        .query_row(
            "SELECT role, state, added_by_identity_id, added_at_ms, last_seen_at_ms, last_read_message_id, metadata_json
             FROM session_participants
             WHERE session_id = 'session:local-before-cloud' AND identity_id = 'human:acct_same'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .expect("migrated participant");
    assert_eq!(migrated_participant.0, "self");
    assert_eq!(migrated_participant.1, "active");
    assert_eq!(migrated_participant.2.as_deref(), Some("human:acct_same"));
    assert_eq!(migrated_participant.3, 41);
    assert_eq!(migrated_participant.4, Some(51));
    assert_eq!(migrated_participant.5.as_deref(), Some("msg:migrated-read"));
    assert_eq!(
        migrated_participant
            .6
            .as_deref()
            .map(serde_json::from_str::<serde_json::Value>)
            .transpose()
            .expect("migrated metadata json"),
        Some(serde_json::json!({
            "identityId": "human:acct_same",
            "partial": format!("prefix:{old_local_human_id}"),
        }))
    );

    let collision_participant = conn
        .query_row(
            "SELECT role, state, added_by_identity_id, added_at_ms, last_seen_at_ms, last_read_message_id, metadata_json
             FROM session_participants
             WHERE session_id = 'session:group:arrived-before-adoption' AND identity_id = 'human:acct_same'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .expect("collision participant");
    assert_eq!(collision_participant.0, "self");
    assert_eq!(collision_participant.1, "active");
    assert_eq!(
        collision_participant.2.as_deref(),
        Some("human:acct_remote")
    );
    assert_eq!(collision_participant.3, 43);
    assert_eq!(collision_participant.4, Some(53));
    assert_eq!(
        collision_participant.5.as_deref(),
        Some("msg:collision-read")
    );
    assert_eq!(
        collision_participant
            .6
            .as_deref()
            .map(serde_json::from_str::<serde_json::Value>)
            .transpose()
            .expect("collision metadata json"),
        Some(serde_json::json!({
            "identityId": "human:acct_same",
            "source": "stable",
        }))
    );

    let sender_identity_id: String = conn
        .query_row(
            "SELECT sender_identity_id FROM session_messages WHERE id = 'msg:old-local-user'",
            [],
            |row| row.get(0),
        )
        .expect("sender identity");
    assert_eq!(sender_identity_id, "human:acct_same");

    let metadata_json: String = conn
        .query_row(
            "SELECT metadata_json FROM sessions WHERE id = 'session:local-before-cloud'",
            [],
            |row| row.get(0),
        )
        .expect("session metadata");
    let metadata: serde_json::Value = serde_json::from_str(&metadata_json).expect("metadata json");
    assert_eq!(
        metadata["adminIdentityIds"],
        serde_json::json!(["human:acct_same"])
    );

    let self_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE session_id = 'session:local-before-cloud' AND role = 'self' AND identity_id = 'human:acct_same'",
            [],
            |row| row.get(0),
        )
        .expect("self participant count");
    assert_eq!(self_count, 1);

    let pre_adoption_group_self_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE session_id = 'session:group:arrived-before-adoption' AND role = 'self' AND identity_id = 'human:acct_same'",
            [],
            |row| row.get(0),
        )
        .expect("pre-adoption group self count");
    assert_eq!(pre_adoption_group_self_count, 1);
}

#[test]
fn cloud_profile_identity_adoption_rolls_back_all_mutations_when_profile_update_fails() {
    let mut conn = test_conn();
    let old_local_human_id =
        local_profile_human_identity_id(&conn, "Old Device Name").expect("local profile");
    let local_agent = seed_identity(&conn, "agent:old-local", "Kordi", "agent");
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:atomic-adoption".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Atomic adoption".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: old_local_human_id.clone(),
            primary_identity_id: Some(local_agent.id.clone()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![local_agent.id],
            metadata: Some(serde_json::json!({
                "adminIdentityIds": [old_local_human_id.clone()],
            })),
        },
    )
    .expect("create local session");
    conn.execute_batch(
        "CREATE TRIGGER abort_cloud_profile_update
         BEFORE UPDATE OF human_identity_id ON local_profile
         WHEN NEW.human_identity_id = 'human:acct_atomic'
         BEGIN
             SELECT RAISE(ABORT, 'injected late profile failure');
         END;",
    )
    .expect("install late failure trigger");

    let error = adopt_cloud_profile_identity_in_db(
        &mut conn,
        AdoptCloudProfileIdentityRequest {
            account_id: "acct_atomic".to_string(),
            display_name: "Cloud Name".to_string(),
            avatar_key: Some("acct_atomic".to_string()),
            profile_image_url: Some("https://example.invalid/atomic.png".to_string()),
        },
    )
    .expect_err("late profile failure must abort adoption");
    assert!(error.contains("injected late profile failure"), "{error}");

    let profile = schema::ensure_local_profile(&conn).expect("profile after failed adoption");
    assert_eq!(
        profile.human_identity_id.as_deref(),
        Some(old_local_human_id.as_str())
    );
    assert_eq!(profile.display_name.as_deref(), Some("Old Device Name"));

    let adopted_identity_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM identities WHERE id = 'human:acct_atomic'",
            [],
            |row| row.get(0),
        )
        .expect("adopted identity count");
    assert_eq!(adopted_identity_count, 0);

    let (created_by_identity_id, metadata_json): (String, String) = conn
        .query_row(
            "SELECT created_by_identity_id, metadata_json
             FROM sessions WHERE id = 'session:atomic-adoption'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("session after failed adoption");
    assert_eq!(created_by_identity_id, old_local_human_id);
    let metadata =
        serde_json::from_str::<serde_json::Value>(&metadata_json).expect("session metadata");
    assert_eq!(
        metadata["adminIdentityIds"],
        serde_json::json!([old_local_human_id])
    );
    assert_eq!(metadata["sessionTitleSource"], "auto");
    assert_eq!(metadata["sessionTitlePolicyVersion"], 1);
    assert!(!metadata_json.contains("acct_atomic"));

    let old_self_participant_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants
             WHERE session_id = 'session:atomic-adoption' AND identity_id = ?1 AND role = 'self'",
            params![old_local_human_id],
            |row| row.get(0),
        )
        .expect("old self participant count");
    assert_eq!(old_self_participant_count, 1);
}
