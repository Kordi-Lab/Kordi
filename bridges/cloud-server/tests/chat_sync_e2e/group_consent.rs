use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

pub(crate) fn group_request(session: &str, members: &[&String]) -> CreateConversationRequest {
    CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        kind: ConversationKind::Group,
        shared_title: Some("Consent group".to_string()),
        client_session_id: session.to_string(),
        member_account_ids: members.iter().map(|member| member.to_string()).collect(),
    }
}

pub(crate) async fn create_group(
    pool: &PgPool,
    owner: &str,
    members: &[&String],
) -> (Uuid, String) {
    let session = format!("session:group:{}", Uuid::now_v7());
    let created = store::create_conversation(pool, owner, group_request(&session, members))
        .await
        .expect("create group");
    (created.value.id, session)
}

/// A group control message naming the space a conversation belongs to.
pub(crate) fn space_envelope(
    kind: &str,
    group_id: &str,
    group_space_id: &str,
    group_title: Option<&str>,
    actor: &str,
) -> SendMessageRequest {
    let body = json!({
        "kind": kind,
        "groupId": group_id,
        "groupSpaceId": group_space_id,
        "groupTitle": group_title,
        "actor": { "accountId": actor },
        "participants": [],
    });
    let text = format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(body.to_string())
    );
    SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content: content(&text),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    }
}

/// Creates a channel of the space whose main conversation is `root_session`.
pub(crate) async fn create_channel(
    pool: &PgPool,
    owner: &str,
    root_session: &str,
    members: &[&String],
) -> (Uuid, String) {
    let (channel, session) = create_group(pool, owner, members).await;
    store::send_message(
        pool,
        owner,
        channel,
        space_envelope("group-update", &session, root_session, None, owner),
    )
    .await
    .expect("attach channel to its space");
    assert_eq!(
        group_space_of(pool, channel).await.as_deref(),
        Some(root_session)
    );
    (channel, session)
}

