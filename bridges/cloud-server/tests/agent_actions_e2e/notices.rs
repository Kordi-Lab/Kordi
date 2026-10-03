use super::*;

async fn latest_notice(group: &Group) -> Uuid {
    let (id,): (Uuid,) = query_as(
        "SELECT message_id FROM cloud_chat_messages
         WHERE conversation_id = $1 AND message_kind = 'ai-access-notice'
         ORDER BY conversation_sequence DESC LIMIT 1",
    )
    .bind(group.conversation)
    .fetch_one(&group.pool)
    .await
    .unwrap();
    id
}

async fn deleted_chat(group: &Group, account: &TestAccount) -> bool {
    let (deleted,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_account_session_visibility
                        WHERE account_id = $1 AND session_id = $2 AND deleted_at IS NOT NULL)",
    )
    .bind(&account.account_id)
    .bind(&group.session)
    .fetch_one(&group.pool)
    .await
    .unwrap();
    deleted
}

async fn digest_dirty(group: &Group, account: &TestAccount) -> bool {
    let (dirty,): (bool,) =
        query_as("SELECT dirty_since IS NOT NULL FROM cloud_account_digests WHERE account_id = $1")
            .bind(&account.account_id)
            .fetch_one(&group.pool)
            .await
            .unwrap();
    dirty
}

async fn clean_digest(group: &Group, account: &TestAccount) {
    query(
        "INSERT INTO cloud_account_digests(account_id, snapshot_json) VALUES($1, '{}'::jsonb)
         ON CONFLICT (account_id) DO UPDATE SET dirty_since = NULL, last_change_at = NULL",
    )
    .bind(&account.account_id)
    .execute(&group.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn notices_do_not_revive_chats_or_rerun_digests_and_stay_for_everyone() {
    let Some(group) = Group::new("notices", false).await else {
        return;
    };
    // The member deleted the chat from their list.
    query(
        "INSERT INTO cloud_account_session_visibility(account_id, session_id, deleted_at, updated_at)
         VALUES($1, $2, $3, $3)",
    )
    .bind(&group.member.account_id)
    .bind(&group.session)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&group.pool)
    .await
    .unwrap();
    clean_digest(&group, &group.requester).await;

    let (status, body) = group
        .set_ai_access(&group.owner, json!({"history_scope": "recent"}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let notice = latest_notice(&group).await;
    assert!(
        deleted_chat(&group, &group.member).await,
        "a notice does not revive a deleted chat"
    );
    assert!(
        !digest_dirty(&group, &group.requester).await,
        "a notice does not rerun digests"
    );

    // Turning the opt-out on rebuilds members' digests without those messages.
    let (status, _) = group
        .set_ai_access(&group.requester, json!({"exclude_my_messages": true}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(digest_dirty(&group, &group.requester).await);
    clean_digest(&group, &group.requester).await;
    let (status, _) = group
        .set_ai_access(&group.requester, json!({"exclude_my_messages": false}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!digest_dirty(&group, &group.requester).await);

    // Nobody can delete a notice for everyone, not even the member it names;
    // hiding it for oneself still works.
    let uri = format!(
        "/v2/chat/conversations/{}/messages/{notice}",
        group.conversation
    );
    let (status, body) = call(
        &group.router,
        request(
            "DELETE",
            &format!("{uri}?for_everyone=true"),
            Some(&group.owner.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "CHAT_FORBIDDEN");
    let (status, _) = call(
        &group.router,
        request("DELETE", &uri, Some(&group.owner.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (deleted_at,): (Option<chrono::DateTime<chrono::Utc>>,) =
        query_as("SELECT deleted_at FROM cloud_chat_messages WHERE message_id = $1")
            .bind(notice)
            .fetch_one(&group.pool)
            .await
            .unwrap();
    assert!(deleted_at.is_none());

    // Positive control: an ordinary message from someone else revives the
    // chat and marks digests.
    group
        .post(
            &group.owner,
            json!({"id": format!("hello-{}", group.tag), "senderAccountId": group.owner.account_id,
                "senderKind": "human", "text": "Dinner on Friday at seven?",
                "createdAtMs": chrono::Utc::now().timestamp_millis()}),
        )
        .await;
    assert!(!deleted_chat(&group, &group.member).await);
    assert!(digest_dirty(&group, &group.requester).await);
}
