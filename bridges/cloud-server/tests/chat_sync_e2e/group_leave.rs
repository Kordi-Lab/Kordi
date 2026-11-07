//! Leaving a group: `store::leave_group`.

use super::group_lifecycle::{active_people, group_request, removal_events};
use super::*;

async fn member_row(pool: &PgPool, conversation_id: Uuid, account_id: &str) -> (String, String) {
    query_as(
        "SELECT role, membership_state FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn left_notices(pool: &PgPool, viewer: &str, conversation_id: Uuid) -> Vec<String> {
    store::history(pool, viewer, conversation_id, None, None)
        .await
        .unwrap()
        .messages
        .into_iter()
        .filter(|message| {
            message.kind == "system-notice"
                && message.content["group_event"]["type"] == store::GROUP_MEMBER_LEFT_EVENT
        })
        .map(|message| {
            message.content["blocks"][0]["text"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect()
}

fn conflict_code(result: Result<store::LeaveOutcome, StoreError>) -> &'static str {
    match result {
        Err(StoreError::Conflict { code, .. }) => code,
        other => panic!("expected a conflict, got {other:?}"),
    }
}

#[tokio::test]
async fn a_member_leaves_every_channel_and_the_group_reads_who_left() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "Ava").await;
    let leaver = account(&pool, "Ben").await;
    let stayer = account(&pool, "Cal").await;
    let outsider = account(&pool, "Dee").await;
    connect_accounts(&pool, &owner, &leaver).await;
    connect_accounts(&pool, &owner, &stayer).await;
    let group = store::create_conversation(
        &pool,
        &owner,
        group_request(vec![leaver.clone(), stayer.clone()], None),
    )
    .await
    .unwrap()
    .value;
    let space = group.legacy_session_id.clone().unwrap();
    let channel = store::create_group_channel(
        &pool,
        &owner,
        &space,
        group_request(vec![], Some("Synthetic planning channel")),
    )
    .await
    .unwrap()
    .value;
    query(
        "INSERT INTO cloud_account_group_space_preferences (account_id, group_space_id, pinned_at) \
         VALUES ($1, $2, now())",
    )
    .bind(&leaver)
    .bind(&space)
    .execute(&pool)
    .await
    .unwrap();

    assert!(matches!(
        store::leave_group(&pool, &outsider, &space).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        store::leave_group(&pool, &leaver, &format!("{space}-other")).await,
        Err(StoreError::NotFound)
    ));

    // The "group:" prefix names the same group.
    let outcome = store::leave_group(&pool, &leaver, &format!("group:{space}"))
        .await
        .unwrap();
    assert_eq!(outcome.group_space_id, space.trim_start_matches("group:"));
    assert_eq!(outcome.conversation_ids, vec![group.id, channel.id]);

    for conversation_id in [group.id, channel.id] {
        assert_eq!(
            member_row(&pool, conversation_id, &leaver).await,
            ("member".to_string(), "left".to_string())
        );
        assert_eq!(
            removal_events(&pool, &leaver, conversation_id).await,
            vec!["left".to_string()]
        );
        assert!(matches!(
            store::history(&pool, &leaver, conversation_id, None, None).await,
            Err(StoreError::Forbidden | StoreError::NotFound)
        ));
        assert_eq!(active_people(&pool, conversation_id).await, 2);
        for person in [&owner, &stayer] {
            assert_eq!(member_row(&pool, conversation_id, person).await.1, "active");
            assert!(removal_events(&pool, person, conversation_id)
                .await
                .is_empty());
            let updates: (i64,) = query_as(
                "SELECT COUNT(*) FROM cloud_chat_user_sync_events \
                 WHERE account_id = $1 AND conversation_id = $2 \
                   AND event_type = 'conversation.updated'",
            )
            .bind(person)
            .bind(conversation_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert!(
                updates.0 >= 1,
                "{person} hears that {conversation_id} changed"
            );
        }
    }
    assert_eq!(member_row(&pool, group.id, &owner).await.0, "owner");
    for person in [&owner, &stayer] {
        assert_eq!(
            left_notices(&pool, person, group.id).await,
            vec!["Ben left the group".to_string()]
        );
        assert!(left_notices(&pool, person, channel.id).await.is_empty());
    }
    let pins: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_account_group_space_preferences \
         WHERE account_id = $1 AND group_space_id = $2",
    )
    .bind(&leaver)
    .bind(&space)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pins.0, 0);

    // Leaving again changes nothing and posts nothing.
    let again = store::leave_group(&pool, &leaver, &space).await.unwrap();
    assert!(again.conversation_ids.is_empty());
    assert_eq!(left_notices(&pool, &owner, group.id).await.len(), 1);
    assert_eq!(removal_events(&pool, &leaver, group.id).await.len(), 1);
}

#[tokio::test]
async fn a_group_keeps_an_admin_and_its_last_person_dissolves_it() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "Eve").await;
    let member = account(&pool, "Fay").await;
    connect_accounts(&pool, &owner, &member).await;
    let group =
        store::create_conversation(&pool, &owner, group_request(vec![member.clone()], None))
            .await
            .unwrap()
            .value;
    let space = group.legacy_session_id.clone().unwrap();
    let channel = store::create_group_channel(
        &pool,
        &owner,
        &space,
        group_request(vec![], Some("Synthetic notes channel")),
    )
    .await
    .unwrap()
    .value;

    // The owner is the only admin: they make someone else an admin first.
    assert_eq!(
        conflict_code(store::leave_group(&pool, &owner, &space).await),
        store::LAST_GROUP_ADMIN_CODE
    );
    assert_eq!(active_people(&pool, group.id).await, 2);
    assert!(left_notices(&pool, &owner, group.id).await.is_empty());

    query(
        "UPDATE cloud_chat_conversation_members SET role = 'admin' \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(group.id)
    .bind(&member)
    .execute(&pool)
    .await
    .unwrap();
    let outcome = store::leave_group(&pool, &owner, &space).await.unwrap();
    assert_eq!(outcome.conversation_ids, vec![group.id, channel.id]);
    // Every conversation the owner held passes on, even where the new owner
    // was not yet an admin.
    for conversation_id in [group.id, channel.id] {
        assert_eq!(
            member_row(&pool, conversation_id, &member).await,
            ("owner".to_string(), "active".to_string())
        );
        assert_eq!(
            member_row(&pool, conversation_id, &owner).await,
            ("member".to_string(), "left".to_string())
        );
    }
    assert_eq!(
        left_notices(&pool, &member, group.id).await,
        vec!["Eve left the group".to_string()]
    );

    // The last person dissolves the group instead.
    assert_eq!(
        conflict_code(store::leave_group(&pool, &member, &space).await),
        store::LAST_GROUP_MEMBER_CODE
    );
    assert_eq!(active_people(&pool, group.id).await, 1);
}