pub(crate) async fn group_space_of(pool: &PgPool, conversation_id: Uuid) -> Option<String> {
    query_as::<_, (Option<String>,)>(
        "SELECT group_space_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

pub(crate) async fn join_by_invitation(
    pool: &PgPool,
    inviter: &str,
    root_session: &str,
    member: &str,
) {
    let mut transaction = pool.begin().await.unwrap();
    store::accept_invited_conversation_member(&mut transaction, inviter, root_session, member)
        .await
        .expect("accept invitation");
    transaction.commit().await.unwrap();
}

pub(crate) fn members_request(members: &[&String], replace: bool) -> AddConversationMembersRequest {
    AddConversationMembersRequest {
        client_operation_id: Uuid::now_v7(),
        member_account_ids: members.iter().map(|member| member.to_string()).collect(),
        replace,
    }
}

pub(crate) fn leave_request(successor: Option<&str>) -> LeaveConversationRequest {
    LeaveConversationRequest {
        client_operation_id: Uuid::now_v7(),
        successor_account_id: successor.map(str::to_string),
    }
}

fn add_requires_contact(result: Result<impl Sized, StoreError>) -> bool {
    matches!(
        result,
        Err(StoreError::RelationshipRequired(message)) if message == store::GROUP_ADD_REQUIRES_CONTACT
    )
}

async fn conversation_version(pool: &PgPool, conversation_id: Uuid) -> i32 {
    query_as::<_, (i32,)>("SELECT version FROM cloud_chat_conversations WHERE conversation_id = $1")
        .bind(conversation_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}

#[tokio::test]
async fn groups_start_with_and_add_only_contacts() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "consent-group-owner").await;
    let friend = account(&pool, "consent-group-friend").await;
    let stranger = account(&pool, "consent-group-stranger").await;
    connect_accounts(&pool, &owner, &friend).await;
    let session = format!("session:group:{}", Uuid::now_v7());
    assert!(add_requires_contact(
        store::create_conversation(
            &pool,
            &owner,
            group_request(&session, &[&friend, &stranger])
        )
        .await
    ));
    let (group, _) = create_group(&pool, &owner, &[&friend]).await;
    assert!(add_requires_contact(
        store::add_conversation_members(&pool, &owner, group, members_request(&[&stranger], false))
            .await
    ));
    connect_accounts(&pool, &owner, &stranger).await;
    query(
        "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) VALUES ($1, $2)",
    )
    .bind(&stranger)
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    assert!(add_requires_contact(
        store::add_conversation_members(&pool, &owner, group, members_request(&[&stranger], false))
            .await
    ));
}

#[tokio::test]
async fn stale_member_lists_naming_a_member_who_left_change_nothing() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "stale-list-owner").await;
    let member = account(&pool, "stale-list-member").await;
    let leaver = account(&pool, "stale-list-leaver").await;
    connect_accounts(&pool, &owner, &member).await;
    connect_accounts(&pool, &owner, &leaver).await;
    let (group, _) = create_group(&pool, &owner, &[&member, &leaver]).await;
    store::leave_group(&pool, &leaver, group, leave_request(None))
        .await
        .expect("leave the group");
    let version = conversation_version(&pool, group).await;

    // An installed client still lists the leaver in its envelope.
    for (actor, replace) in [(&member, true), (&member, false), (&owner, true)] {
        let snapshot = store::add_conversation_members(
            &pool,
            actor,
            group,
            members_request(&[&owner, &member, &leaver], replace),
        )
        .await
        .expect("a list with nothing to change is accepted");
        assert_eq!(snapshot.version, version);
        assert!(snapshot
            .members
            .iter()
            .any(|row| { row.account_id == leaver && row.membership_state == "left" }));
    }
    assert_eq!(conversation_version(&pool, group).await, version);
    store::send_message(
        &pool,
        &member,
        group,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: content("still here"),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("members keep writing");
    // Changing the membership still needs an admin.
    let newcomer = account(&pool, "stale-list-newcomer").await;
    connect_accounts(&pool, &member, &newcomer).await;
    assert!(matches!(
        store::add_conversation_members(
            &pool,
            &member,
            group,
            members_request(&[&newcomer], false)
        )
        .await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn admins_can_add_members_of_the_space_to_its_channels() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "channel-add-owner").await;
    let friend = account(&pool, "channel-add-friend").await;
    let joined = account(&pool, "channel-add-joined").await;
    connect_accounts(&pool, &owner, &friend).await;
    let (_root, root_session) = create_group(&pool, &owner, &[&friend]).await;
    let (channel, _) = create_channel(&pool, &owner, &root_session, &[&friend]).await;
    // `joined` is not the owner's contact; they used an invite link.
    join_by_invitation(&pool, &owner, &root_session, &joined).await;
    let snapshot =
        store::add_conversation_members(&pool, &owner, channel, members_request(&[&joined], false))
            .await
            .expect("space members can be added to its channels");
    assert!(snapshot
        .members
        .iter()
        .any(|row| row.account_id == joined && row.membership_state == "active"));

    // The exemption is limited to the same space.
    let (other_group, _) = create_group(&pool, &owner, &[&friend]).await;
    assert!(add_requires_contact(
        store::add_conversation_members(
            &pool,
            &owner,
            other_group,
            members_request(&[&joined], false)
        )
        .await
    ));
    // And to channels: the space's main conversation needs a contact.
    let outsider = account(&pool, "channel-add-outsider").await;
    assert!(add_requires_contact(
        store::add_conversation_members(
            &pool,
            &owner,
            channel,
            members_request(&[&outsider], false)
        )
        .await
    ));
}

#[tokio::test]
async fn a_block_ends_the_channel_exemption_between_two_people() {
    let Some(pool) = try_pool().await else { return };
    let admin = account(&pool, "channel-block-admin").await;
    let friend = account(&pool, "channel-block-friend").await;
    let member = account(&pool, "channel-block-member").await;
    connect_accounts(&pool, &admin, &friend).await;
    let (_root, root_session) = create_group(&pool, &admin, &[&friend]).await;
    join_by_invitation(&pool, &admin, &root_session, &member).await;
    let (first, _) = create_channel(&pool, &admin, &root_session, &[&friend]).await;
    let (second, _) = create_channel(&pool, &admin, &root_session, &[&friend]).await;
    let set_block = |blocker: String, blocked: String| {
        let pool = pool.clone();
        async move {
            query("DELETE FROM cloud_account_blocks WHERE blocker_account_id = ANY($1)")
                .bind(vec![blocker.clone(), blocked.clone()])
                .execute(&pool)
                .await
                .unwrap();
            query(
                "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) \
                 VALUES ($1, $2)",
            )
            .bind(&blocker)
            .bind(&blocked)
            .execute(&pool)
            .await
            .unwrap();
        }
    };
    let state_in = |conversation_id: Uuid| {
        let pool = pool.clone();
        let member = member.clone();
        async move {
            query_as::<_, (String,)>(
                "SELECT membership_state FROM cloud_chat_conversation_members \
                 WHERE conversation_id = $1 AND account_id = $2",
            )
            .bind(conversation_id)
            .bind(&member)
            .fetch_optional(&pool)
            .await
            .unwrap()
            .map(|(state,)| state)
        }
    };

    // Without a block the admin adds the invite-joined member to a channel.
    store::add_conversation_members(&pool, &admin, first, members_request(&[&member], false))
        .await
        .expect("space members can be added to its channels");
    store::leave_group(&pool, &member, first, leave_request(None))
        .await
        .expect("leave the channel");

    for (blocker, blocked) in [(&member, &admin), (&admin, &member)] {
        set_block(blocker.clone(), blocked.clone()).await;
        // A first add is refused in either direction of the block.
        assert!(add_requires_contact(
            store::add_conversation_members(
                &pool,
                &admin,
                second,
                members_request(&[&member], false)
            )
            .await
        ));
        assert_eq!(state_in(second).await, None);
        // Adding them back after they left changes nothing, and a stale list
        // that still names them never stops the admin from writing.
        let version = conversation_version(&pool, first).await;
        for (members, replace) in [
            (vec![&member], false),
            (vec![&admin, &friend, &member], true),
        ] {
            let snapshot = store::add_conversation_members(
                &pool,
                &admin,
                first,
                members_request(&members, replace),
            )
            .await
            .expect("a list that names a blocked leaver changes nothing");
            assert_eq!(snapshot.version, version);
        }
        assert_eq!(state_in(first).await.as_deref(), Some("left"));
        store::send_message(
            &pool,
            &admin,
            first,
            SendMessageRequest {
                client_message_id: Uuid::now_v7(),
                kind: "text".to_string(),
                content: content("still writing"),
                reply_to_message_id: None,
                attachment_ids: Vec::new(),
            },
        )
        .await
        .expect("the admin keeps writing in the channel");
    }

    // Without the block the exemption applies again.
    query("DELETE FROM cloud_account_blocks WHERE blocker_account_id = ANY($1)")
        .bind(vec![admin.clone(), member.clone()])
        .execute(&pool)
        .await
        .unwrap();
    store::add_conversation_members(&pool, &admin, first, members_request(&[&member], false))
        .await
        .expect("an admin without a block can add them back");
    assert_eq!(state_in(first).await.as_deref(), Some("active"));
}

#[tokio::test]
async fn a_conversation_joins_only_a_space_its_sender_belongs_to() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "space-owner").await;
    let member = account(&pool, "space-member").await;
    let other = account(&pool, "space-other").await;
    let other_friend = account(&pool, "space-other-friend").await;
    connect_accounts(&pool, &owner, &member).await;
    connect_accounts(&pool, &other, &other_friend).await;
    let (root, root_session) = create_group(&pool, &owner, &[&member]).await;
    store::send_message(
        &pool,
        &owner,
        root,
        space_envelope(
            "group-update",
            &root_session,
            &root_session,
            Some("Team"),
            &owner,
        ),
    )
    .await
    .unwrap();
    let (channel, _) = create_channel(&pool, &owner, &root_session, &[&member]).await;

    // Someone outside the space cannot attach their group to it.
    let (foreign, foreign_session) = create_group(&pool, &other, &[&other_friend]).await;
    let attached = store::send_message(
        &pool,
        &other,
        foreign,
        space_envelope(
            "group-update",
            &foreign_session,
            &root_session,
            Some("Taken"),
            &other,
        ),
    )
    .await;
    assert!(
        matches!(attached, Err(StoreError::Forbidden)),
        "{:?}",
        attached.err()
    );
    assert_eq!(group_space_of(&pool, foreign).await, None);
    let titles: Vec<(Uuid, Option<String>)> = query_as(
        "SELECT conversation_id, group_title FROM cloud_chat_conversations \
         WHERE conversation_id = ANY($1) ORDER BY conversation_id",
    )
    .bind(vec![root, channel])
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(titles
        .iter()
        .all(|(_, title)| title.as_deref() == Some("Team")));

    // A space title reaches only conversations the sender is active in.
    query(
        "UPDATE cloud_chat_conversation_members SET membership_state = 'left' \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(channel)
    .bind(&member)
    .execute(&pool)
    .await
    .unwrap();
    store::send_message(
        &pool,
        &member,
        root,
        space_envelope(
            "group-update",
            &root_session,
            &root_session,
            Some("Renamed"),
            &member,
        ),
    )
    .await
    .unwrap();
    let title = |conversation_id: Uuid| {
        let pool = pool.clone();
        async move {
            query_as::<_, (Option<String>,)>(
                "SELECT group_title FROM cloud_chat_conversations WHERE conversation_id = $1",
            )
            .bind(conversation_id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .0
        }
    };
    assert_eq!(title(root).await.as_deref(), Some("Renamed"));
    assert_eq!(title(channel).await.as_deref(), Some("Team"));
}
