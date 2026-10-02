//! Only the owner of a group space can add its members to its channels
//! without a contact. Any member can attach a group of their own to a space
//! they belong to, so that alone must not let them add strangers.
use super::group_consent::{
    create_channel, create_group, join_by_invitation, members_request, space_envelope,
};
use super::*;

fn add_requires_contact(result: Result<impl Sized, StoreError>) -> bool {
    matches!(
        result,
        Err(StoreError::RelationshipRequired(message)) if message == store::GROUP_ADD_REQUIRES_CONTACT
    )
}

#[tokio::test]
async fn only_the_space_owner_adds_space_members_to_channels() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "space-channel-owner").await;
    let friend = account(&pool, "space-channel-friend").await;
    let member = account(&pool, "space-channel-member").await;
    let outsider = account(&pool, "space-channel-outsider").await;
    let joined = account(&pool, "space-channel-joined").await;
    connect_accounts(&pool, &owner, &friend).await;
    connect_accounts(&pool, &member, &outsider).await;
    let (_root, root_session) = create_group(&pool, &owner, &[&friend]).await;
    // Both joined through invite links; neither is a contact of anyone here.
    join_by_invitation(&pool, &owner, &root_session, &member).await;
    join_by_invitation(&pool, &owner, &root_session, &joined).await;

    // The invite-joined member attaches a group with their own contact, who
    // is not in the space, and tries to add another member of the space.
    let (own_group, own_session) = create_group(&pool, &member, &[&outsider]).await;
    store::send_message(
        &pool,
        &member,
        own_group,
        space_envelope("group-update", &own_session, &root_session, None, &member),
    )
    .await
    .expect("a member may attach a group to their space");
    assert_eq!(
        super::group_consent::group_space_of(&pool, own_group)
            .await
            .as_deref(),
        Some(root_session.as_str())
    );
    assert!(add_requires_contact(
        store::add_conversation_members(
            &pool,
            &member,
            own_group,
            members_request(&[&joined], false)
        )
        .await
    ));

    // The space's owner can still add the same person to a channel.
    let (channel, _) = create_channel(&pool, &owner, &root_session, &[&friend]).await;
    store::add_conversation_members(&pool, &owner, channel, members_request(&[&joined], false))
        .await
        .expect("the space owner adds space members to its channels");
}
