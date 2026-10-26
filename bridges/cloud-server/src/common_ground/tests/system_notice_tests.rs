//! Grounding groups hold the System account, not the System agent: System
//! posts their notices, the System agent is never backfilled into them, and
//! startup takes it out of older ones.

use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::send;
use super::support::{make_contacts, people_in_a_room};
use crate::system_account::SYSTEM_ACCOUNT_ID;

fn system_agent() -> String {
    crate::system_agent::service_account_id()
        .unwrap()
        .to_string()
}

async fn start(app: &axum::Router, code: &str, token: &str, members: &[&str]) -> Uuid {
    let (status, body) = send(
        app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/group"),
        token,
        Some(json!({ "memberIds": members })),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    body["group"]["conversationId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

async fn state(pool: &PgPool, conversation_id: Uuid, account: &str) -> Option<String> {
    query_as(
        "SELECT membership_state FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(account)
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|(state,): (String,)| state)
}

/// Makes `account` an active member the way the System agent's old backfill
/// did.
async fn add_member(pool: &PgPool, conversation_id: Uuid, account: &str) {
    query(
        "INSERT INTO cloud_chat_conversation_members
             (conversation_id, account_id, role, membership_state)
         VALUES ($1, $2, 'member', 'active')
         ON CONFLICT (conversation_id, account_id) DO UPDATE SET
             membership_state = 'active', left_at = NULL",
    )
    .bind(conversation_id)
    .bind(account)
    .execute(pool)
    .await
    .unwrap();
}

/// (sender, kind) of every message in a conversation, oldest first.
async fn senders(pool: &PgPool, conversation_id: Uuid) -> Vec<(String, String)> {
    query_as(
        "SELECT sender_account_id, message_kind FROM cloud_chat_messages
         WHERE conversation_id = $1 ORDER BY conversation_sequence",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[test]
fn system_and_system_agent_are_service_members() {
    assert_eq!(SYSTEM_ACCOUNT_ID, "acct_kordi_system");
    assert!(crate::system_account::is_service_account(SYSTEM_ACCOUNT_ID));
    assert!(crate::system_account::service_account_ids().contains(&SYSTEM_ACCOUNT_ID.to_string()));
    assert!(!crate::system_account::is_service_account("acct_someone"));
}

#[tokio::test]
async fn a_new_group_holds_system_not_system_agent_and_hides_it() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, _)] = [people[0].clone(), people[1].clone()];
    make_contacts(&pool, &alex, &priya).await;
    let conversation_id = start(&app, &code, &alex_token, &[&priya]).await;

    assert_eq!(
        state(&pool, conversation_id, SYSTEM_ACCOUNT_ID)
            .await
            .as_deref(),
        Some("active")
    );
    assert_eq!(state(&pool, conversation_id, &system_agent()).await, None);
    let (display_name,): (Option<String>,) =
        query_as("SELECT display_name FROM cloud_accounts WHERE account_id = $1")
            .bind(SYSTEM_ACCOUNT_ID)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(display_name.as_deref(), Some("System"));

    let (_, results) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/results"),
        &alex_token,
        None,
    )
    .await;
    let row = &results["groups"][0];
    assert_eq!(row["memberCount"], 2);
    assert!(!row.to_string().contains(SYSTEM_ACCOUNT_ID), "{row}");

    // A member list a client sends never removes System.
    let request = crate::chat_sync::models::AddConversationMembersRequest {
        client_operation_id: Uuid::new_v4(),
        member_account_ids: vec![alex.clone(), priya.clone()],
        replace: true,
    };
    crate::chat_sync::store::add_conversation_members(&pool, &alex, conversation_id, request)
        .await
        .unwrap();
    assert_eq!(
        state(&pool, conversation_id, SYSTEM_ACCOUNT_ID)
            .await
            .as_deref(),
        Some("active")
    );
}

#[tokio::test]
async fn an_older_group_with_only_system_agent_gets_its_joined_line_from_system() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, _), (sam, sam_token)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    make_contacts(&pool, &alex, &priya).await;
    let conversation_id = start(&app, &code, &alex_token, &[&sam, &priya]).await;
    // Like an older group: the System agent is in it, System is not.
    query(
        "DELETE FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(SYSTEM_ACCOUNT_ID)
    .execute(&pool)
    .await
    .unwrap();
    add_member(&pool, conversation_id, &system_agent()).await;

    let (_, theirs) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/results"),
        &sam_token,
        None,
    )
    .await;
    let reference = theirs["invitations"][0]["invitationRef"].as_str().unwrap();
    let (status, body) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/invitations/{reference}/join"),
        &sam_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        state(&pool, conversation_id, SYSTEM_ACCOUNT_ID)
            .await
            .as_deref(),
        Some("active")
    );
    assert_eq!(
        senders(&pool, conversation_id).await,
        vec![(SYSTEM_ACCOUNT_ID.to_string(), "system-notice".to_string())]
    );
}

#[tokio::test]
async fn system_agent_stays_out_of_grounding_groups() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, _)] = [people[0].clone(), people[1].clone()];
    make_contacts(&pool, &alex, &priya).await;
    let room_group = start(&app, &code, &alex_token, &[&priya]).await;
    let plain_group = Uuid::new_v4();
    crate::plan_cards::tests::seed_conversation(&pool, plain_group, &alex, &[&alex, &priya]).await;
    let system_agent = system_agent();

    crate::system_agent::membership::join_all_groups(&pool, &system_agent)
        .await
        .unwrap();
    assert_eq!(state(&pool, room_group, &system_agent).await, None);
    assert_eq!(
        state(&pool, plain_group, &system_agent).await.as_deref(),
        Some("active")
    );
    assert!(
        !crate::system_agent::membership::join_conversation(&pool, &system_agent, room_group)
            .await
            .unwrap()
    );
    assert_eq!(state(&pool, room_group, &system_agent).await, None);

    // A room group the System agent joined before this change loses it at
    // startup, and members' devices hear about it.
    add_member(&pool, room_group, &system_agent).await;
    let (before,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events
         WHERE account_id = $1 AND conversation_id = $2 AND event_type = 'membership.updated'",
    )
    .bind(&alex)
    .bind(room_group)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        crate::system_agent::membership::leave_room_groups(&pool, &system_agent)
            .await
            .unwrap()
            >= 1
    );
    assert_eq!(
        state(&pool, room_group, &system_agent).await.as_deref(),
        Some("removed")
    );
    assert_eq!(
        state(&pool, plain_group, &system_agent).await.as_deref(),
        Some("active"),
        "only Grounding groups lose the System agent"
    );
    let (after,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events
         WHERE account_id = $1 AND conversation_id = $2 AND event_type = 'membership.updated'",
    )
    .bind(&alex)
    .bind(room_group)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after, before + 1);
}
