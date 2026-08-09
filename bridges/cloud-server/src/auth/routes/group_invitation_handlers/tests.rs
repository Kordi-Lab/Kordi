use super::*;

fn participant(account_id: &str, display_name: &str, role: &str) -> GroupInvitationParticipant {
    GroupInvitationParticipant {
        account_id: account_id.to_string(),
        display_name: display_name.to_string(),
        avatar_url: None,
        role: role.to_string(),
    }
}

fn encoded_control(actor_role: &str) -> String {
    let envelope = serde_json::json!({
        "kind": "group-message",
        "groupId": "session:group:team",
        "groupSpaceId": "session:group:team",
        "groupTitle": null,
        "createdByAccountId": "acct_creator",
        "actor": {
            "accountId": "acct_admin",
            "displayName": "Admin",
            "avatarUrl": null,
            "role": actor_role,
        },
        "participants": [
            {
                "accountId": "acct_creator",
                "displayName": "Creator",
                "avatarUrl": null,
                "role": "admin",
            },
            {
                "accountId": "acct_admin",
                "displayName": "Admin",
                "avatarUrl": null,
                "role": actor_role,
            },
            {
                "accountId": "acct_member",
                "displayName": "Member",
                "avatarUrl": null,
                "role": "person",
            }
        ],
        "message": null,
    });
    format!(
        "{CLOUD_GROUP_CONTROL_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    )
}

fn encoded_transition(
    kind: &str,
    actor_account_id: &str,
    admin_role: &str,
    member_role: &str,
) -> String {
    let actor_role = match actor_account_id {
        "acct_creator" => "admin",
        "acct_admin" => admin_role,
        _ => member_role,
    };
    let envelope = serde_json::json!({
        "kind": kind,
        "groupId": "session:group:team",
        "groupSpaceId": "session:group:team",
        "groupTitle": "Product Team",
        "createdByAccountId": "acct_creator",
        "actor": {
            "accountId": actor_account_id,
            "displayName": "Actor",
            "avatarUrl": null,
            "role": actor_role,
        },
        "participants": [
            { "accountId": "acct_creator", "displayName": "Creator", "avatarUrl": null, "role": "admin" },
            { "accountId": "acct_admin", "displayName": "Admin", "avatarUrl": null, "role": admin_role },
            { "accountId": "acct_member", "displayName": "Member", "avatarUrl": null, "role": member_role }
        ],
        "message": null,
    });
    format!(
        "{CLOUD_GROUP_CONTROL_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    )
}

#[test]
fn group_invite_tokens_are_opaque_and_hash_only() {
    let first = new_group_invite_token();
    let second = new_group_invite_token();
    assert!(first.starts_with(GROUP_INVITE_TOKEN_PREFIX));
    assert_ne!(first, second);
    assert_eq!(
        hash_group_invite_token(&first),
        hash_group_invite_token(&first)
    );
    assert_ne!(
        hash_group_invite_token(&first),
        hash_group_invite_token(&second)
    );
    assert!(!hash_group_invite_token(&first).contains(&first));
}

#[test]
fn group_invitation_landing_copy_is_concise() {
    let message = creation::group_invitation_landing_message("Shu Yang");
    assert_eq!(message, "Shu Yang invited you to this group.");
    assert!(!message.contains("member"));
    assert!(!message.contains("Preview"));
}

#[test]
fn only_a_verified_admin_snapshot_can_create_a_group_link() {
    let admin = invitation_snapshot_from_control(
        &encoded_control("admin"),
        "acct_admin",
        "session:group:team",
        "session:group:team",
        "Product Team",
    )
    .expect("admin snapshot");
    assert_eq!(admin.group_title, "Product Team");
    assert_eq!(admin.participants.len(), 3);
    assert!(snapshot_allows_group_invitation(&admin, "acct_admin"));

    let demoted = invitation_snapshot_from_control(
        &encoded_control("person"),
        "acct_admin",
        "session:group:team",
        "session:group:team",
        "Product Team",
    )
    .expect("valid demotion snapshot");
    assert!(!snapshot_allows_group_invitation(&demoted, "acct_admin"));
    assert!(invitation_snapshot_from_control(
        &encoded_control("admin"),
        "acct_someone_else",
        "session:group:team",
        "session:group:team",
        "Product Team",
    )
    .is_none());
}

#[test]
fn non_admin_cannot_forge_an_authoritative_admin_transition() {
    let initial = encoded_transition("group-invite", "acct_creator", "admin", "person");
    let forged = encoded_transition("group-update", "acct_member", "admin", "admin");
    let snapshot = authoritative_snapshot_from_rows(
        vec![
            ("acct_creator".to_string(), initial),
            ("acct_member".to_string(), forged),
        ],
        "session:group:team",
        "session:group:team",
        "Product Team",
    )
    .expect("authoritative snapshot");
    assert!(!snapshot_allows_group_invitation(&snapshot, "acct_member"));
    assert!(snapshot_allows_group_invitation(&snapshot, "acct_admin"));
}

#[test]
fn creator_signed_demotion_is_authoritative() {
    let initial = encoded_transition("group-invite", "acct_creator", "admin", "person");
    let demotion = encoded_transition("group-update", "acct_creator", "person", "person");
    let snapshot = authoritative_snapshot_from_rows(
        vec![
            ("acct_creator".to_string(), initial),
            ("acct_creator".to_string(), demotion),
        ],
        "session:group:team",
        "session:group:team",
        "Product Team",
    )
    .expect("authoritative snapshot");
    assert!(!snapshot_allows_group_invitation(&snapshot, "acct_admin"));
    assert!(snapshot_allows_group_invitation(&snapshot, "acct_creator"));
}

#[test]
fn non_creator_admin_cannot_promote_another_admin() {
    let initial = encoded_transition("group-invite", "acct_creator", "admin", "person");
    let forged_promotion = encoded_transition("group-update", "acct_admin", "admin", "admin");
    let snapshot = authoritative_snapshot_from_rows(
        vec![
            ("acct_creator".to_string(), initial),
            ("acct_admin".to_string(), forged_promotion),
        ],
        "session:group:team",
        "session:group:team",
        "Product Team",
    )
    .expect("authoritative snapshot");
    assert!(!snapshot_allows_group_invitation(&snapshot, "acct_member"));
}

#[test]
fn acceptance_control_adds_the_recipient_only_after_join() {
    let record = GroupInvitationRecord {
        invitation_id: "groupinv_one".to_string(),
        inviter_account_id: "acct_admin".to_string(),
        inviter_display_name: Some("Admin".to_string()),
        inviter_public_account_number: 482_731_906,
        inviter_avatar_url: None,
        snapshot: GroupInvitationSnapshot {
            group_id: "session:group:team".to_string(),
            group_space_id: "session:group:team".to_string(),
            group_title: "Product Team".to_string(),
            created_by_account_id: "acct_creator".to_string(),
            participants: vec![
                participant("acct_admin", "Admin", "admin"),
                participant("acct_creator", "Creator", "admin"),
            ],
        },
        expires_at: "2026-08-15T00:00:00Z".to_string(),
    };
    let body = accepted_group_control_body(
        &record,
        participant("acct_recipient", "Recipient", "person"),
        1_786_000_000_000,
    );
    let control = parse_group_control_for_invitation(&body).expect("accepted control");
    assert_eq!(control.kind, "group-invite");
    assert!(control
        .participants
        .iter()
        .any(|participant| participant.account_id == "acct_recipient"));

    let encoded = body.strip_prefix(CLOUD_GROUP_CONTROL_PREFIX).unwrap();
    let decoded = URL_SAFE_NO_PAD.decode(encoded).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(value["memberJoins"][0]["accountId"], "acct_recipient");
    assert!(value.get("contactRequest").is_none());
}

#[test]
fn a_full_group_rejects_another_invitation_acceptance() {
    let snapshot = GroupInvitationSnapshot {
        group_id: "session:group:full".to_string(),
        group_space_id: "session:group:full".to_string(),
        group_title: "Full group".to_string(),
        created_by_account_id: "acct_0".to_string(),
        participants: (0..GROUP_INVITE_MAX_MEMBERS)
            .map(|index| participant(&format!("acct_{index}"), "Member", "person"))
            .collect(),
    };
    assert!(!group_invitation_has_capacity(&snapshot));
}
