//! Only the owner of a group space can add its members to its channels
//! without a contact. Any member can attach a group of their own to a space
//! they belong to, so that alone must not let them add strangers.
use super::group_consent::{
    create_channel, create_group, group_space_of, join_by_invitation, leave_request,
    members_request, space_envelope,
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
        group_space_of(&pool, own_group).await.as_deref(),
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

/// Only an owner or admin of a space can move a conversation out of it, so a
/// member cannot take a channel out of the space (or the main conversation
/// into another space) to keep people who leave the space in it.
#[tokio::test]
async fn members_cannot_move_conversations_out_of_their_space() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "space-move-owner").await;
    let member = account(&pool, "space-move-member").await;
    let leaver = account(&pool, "space-move-leaver").await;
    connect_accounts(&pool, &owner, &member).await;
    connect_accounts(&pool, &owner, &leaver).await;
    let (root, root_session) = create_group(&pool, &owner, &[&member, &leaver]).await;
    let envelope = |group: &str, space: &str, actor: &str| {
        space_envelope("group-update", group, space, None, actor)
    };
    store::send_message(
        &pool,
        &owner,
        root,
        envelope(&root_session, &root_session, &owner),
    )
    .await
    .unwrap();
    let (channel, channel_session) =
        create_channel(&pool, &owner, &root_session, &[&member, &leaver]).await;
    let (own, own_session) = create_group(&pool, &member, &[&owner]).await;
    store::send_message(
        &pool,
        &member,
        own,
        envelope(&own_session, &own_session, &member),
    )
    .await
    .unwrap();

    // The member's envelopes are accepted, but both conversations stay put.
    for (conversation, group, space) in [
        (channel, &channel_session, &channel_session),
        (channel, &channel_session, &own_session),
        (root, &root_session, &own_session),
    ] {
        store::send_message(
            &pool,
            &member,
            conversation,
            envelope(group, space, &member),
        )
        .await
        .expect("the message itself is accepted");
        assert_eq!(
            group_space_of(&pool, conversation).await.as_deref(),
            Some(root_session.as_str())
        );
    }
    let left = store::leave_group(&pool, &leaver, root, leave_request(None))
        .await
        .expect("leave the space");
    assert!(left.left_conversation_ids.contains(&channel));

    // The space's owner can still move the channel.
    store::send_message(
        &pool,
        &owner,
        channel,
        envelope(&channel_session, &channel_session, &owner),
    )
    .await
    .unwrap();
    assert_eq!(
        group_space_of(&pool, channel).await.as_deref(),
        Some(channel_session.as_str())
    );
}
