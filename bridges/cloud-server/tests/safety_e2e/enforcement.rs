//! What a block stops: direct messages and reactions, new conversations and
//! group adds, and joining through the other's invite link. Shared groups
//! keep working.
use kordi_cloud_server::chat_sync::models::{
    AddConversationMembersRequest, ConversationKind, CreateConversationRequest,
};
use kordi_cloud_server::chat_sync::store::StoreError;

use super::*;

fn text(value: &str) -> Value {
    json!({"schema": 1, "blocks": [{"type": "text", "text": value}]})
}

async fn try_message(
    h: &Harness,
    sender: &Account,
    conversation: Uuid,
) -> Result<Uuid, StoreError> {
    chat_store::send_message(
        &h.pool,
        &sender.id,
        conversation,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: text("hello"),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .map(|outcome| outcome.value.id)
}

async fn group(h: &Harness, owner: &Account, members: &[&Account]) -> Result<Uuid, StoreError> {
    chat_store::create_conversation(
        &h.pool,
        &owner.id,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Team".to_string()),
            client_session_id: format!("session:group:{}", Uuid::new_v4().simple()),
            member_account_ids: members.iter().map(|member| member.id.clone()).collect(),
            organization_id: None,
        },
    )
    .await
    .map(|outcome| outcome.value.id)
}

/// A one-way contact row, as the older one-sided add wrote them.
async fn one_way_contact(h: &Harness, owner: &Account, peer: &Account) {
    query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(&owner.id)
    .bind(&peer.id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&h.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn a_block_stops_direct_messages_and_reactions_both_ways() {
    let Some(h) = harness().await else { return };
    let a = h.signup("Direct A").await;
    let b = h.signup("Direct B").await;
    h.request_contact(&a, &b, true).await;
    let chat = h.direct_chat(&a, &b).await;
    let earlier = try_message(&h, &a, chat).await.expect("contacts can write");

    assert_eq!(h.block(&b, &a.id).await.0, StatusCode::OK);
    // A one-way contact row left behind must not reopen the chat either.
    one_way_contact(&h, &a, &b).await;
    for sender in [&a, &b] {
        assert!(
            matches!(
                try_message(&h, sender, chat).await,
                Err(StoreError::Blocked)
            ),
            "{}",
            sender.id
        );
    }
    let reaction = chat_store::set_reaction(&h.pool, &a.id, chat, earlier, "👍", true).await;
    assert!(matches!(reaction, Err(StoreError::Blocked)));

    // The HTTP surface answers 403 CHAT_BLOCKED.
    let (status, body) = h
        .send(
            "POST",
            &format!("/v2/chat/conversations/{chat}/messages"),
            Some(&a.token),
            json!({ "client_message_id": Uuid::now_v7(), "kind": "text",
                    "content": text("still there?") }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "CHAT_BLOCKED", "{body}");

    // Unblocking reopens nothing until they are contacts again, but the
    // block itself no longer refuses the write.
    let (status, _) = h
        .send(
            "DELETE",
            &format!("/v1/cloud/blocks/{}", a.id),
            Some(&b.token),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(try_message(&h, &a, chat).await.is_ok());
}

#[tokio::test]
async fn shared_groups_keep_working_but_new_groups_and_adds_are_refused() {
    let Some(h) = harness().await else { return };
    let owner = h.signup("Group owner").await;
    let a = h.signup("Group A").await;
    let b = h.signup("Group B").await;
    h.request_contact(&owner, &a, true).await;
    h.request_contact(&owner, &b, true).await;
    h.request_contact(&a, &b, true).await;
    let shared = group(&h, &owner, &[&a, &b]).await.unwrap();

    assert_eq!(h.block(&a, &b.id).await.0, StatusCode::OK);
    assert!(
        try_message(&h, &b, shared).await.is_ok(),
        "groups stay open"
    );
    assert!(try_message(&h, &a, shared).await.is_ok());

    one_way_contact(&h, &a, &b).await;
    assert!(matches!(
        group(&h, &a, &[&b]).await,
        Err(StoreError::Blocked)
    ));
    let mine = group(&h, &a, &[&owner]).await.unwrap();
    let added = chat_store::add_conversation_members(
        &h.pool,
        &a.id,
        mine,
        AddConversationMembersRequest {
            client_operation_id: Uuid::now_v7(),
            member_account_ids: vec![b.id.clone()],
            replace: false,
        },
    )
    .await;
    assert!(matches!(added, Err(StoreError::Blocked)));
}

#[tokio::test]
async fn invite_links_between_blocked_accounts_are_refused() {
    let Some(h) = harness().await else { return };
    let admin = h.signup("Link admin").await;
    let member = h.signup("Link member").await;
    let blocked = h.signup("Link blocked").await;
    let other = h.signup("Link other").await;
    h.request_contact(&admin, &member, true).await;
    let group_id = format!("session:group:{}", Uuid::new_v4().simple());
    chat_store::create_conversation(
        &h.pool,
        &admin.id,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Product Team".to_string()),
            client_session_id: group_id.clone(),
            member_account_ids: vec![member.id.clone()],
            organization_id: None,
        },
    )
    .await
    .unwrap();
    let (status, created) = h
        .send(
            "POST",
            "/v1/cloud/invitations/groups",
            Some(&admin.token),
            json!({ "groupId": group_id, "groupSpaceId": group_id, "groupTitle": "Product Team" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let token = created["inviteUrl"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    let accept = format!("/v1/cloud/invitations/groups/accept/{token}");

    assert_eq!(h.block(&blocked, &admin.id).await.0, StatusCode::OK);
    let (status, body) = h
        .send("POST", &accept, Some(&blocked.token), Value::Null)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["errorCode"], "group_invitation_unavailable");

    let (status, body) = h
        .send("POST", &accept, Some(&other.token), Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn reports_can_block_in_the_same_request_without_telling_anyone() {
    let Some(h) = harness().await else { return };
    let reporter = h.signup("Blocking reporter").await;
    let reported = h.signup("Blocked by report").await;
    h.request_contact(&reporter, &reported, true).await;
    let mut body = json!({ "clientReportId": Uuid::new_v4(), "reason": "harassment",
                           "reportedAccountId": reported.id, "alsoBlock": true });
    let (status, created) = h.report(&reporter, body.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["blocked"], true);
    assert_eq!(h.contact_rows(&reporter, &reported).await, 0);
    let (status, replay) = h.report(&reporter, body.clone()).await;
    assert_eq!(
        (status, replay["blocked"].clone()),
        (StatusCode::OK, json!(true))
    );

    // The report waits for the support notice; nothing reaches the reported
    // account's sync stream about it.
    let (notice,): (String,) =
        query_as("SELECT notification_status FROM cloud_abuse_reports WHERE report_id = $1")
            .bind(created["report"]["reportId"].as_str().unwrap())
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(notice, "pending");
    let (told,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events WHERE account_id = $1 \
         AND (payload::TEXT LIKE '%rpt_%' OR payload::TEXT LIKE '%\"blocked\"%')",
    )
    .bind(&reported.id)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(told, 0);

    body["clientReportId"] = json!(Uuid::new_v4());
    body["alsoBlock"] = json!(false);
    let (status, plain) = h.report(&reporter, body).await;
    assert_eq!(
        (status, plain["blocked"].clone()),
        (StatusCode::CREATED, json!(false))
    );
}
