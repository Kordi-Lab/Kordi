//! Default-agent runs on the owner's desktop stop when their requester stops
//! being the owner's contact, as cloud runs do, even in a group where both
//! may still chat: renewing, admitting, or publishing a held run cancels it.
//! A run that already finished keeps answering a retry of its final update.
use super::consent_admission::{group_request, remove_contact, run_state};
use super::*;

pub(super) async fn desktop_call(
    router: &axum::Router,
    owner: &TestAccount,
    path: String,
    body: Value,
) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{path}"),
            &owner.token,
            body,
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

fn revoked(state: (String, Option<String>)) {
    assert_eq!(
        state,
        (
            "cancelled".to_string(),
            Some("relationship_revoked".to_string())
        )
    );
}

#[tokio::test]
async fn owner_desktop_group_runs_stop_when_the_requester_loses_access() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "consent-desktop-group-owner", "Owner").await;
    let requester = signup(&router, "consent-desktop-group-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    let session = format!("session:group:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Group,
        vec![requester.account_id.clone()],
    )
    .await;
    let agent = format!("cloud-agent:{}", owner.account_id);
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = desktop_call(
        &router,
        &owner,
        "ready".into(),
        json!({"agentIds": [agent]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Four requests from a contact, each held by the owner's desktop.
    let mut held = Vec::new();
    for _ in 0..4 {
        let (request, body) = group_request(&session, &owner, &requester, &agent);
        let wire_id = insert_test_message(&pool, &requester.account_id, conversation, &body).await;
        let claim_id = uuid::Uuid::new_v4();
        let mut input = claim_body_with_session(&owner, &requester, &request, &session);
        input["claimId"] = json!(claim_id);
        input["requestMessageId"] = json!(wire_id);
        let (status, claimed) = desktop_call(&router, &owner, "claim".into(), input).await;
        assert_eq!(status, StatusCode::OK, "{claimed}");
        assert_eq!(claimed["acquired"], true, "{claimed}");
        let run_id = claimed["runId"].as_str().unwrap().to_string();
        let (request_id,): (String,) = sqlx_core::query_as::query_as(
            "SELECT request_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        held.push((run_id, claim_id, request_id));
    }
    let renew = |index: usize| {
        let (run_id, claim_id, _) = &held[index];
        desktop_call(
            &router,
            &owner,
            format!("{run_id}/renew"),
            json!({"claimId": claim_id}),
        )
    };
    assert_eq!(renew(0).await.0, StatusCode::OK);
    let created_at_ms = chrono::Utc::now().timestamp_millis();
    let answer = |index: usize, text: &str, client_message_id: uuid::Uuid| {
        let (run_id, claim_id, request_id) = &held[index];
        let envelope = json!({
            "kind": "group-message", "groupId": session, "groupSpaceId": session,
            "createdByAccountId": owner.account_id,
            "actor": {"accountId": owner.account_id, "displayName": "Owner"},
            "participants": [
                {"accountId": owner.account_id, "displayName": "Owner", "role": "admin"},
                {"accountId": requester.account_id, "displayName": "Requester", "role": "person"}
            ],
            "message": {"id": format!("response-{client_message_id}"),
                        "senderAccountId": owner.account_id, "senderKind": "agent",
                        "senderAgentId": agent, "requestId": request_id,
                        "text": text, "deliveryState": "complete", "createdAtMs": created_at_ms}
        });
        desktop_call(
            &router,
            &owner,
            format!("{run_id}/progress"),
            json!({"claimId": claim_id, "clientMessageId": client_message_id,
                   "body": encode_test_cloud_group_envelope(envelope)}),
        )
    };
    // One run finishes while the two are still contacts.
    let finished = uuid::Uuid::new_v4();
    let (status, posted) = answer(3, "Desktop answer before removal", finished).await;
    assert_eq!(status, StatusCode::OK, "{posted}");

    remove_contact(&pool, &owner, &requester).await;

    // Renewing a held run cancels it.
    let (status, body) = renew(0).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["errorCode"], "execution_lease_lost");
    revoked(run_state(&pool, &held[0].0).await);

    // Admitting a held run cancels it.
    let (run_id, claim_id, _) = &held[1];
    let (status, body) = desktop_call(
        &router,
        &owner,
        format!("{run_id}/admit"),
        json!({"claimId": claim_id}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    revoked(run_state(&pool, run_id).await);

    // Publishing a held run's answer cancels it, and nothing reaches the group.
    let (status, body) = answer(2, "Desktop answer after removal", uuid::Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["errorCode"], "execution_progress_rejected");
    revoked(run_state(&pool, &held[2].0).await);

    // Retrying the finished run's final update still answers with its message.
    let (status, retried) = answer(3, "Desktop answer before removal", finished).await;
    assert_eq!(status, StatusCode::OK, "{retried}");
    assert_eq!(retried["messageId"], posted["messageId"]);
    assert_eq!(run_state(&pool, &held[3].0).await.0, "completed");
    let (delivered,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_chat_messages WHERE conversation_id = $1 \
         AND sender_account_id = $2",
    )
    .bind(conversation)
    .bind(&owner.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(delivered, 1);
}
