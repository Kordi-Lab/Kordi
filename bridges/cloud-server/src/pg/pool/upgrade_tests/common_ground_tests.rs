use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_133_adds_common_ground() {
    let pool = fixture(133).await;
    let accounts = "SELECT to_jsonb(a) FROM cloud_accounts a ORDER BY account_id";
    let before: Vec<(Value,)> = query_as(accounts).fetch_all(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    // Migrations 139 and 140 add empty profile columns.
    let after: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) - ARRAY['public_handle','about','location','time_zone','website','birthday','public_handle_changed_at'] FROM cloud_accounts a ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(before, after, "accounts are untouched");

    // Rows use the current schema, where everything hangs off a profile.
    execute(&pool, "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position) VALUES('cgp_owner','fixture-owner','work','Work',0),('cgp_peer','fixture-peer','work','Work',0)").await;
    execute(&pool, "INSERT INTO cloud_common_ground_cards(profile_id,account_id) VALUES('cgp_owner','fixture-owner'),('cgp_peer','fixture-peer')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code,created_by) VALUES('00000000-0000-0000-0000-000000000001','0427','fixture-owner')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_room_members(room_id,account_id,profile_id) VALUES('00000000-0000-0000-0000-000000000001','fixture-owner','cgp_owner'),('00000000-0000-0000-0000-000000000001','fixture-peer','cgp_peer')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_pairings(account_a,account_b,profile_a,profile_b) VALUES('fixture-owner','fixture-peer','cgp_owner','cgp_peer')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_pairing_codes(code_hash,account_id,profile_id,expires_at) VALUES('hash','fixture-peer','cgp_peer',now())").await;
    execute(&pool, "INSERT INTO cloud_common_ground_matches(viewer_account_id,other_account_id,viewer_profile_id,other_profile_id,viewer_revision,other_revision,result_json) VALUES('fixture-owner','fixture-peer','cgp_owner','cgp_peer',1,1,'{}')").await;
    let (sharing, revision, topics): (bool, i64, Value) = query_as("SELECT sharing_enabled,revision,topics_json FROM cloud_common_ground_cards WHERE account_id='fixture-owner'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (sharing, revision, topics),
        (true, 0, json!({})),
        "cards share by default"
    );
    for invalid in [
        // A second open room with the same code.
        "INSERT INTO cloud_common_ground_rooms(room_id,code) VALUES('00000000-0000-0000-0000-000000000002','0427')",
        "INSERT INTO cloud_common_ground_rooms(room_id,code) VALUES('00000000-0000-0000-0000-000000000003','42')",
        "INSERT INTO cloud_common_ground_rooms(room_id,code) VALUES('00000000-0000-0000-0000-000000000004','04a7')",
        // Pairings are stored with the smaller id first, once.
        "INSERT INTO cloud_common_ground_pairings(account_a,account_b,profile_a,profile_b) VALUES('fixture-peer','fixture-owner','cgp_peer','cgp_owner')",
        "INSERT INTO cloud_common_ground_matches(viewer_account_id,other_account_id,viewer_profile_id,other_profile_id,viewer_revision,other_revision,result_json) VALUES('fixture-peer','fixture-peer','cgp_peer','cgp_peer',1,1,'{}')",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err(), "{invalid}");
    }
    // A closed room frees its code.
    execute(
        &pool,
        "UPDATE cloud_common_ground_rooms SET closed_at=now() WHERE code='0427'",
    )
    .await;
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code) VALUES('00000000-0000-0000-0000-000000000005','0427')").await;

    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-peer'",
    )
    .await;
    let counts: (i64, i64, i64, i64, i64) = query_as("SELECT (SELECT COUNT(*) FROM cloud_common_ground_cards),(SELECT COUNT(*) FROM cloud_common_ground_room_members),(SELECT COUNT(*) FROM cloud_common_ground_pairings),(SELECT COUNT(*) FROM cloud_common_ground_pairing_codes),(SELECT COUNT(*) FROM cloud_common_ground_matches)")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        counts,
        (1, 1, 0, 0, 0),
        "a deleted account takes its Common ground rows"
    );
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-owner'",
    )
    .await;
    let (created_by,): (Option<String>,) = query_as("SELECT created_by FROM cloud_common_ground_rooms WHERE room_id='00000000-0000-0000-0000-000000000001'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(created_by, None, "rooms outlive the person who opened them");
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_136_adds_matching_runs_and_room_themes() {
    let pool = fixture(136).await;
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code,created_by) VALUES('00000000-0000-0000-0000-000000000001','0427','fixture-owner')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_matches(viewer_account_id,other_account_id,viewer_revision,other_revision,result_json,opened_at) VALUES('fixture-owner','fixture-peer',1,1,'{\"score\":40}',now())").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (score,): (Value,) =
        query_as("SELECT result_json->'score' FROM cloud_common_ground_matches")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(score, json!(40), "stored matches are untouched");

    execute(&pool, "INSERT INTO cloud_common_ground_match_runs(run_id,kind,viewer_account_id,room_id,cards_json) VALUES('cg_match_a','match','fixture-owner','00000000-0000-0000-0000-000000000001','[]')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_match_runs(run_id,kind,room_id,cards_json) VALUES('cg_room_a','room','00000000-0000-0000-0000-000000000001','[]')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_room_themes(room_id,members_key,themes_json) VALUES('00000000-0000-0000-0000-000000000001','key','[]')").await;
    for invalid in [
        "INSERT INTO cloud_common_ground_match_runs(run_id,kind,cards_json) VALUES('cg_match_b','match','[]')",
        "INSERT INTO cloud_common_ground_match_runs(run_id,kind,viewer_account_id,cards_json) VALUES('cg_room_b','room','fixture-owner','[]')",
        "INSERT INTO cloud_common_ground_match_runs(run_id,kind,viewer_account_id,cards_json) VALUES('cg_x','other','fixture-owner','[]')",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err(), "{invalid}");
    }
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-owner'",
    )
    .await;
    let (runs,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_common_ground_match_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        runs, 1,
        "a deleted viewer takes their match runs; the room's run stays"
    );
    execute(&pool, "DELETE FROM cloud_common_ground_rooms").await;
    let counts: (i64, i64) = query_as("SELECT (SELECT COUNT(*) FROM cloud_common_ground_match_runs),(SELECT COUNT(*) FROM cloud_common_ground_room_themes)")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(counts, (0, 0), "a deleted room takes its runs and themes");
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_137_adds_room_invitations() {
    let pool = fixture(137).await;
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code,created_by) VALUES('00000000-0000-0000-0000-000000000001','0427','fixture-owner')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (rooms,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_common_ground_rooms")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rooms, 1, "rooms are untouched");

    execute(&pool, "INSERT INTO cloud_common_ground_room_groups(group_space_id,room_id,conversation_id,name,created_by) VALUES('session:group:a','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','Agents','fixture-owner')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_room_invitations(invitation_ref,room_id,group_space_id,group_invitation_id,inviter_account_id,invitee_account_id) VALUES('cgi_a','00000000-0000-0000-0000-000000000001','session:group:a','groupinv_a','fixture-owner','fixture-peer')").await;
    let (accepted,): (Option<chrono::DateTime<chrono::Utc>>,) =
        query_as("SELECT accepted_at FROM cloud_common_ground_room_invitations")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(accepted, None, "invitations start pending");
    for invalid in [
        // One invitation per person per group.
        "INSERT INTO cloud_common_ground_room_invitations(invitation_ref,room_id,group_space_id,group_invitation_id,inviter_account_id,invitee_account_id) VALUES('cgi_b','00000000-0000-0000-0000-000000000001','session:group:a','groupinv_a','fixture-owner','fixture-peer')",
        "INSERT INTO cloud_common_ground_room_invitations(invitation_ref,room_id,group_space_id,group_invitation_id,inviter_account_id,invitee_account_id) VALUES('cgi_c','00000000-0000-0000-0000-000000000009','session:group:a','groupinv_a','fixture-owner','fixture-owner')",
        "INSERT INTO cloud_common_ground_room_groups(group_space_id,room_id,conversation_id,name,created_by) VALUES('session:group:b','00000000-0000-0000-0000-000000000009','00000000-0000-0000-0000-00000000000b','Other','fixture-owner')",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err(), "{invalid}");
    }
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-peer'",
    )
    .await;
    let counts: (i64, i64) = query_as("SELECT (SELECT COUNT(*) FROM cloud_common_ground_room_groups),(SELECT COUNT(*) FROM cloud_common_ground_room_invitations)")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(counts, (1, 0), "a deleted invitee takes their invitations");
    execute(&pool, "DELETE FROM cloud_common_ground_rooms").await;
    let (groups,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_common_ground_room_groups")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(groups, 0, "a deleted room takes its groups");
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_138_adds_group_topics() {
    let pool = fixture(138).await;
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code,created_by) VALUES('00000000-0000-0000-0000-000000000001','0427','fixture-owner')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_room_groups(group_space_id,room_id,conversation_id,name,created_by) VALUES('session:group:a','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','Agents','fixture-owner')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (name, topic): (String, Option<String>) =
        query_as("SELECT name, topic FROM cloud_common_ground_room_groups")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (name.as_str(), topic),
        ("Agents", None),
        "existing groups keep no topic"
    );
    execute(&pool, "INSERT INTO cloud_common_ground_room_groups(group_space_id,room_id,conversation_id,name,created_by,topic) VALUES('session:group:b','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000b','Memory','fixture-owner','Agent memory')").await;
    let (topic,): (Option<String>,) = query_as(
        "SELECT topic FROM cloud_common_ground_room_groups WHERE group_space_id='session:group:b'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(topic.as_deref(), Some("Agent memory"));
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_141_adds_profiles() {
    let pool = fixture(141).await;
    let room = "00000000-0000-0000-0000-000000000001";
    execute(&pool, "INSERT INTO cloud_common_ground_cards(account_id,topics_json,revision,built_at) VALUES('fixture-owner','{\"workingOn\":[\"Agent memory\"]}',3,now()),('fixture-peer','{}',1,now())").await;
    execute(&pool, &format!("INSERT INTO cloud_common_ground_rooms(room_id,code,created_by) VALUES('{room}','0427','fixture-owner')")).await;
    execute(&pool, &format!("INSERT INTO cloud_common_ground_room_members(room_id,account_id) VALUES('{room}','fixture-owner'),('{room}','fixture-peer')")).await;
    execute(&pool, "INSERT INTO cloud_common_ground_pairings(account_a,account_b) VALUES('fixture-owner','fixture-peer')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_pairing_codes(code_hash,account_id,expires_at) VALUES('hash','fixture-peer',now())").await;
    execute(&pool, "INSERT INTO cloud_common_ground_matches(viewer_account_id,other_account_id,viewer_revision,other_revision,result_json,opened_at) VALUES('fixture-owner','fixture-peer',3,1,'{\"score\":40}',now())").await;
    execute(&pool, "INSERT INTO cloud_common_ground_match_runs(run_id,kind,viewer_account_id,cards_json) VALUES('cg_match_a','match','fixture-owner','[]')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    let profiles: Vec<(String, String, String, String, i32)> = query_as("SELECT profile_id,account_id,kind,name,position FROM cloud_common_ground_profiles ORDER BY account_id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        profiles.len(),
        2,
        "one work profile per person: {profiles:?}"
    );
    for (id, _, kind, name, position) in &profiles {
        assert!(id.starts_with("cgp_") && id.len() == 36, "{id}");
        assert_eq!(
            (kind.as_str(), name.as_str(), *position),
            ("work", "Work", 0)
        );
    }
    let owner = profiles[0].0.clone();
    let peer = profiles[1].0.clone();
    assert_eq!(profiles[0].1, "fixture-owner");
    let (card, revision, topics): (String, i64, Value) = query_as("SELECT profile_id,revision,topics_json FROM cloud_common_ground_cards WHERE account_id='fixture-owner'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (card, revision),
        (owner.clone(), 3),
        "the card moves to the work profile"
    );
    assert_eq!(topics, json!({"workingOn": ["Agent memory"]}));
    let check: (String, String, String, String, String, String, Option<String>, Option<String>) = query_as(
        "SELECT (SELECT profile_id FROM cloud_common_ground_room_members WHERE account_id='fixture-owner'),
                (SELECT profile_id FROM cloud_common_ground_room_members WHERE account_id='fixture-peer'),
                (SELECT profile_a FROM cloud_common_ground_pairings), (SELECT profile_b FROM cloud_common_ground_pairings),
                (SELECT viewer_profile_id FROM cloud_common_ground_matches), (SELECT other_profile_id FROM cloud_common_ground_matches),
                (SELECT profile_id FROM cloud_common_ground_pairing_codes),
                (SELECT viewer_profile_id FROM cloud_common_ground_match_runs)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        check,
        (
            owner.clone(),
            peer.clone(),
            owner.clone(),
            peer.clone(),
            owner.clone(),
            peer.clone(),
            Some(peer.clone()),
            Some(owner.clone())
        )
    );
    let (kind,): (Option<String>,) = query_as("SELECT kind FROM cloud_common_ground_rooms")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kind, None, "existing rooms suggest no kind");

    // A second card for a new profile; fixed kinds once, five at most.
    execute(&pool, "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position) VALUES('cgp_health','fixture-owner','health','Health',1),('cgp_kaust','fixture-owner','custom','KAUST',2),('cgp_mit','fixture-owner','custom','MIT',3)").await;
    execute(&pool, "INSERT INTO cloud_common_ground_cards(profile_id,account_id) VALUES('cgp_health','fixture-owner')").await;
    for invalid in [
        "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position) VALUES('cgp_w2','fixture-owner','work','Work',4)",
        "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position) VALUES('cgp_x','fixture-owner','custom','X',1)",
        "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position) VALUES('cgp_y','fixture-owner','school','Y',5)",
        "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position) VALUES('cgp_z','fixture-owner','custom','',5)",
        "INSERT INTO cloud_common_ground_cards(profile_id,account_id) VALUES('cgp_health','fixture-owner')",
        "INSERT INTO cloud_common_ground_rooms(room_id,code,kind) VALUES('00000000-0000-0000-0000-000000000002','0428','school')",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err(), "{invalid}");
    }
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code,kind) VALUES('00000000-0000-0000-0000-000000000002','0428','health')").await;

    // Deleting a profile takes its card, memberships, pairings and matches.
    execute(
        &pool,
        &format!("DELETE FROM cloud_common_ground_profiles WHERE profile_id='{owner}'"),
    )
    .await;
    let counts: (i64, i64, i64, i64, i64) = query_as("SELECT (SELECT COUNT(*) FROM cloud_common_ground_cards),(SELECT COUNT(*) FROM cloud_common_ground_room_members),(SELECT COUNT(*) FROM cloud_common_ground_pairings),(SELECT COUNT(*) FROM cloud_common_ground_matches),(SELECT COUNT(*) FROM cloud_common_ground_match_runs)")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(counts, (2, 1, 0, 0, 0));
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-owner'",
    )
    .await;
    let (left,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_common_ground_profiles")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 1, "a deleted account takes its profiles");
}
