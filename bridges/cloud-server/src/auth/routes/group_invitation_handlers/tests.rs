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
            Some("Empty".to_string()),
        ),
        Vec::new(),
        "session:group:empty",
        "session:group:empty",
        "Empty",
    );
    assert!(snapshot.is_none());
}

#[test]
fn a_creator_only_group_can_share_an_invitation() {
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
    )
    .expect("a group of one may invite");
    assert_eq!(snapshot.participants.len(), 1);
    assert_eq!(snapshot.participants[0].role, "admin");
    assert_eq!(snapshot.group_title, "Solo");
}

#[test]
fn invitation_snapshot_lists_people_but_not_service_members() {
    let snapshot = snapshot_from_rows(
        (
            uuid::Uuid::now_v7(),
            "acct_owner".to_string(),
            Some("Solo".to_string()),
        ),
        vec![
            (
                "acct_owner".to_string(),
                Some("Owner".to_string()),
                None,
                "owner".to_string(),
            ),
            (
                crate::system_account::SYSTEM_ACCOUNT_ID.to_string(),
                Some("System".to_string()),
                None,
                "member".to_string(),
            ),
        ],
        "session:group:solo",
        "session:group:solo",
        "Solo",
    )
    .expect("a group of one may invite");
    assert_eq!(
        snapshot
            .participants
            .iter()
            .map(|participant| participant.account_id.as_str())
            .collect::<Vec<_>>(),
        vec!["acct_owner"],
    );
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
fn derived_group_invite_tokens_are_stable_per_invitation_and_secret() {
    let secret = b"group-invite-unit-test-secret-0123456789";
    let first = link::derived_group_invite_token(secret, "groupinv_a");
    assert_eq!(
        first,
        link::derived_group_invite_token(secret, "groupinv_a")
    );
    assert_ne!(
        first,
        link::derived_group_invite_token(secret, "groupinv_b")
    );
    assert_ne!(
        first,
        link::derived_group_invite_token(b"another-secret-for-group-invite-tests", "groupinv_a")
    );
    assert!(first.starts_with(GROUP_INVITE_TOKEN_PREFIX));
    assert_eq!(first.len(), GROUP_INVITE_TOKEN_PREFIX.len() + 43);
    assert!(!first.contains("groupinv_a"));
}

#[tokio::test]
async fn link_resets_spend_the_reset_budget_on_top_of_the_link_budget() {
    use crate::auth::rate_limit::{CloudRateLimitConfig, GROUP_INVITATION_RESET_LIMIT};
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::production());
    for _ in 0..GROUP_INVITATION_RESET_LIMIT.limit {
        assert_eq!(
            creation::charge_group_link_budgets(&limiter, "acct_admin", true).await,
            RateLimitDecision::Allowed
        );
    }
    assert!(matches!(
        creation::charge_group_link_budgets(&limiter, "acct_admin", true).await,
        RateLimitDecision::Limited { .. }
    ));
    // Showing the current link still works once resets are used up.
    assert_eq!(
        creation::charge_group_link_budgets(&limiter, "acct_admin", false).await,
        RateLimitDecision::Allowed
    );
    // Another admin keeps their own reset budget.
    assert_eq!(
        creation::charge_group_link_budgets(&limiter, "acct_other", true).await,
        RateLimitDecision::Allowed
    );
}
