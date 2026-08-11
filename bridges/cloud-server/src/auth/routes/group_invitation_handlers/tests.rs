use super::*;

#[test]
fn group_invite_tokens_are_opaque_and_hash_stably() {
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
fn v2_membership_snapshot_is_canonical_for_invitation_preview() {
    let conversation_id = uuid::Uuid::now_v7();
    let snapshot = snapshot_from_v2_rows(
        (
            conversation_id,
            "acct_owner".to_string(),
            Some("Canonical title".to_string()),
        ),
        vec![
            (
                "acct_member".to_string(),
                Some(" Member ".to_string()),
                Some("https://cdn.example/member.png".to_string()),
                "member".to_string(),
            ),
            (
                "acct_owner".to_string(),
                Some("Owner".to_string()),
                None,
                "owner".to_string(),
            ),
        ],
        "session:group:team",
        "session:group:team",
        "Stale client title",
    )
    .expect("v2 group snapshot");

    assert_eq!(snapshot.group_title, "Canonical title");
    assert_eq!(snapshot.created_by_account_id, "acct_owner");
    assert_eq!(snapshot.participants.len(), 2);
    assert_eq!(snapshot.participants[0].display_name, "Member");
    assert_eq!(snapshot.participants[0].role, "person");
    assert_eq!(snapshot.participants[1].role, "admin");
}

#[test]
fn invitation_snapshot_requires_a_real_group_membership_set() {
    let snapshot = snapshot_from_v2_rows(
        (
            uuid::Uuid::now_v7(),
            "acct_owner".to_string(),
            Some("Solo".to_string()),
        ),
        vec![(
            "acct_owner".to_string(),
            Some("Owner".to_string()),
            None,
            "owner".to_string(),
        )],
        "session:group:solo",
        "session:group:solo",
        "Solo",
    );
    assert!(snapshot.is_none());
}

#[test]
fn invitation_capacity_uses_the_v2_member_snapshot() {
    let snapshot = GroupInvitationSnapshot {
        group_id: "session:group:full".to_string(),
        group_space_id: "session:group:full".to_string(),
        group_title: "Full".to_string(),
        created_by_account_id: "acct_owner".to_string(),
        participants: (0..GROUP_INVITE_MAX_MEMBERS)
            .map(|index| GroupInvitationParticipant {
                account_id: format!("acct_{index}"),
                display_name: format!("Member {index}"),
                avatar_url: None,
                role: if index == 0 { "admin" } else { "person" }.to_string(),
            })
            .collect(),
    };
    assert!(!group_invitation_has_capacity(&snapshot));
}
