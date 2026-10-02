use super::*;
use kordi_cloud_server::chat_sync::models::UpdateAiAccessRequest;

/// PiP's membership state, the stored setting, and the number of notices.
async fn pip_state(group: &Group) -> (Option<String>, bool, i64) {
    let pip = group.pip.as_ref().unwrap();
    let membership: Option<(String,)> = query_as(
        "SELECT membership_state FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(group.conversation)
    .bind(&pip.account_id)
    .fetch_optional(&group.pool)
    .await
    .unwrap();
    let (enabled,): (bool,) =
        query_as("SELECT pip_enabled FROM cloud_chat_ai_policies WHERE conversation_id = $1")
            .bind(group.conversation)
            .fetch_one(&group.pool)
            .await
            .unwrap();
    let (notices,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_chat_messages
         WHERE conversation_id = $1 AND message_kind = 'ai-access-notice'",
    )
    .bind(group.conversation)
    .fetch_one(&group.pool)
    .await
    .unwrap();
    (membership.map(|row| row.0), enabled, notices)
}

async fn set_role(group: &Group, account: &TestAccount, role: &str) {
    query(
        "UPDATE cloud_chat_conversation_members SET role = $3
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(group.conversation)
    .bind(&account.account_id)
    .bind(role)
    .execute(&group.pool)
    .await
    .unwrap();
}

async fn put_pip(
    group: &Group,
    actor: &TestAccount,
    operation: Uuid,
    enabled: bool,
) -> (StatusCode, Value) {
    call(
        &group.router,
        request(
            "PUT",
            &format!(
                "/v2/chat/conversations/{}/ai-access",
                group.encoded_session()
            ),
            Some(&actor.token),
            Some(json!({"client_operation_id": operation, "pip_enabled": enabled})),
        ),
    )
    .await
}

#[tokio::test]
async fn a_retried_turn_on_never_brings_pip_back_after_it_was_turned_off() {
    let Some(group) = Group::new("pip-retry", true).await else {
        return;
    };
    // An admin turns PiP on.
    set_role(&group, &group.requester, "admin").await;
    let first_on = Uuid::new_v4();
    let (status, body) = put_pip(&group, &group.requester, first_on, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["conversation"]["ai_access"]["pip"]["enabled"], true);
    assert_eq!(pip_state(&group).await.0.as_deref(), Some("active"));

    // The owner turns it off, and the admin is made an ordinary member.
    let (status, _) = group
        .set_ai_access(&group.owner, json!({"pip_enabled": false}))
        .await;
    assert_eq!(status, StatusCode::OK);
    set_role(&group, &group.requester, "member").await;
    let off = pip_state(&group).await;
    assert_eq!((off.0.as_deref(), off.1), (Some("removed"), false));

    // The old request, retried, changes nothing and reports the truth.
    let (status, body) = put_pip(&group, &group.requester, first_on, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["conversation"]["ai_access"]["pip"]["enabled"], false);
    assert_eq!(pip_state(&group).await, off);
    // A new request from the member is refused.
    let (status, _) = put_pip(&group, &group.requester, Uuid::new_v4(), true).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Someone who still manages the group gets the same answer from a retry.
    let owner_on = Uuid::new_v4();
    assert_eq!(
        put_pip(&group, &group.owner, owner_on, true).await.0,
        StatusCode::OK
    );
    assert_eq!(
        put_pip(&group, &group.owner, Uuid::new_v4(), false).await.0,
        StatusCode::OK
    );
    let off = pip_state(&group).await;
    let (status, body) = put_pip(&group, &group.owner, owner_on, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["conversation"]["ai_access"]["pip"]["enabled"], false);
    assert_eq!(pip_state(&group).await, off);

    // Positive control: a new request from the owner turns PiP on again.
    let (status, body) = put_pip(&group, &group.owner, Uuid::new_v4(), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["conversation"]["ai_access"]["pip"]["enabled"], true);
    let on = pip_state(&group).await;
    assert_eq!(
        (on.0.as_deref(), on.1, on.2),
        (Some("active"), true, off.2 + 1)
    );
}

#[tokio::test]
async fn turning_pip_off_before_a_pending_join_lands_keeps_pip_out() {
    let Some(group) = Group::new("pip-race", true).await else {
        return;
    };
    // The setting commits; the join that follows it has not run yet.
    let on = chat_store::update_ai_access(
        &group.pool,
        &group.owner.account_id,
        &group.session,
        UpdateAiAccessRequest {
            client_operation_id: Uuid::new_v4(),
            history_scope: None,
            pip_enabled: Some(true),
            exclude_my_messages: None,
        },
    )
    .await
    .unwrap();
    let (conversation_id, pip) = on.join_pip.expect("PiP joins after the commit");
    assert_eq!(pip_state(&group).await.0, None);

    // Another manager turns PiP off in between.
    let (status, _) = group
        .set_ai_access(&group.owner, json!({"pip_enabled": false}))
        .await;
    assert_eq!(status, StatusCode::OK);

    // The late join finds the setting off and changes nothing.
    assert!(!kordi_cloud_server::pip::membership::join_conversation(
        &group.pool,
        &pip,
        conversation_id
    )
    .await
    .unwrap());
    let state = pip_state(&group).await;
    assert_eq!((state.0, state.1), (None, false));
    let (status, view) = call(
        &group.router,
        request(
            "GET",
            &format!(
                "/v2/chat/conversations/{}/ai-access",
                group.encoded_session()
            ),
            Some(&group.member.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["ai_access"]["pip"]["enabled"], false);
}
