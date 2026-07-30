use super::*;

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
    assert!(error.contains("creator must remain an admin"));
}

#[test]
fn canonical_group_creator_remains_admin_after_another_admin_is_promoted() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:creator", "Creator", "human");
    let alice = seed_identity(&conn, "human:alice", "Alice", "human");
    let group = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:creator-admin".to_string()),
            kind: "group".to_string(),
            title: Some("Creator admin".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![alice.id.clone()],
            metadata: Some(serde_json::json!({
                "adminIdentityIds": [alice.id.clone()]
            })),
        },
    )
    .expect("create group");

    let admins = group_admin_identity_ids(&conn, &group.id).expect("resolve group admins");
    assert_eq!(admins, vec![creator.id.clone(), alice.id.clone()]);
    let error = set_session_participant_role_in_db(&conn, &group.id, &creator.id, "person")
        .expect_err("creator demotion rejected");
    assert!(error.contains("creator must remain an admin"));
}

#[test]
fn canonical_group_child_sessions_use_root_creator_and_admin_authority() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:creator", "Creator", "human");
    let child_creator = seed_identity(&conn, "human:child-creator", "Child creator", "human");
    let member = seed_identity(&conn, "human:member", "Member", "human");
    let root_id = "session:group:authority-root";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(root_id.to_string()),
            kind: "group".to_string(),
            title: Some("Authority root".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![child_creator.id.clone(), member.id.clone()],
            metadata: Some(serde_json::json!({
                "groupId": root_id,
                "groupSpaceId": root_id,
                "groupCreatorIdentityId": creator.id.clone(),
                "adminIdentityIds": [creator.id.clone()]
            })),
        },
    )
    .expect("create authority root");
    let child = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:authority-child".to_string()),
            kind: "group".to_string(),
            title: Some("Authority child".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: child_creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![creator.id.clone(), member.id.clone()],
            metadata: Some(serde_json::json!({
                "groupId": root_id,
                "groupSpaceId": root_id,
                "groupCreatorIdentityId": child_creator.id.clone(),
                "adminIdentityIds": [child_creator.id.clone()]
            })),
        },
    )
    .expect("create child session");

    assert_eq!(
        group_admin_identity_ids(&conn, &child.id).expect("root admins"),
        vec![creator.id.clone()],
    );
    require_group_creator(
        &conn,
        &child.id,
        Some(creator.id.as_str()),
        "change group admins",
    )
    .expect("root creator retains authority in child session");
    let creator_error = require_group_creator(
        &conn,
        &child.id,
        Some(child_creator.id.as_str()),
        "change group admins",
    )
    .expect_err("child session creator is not the group creator");
    assert!(creator_error.contains("Only the group creator"));
    let admin_error = require_group_admin(
        &conn,
        &child.id,
        Some(child_creator.id.as_str()),
        "remove people from this group",
    )
    .expect_err("child session creator is not automatically a group admin");
    assert!(admin_error.contains("Only group admins"));
}

#[test]
fn canonical_group_admins_manage_members_but_only_creator_manages_admins() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:creator", "Creator", "human");
    let admin = seed_identity(&conn, "human:admin", "Admin", "human");
    let member = seed_identity(&conn, "human:member", "Member", "human");
    let group = open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:group:member-authority".to_string()),
            kind: "group".to_string(),
            title: Some("Member authority".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: creator.id.clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![admin.id.clone(), member.id.clone()],
            metadata: Some(serde_json::json!({
                "groupCreatorIdentityId": creator.id.clone(),
                "adminIdentityIds": [creator.id.clone(), admin.id.clone()]
            })),
        },
    )
    .expect("create group");

    require_group_member_removal_permission(&conn, &group.id, Some(admin.id.as_str()), &member.id)
        .expect("admin can remove a non-admin member");
    let admin_removal_error = require_group_member_removal_permission(
        &conn,
        &group.id,
        Some(admin.id.as_str()),
        &creator.id,
    )
    .expect_err("admin cannot remove creator");
    assert!(admin_removal_error.contains("creator cannot be removed"));
    let peer_admin_removal_error = require_group_member_removal_permission(
        &conn,
        &group.id,
        Some(creator.id.as_str()),
        &admin.id,
    )
    .expect_err("admin must be demoted before removal");
    assert!(peer_admin_removal_error.contains("Remove the admin role first"));
    require_group_member_removal_permission(&conn, &group.id, Some(member.id.as_str()), &member.id)
        .expect("ordinary member can leave the group");
}
