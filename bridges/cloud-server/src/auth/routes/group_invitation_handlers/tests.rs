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
fn membership_snapshot_is_canonical_for_invitation_preview() {
    let conversation_id = uuid::Uuid::now_v7();
    let snapshot = snapshot_from_rows(
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
    .expect("group snapshot");

    assert_eq!(snapshot.group_title, "Canonical title");
    assert_eq!(snapshot.created_by_account_id, "acct_owner");
    assert_eq!(snapshot.participants.len(), 2);
    assert_eq!(snapshot.participants[0].display_name, "Member");
    assert_eq!(snapshot.participants[0].role, "person");
    assert_eq!(snapshot.participants[1].role, "admin");
}

#[test]
fn invitation_snapshot_requires_a_real_group_membership_set() {
    let snapshot = snapshot_from_rows(
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
fn invitation_capacity_uses_the_canonical_member_snapshot() {
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

#[test]
fn public_avatar_url_drops_generated_avatars_seeded_with_an_account_id() {
    let owner = "acct_0123456789abcdef";
    let legacy = crate::avatars::generated_avatar_marker("lorelei", owner, 1);
    assert_eq!(public_avatar_url(Some(&legacy), owner), None);
    let other_account = crate::avatars::generated_avatar_marker("lorelei", "acct_other", 3);
    assert_eq!(public_avatar_url(Some(&other_account), owner), None);
    let old_renderer = format!("kordi-avatar://older-renderer/lorelei/{owner}?version=1");
    assert_eq!(public_avatar_url(Some(&old_renderer), owner), None);

    let random = crate::avatars::generated_avatar_marker("lorelei", "9f8e7d6c5b4a", 2);
    assert_eq!(
        public_avatar_url(Some(&random), owner),
        Some(random.clone())
    );
    let uploaded = format!("kordi-avatar://uploaded/ava_{}", "a".repeat(32));
    assert_eq!(
        public_avatar_url(Some(&uploaded), owner),
        Some(uploaded.clone())
    );
    let remote = "https://cdn.example.test/avatar.png";
    assert_eq!(
        public_avatar_url(Some(remote), owner),
        Some(remote.to_string())
    );

    assert_eq!(
        public_avatar_url(Some("http://cdn.example.test/a.png"), owner),
        None
    );
    assert_eq!(
        public_avatar_url(
            Some(&format!("https://cdn.example.test/{owner}.png")),
            owner
        ),
        None
    );
    assert_eq!(public_avatar_url(Some("   "), owner), None);
    assert_eq!(public_avatar_url(None, owner), None);
}

#[test]
fn preview_names_the_inviter_without_account_identifiers() {
    let owner = "acct_0123456789abcdef";
    let record = GroupInvitationRecord {
        invitation_id: "ginv_preview".to_string(),
        inviter_account_id: owner.to_string(),
        inviter_display_name: Some("Owner".to_string()),
        inviter_avatar_url: Some(crate::avatars::generated_avatar_marker("lorelei", owner, 1)),
        snapshot: GroupInvitationSnapshot {
            group_id: "session:group:preview".to_string(),
            group_space_id: "session:group:preview".to_string(),
            group_title: "Preview".to_string(),
            created_by_account_id: owner.to_string(),
            participants: vec![GroupInvitationParticipant {
                account_id: owner.to_string(),
                display_name: "Owner".to_string(),
                avatar_url: None,
                role: "admin".to_string(),
            }],
        },
        expires_at: "2026-10-08T00:00:00+00:00".to_string(),
    };
    let preview = serde_json::to_value(group_invitation_preview(&record)).unwrap();
    assert_eq!(
        preview,
        serde_json::json!({
            "inviter": { "displayName": "Owner", "avatarUrl": null },
            "group": { "name": "Preview", "memberCount": 1 },
            "expiresAt": "2026-10-08T00:00:00+00:00",
        })
    );
    assert!(!preview.to_string().contains("acct_"));
}

#[test]
fn displayed_member_count_leaves_out_pip_but_the_snapshot_keeps_it() {
    let pip = crate::pip::test_service_account();
    let snapshot = snapshot_from_rows(
        (
            uuid::Uuid::now_v7(),
            "acct_owner".to_string(),
            Some("Owner and PiP".to_string()),
        ),
        vec![
            (
                "acct_owner".to_string(),
                Some("Owner".to_string()),
                None,
                "owner".to_string(),
            ),
            (
                pip.to_string(),
                Some("PiP".to_string()),
                None,
                "member".to_string(),
            ),
        ],
        "session:group:owner-and-pip",
        "session:group:owner-and-pip",
        "Owner and PiP",
    )
    .expect("an owner alone with PiP can still share the group");
    assert_eq!(snapshot.participants.len(), 2);
    assert_eq!(display_member_count(&snapshot), 1);
}
