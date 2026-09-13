use super::*;

async fn source_request(f: &Fixture) -> String {
    sqlx_core::query_as::query_as::<_, (String,)>(
        "SELECT request_message_id FROM cloud_agent_fallback_runs WHERE run_id=$1",
    )
    .bind(&f.run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap()
    .0
}

fn member_request(f: &Fixture, source: Option<&str>, args: Value) -> Request<Body> {
    post_json_with_token(
        "/v1/cloud/agent-runs/desktop/read-context",
        &f.owner.token,
        json!({"sessionId":f.session,"sourceRequestId":source,"tool":"read_session","arguments":args}),
    )
}

#[tokio::test]
async fn child_history_remains_available_after_parent_completion_but_keeps_requester_visibility() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let source = source_request(&f).await;
    query("UPDATE cloud_agent_fallback_runs SET status='completed',lease_expires_at=(now()-interval '1 minute')::text WHERE run_id=$1")
        .bind(&f.run_id).execute(&f.pool).await.unwrap();
    assert!(
        !f.read(f.args(&f.first, &f.attachment))
            .await
            .status()
            .is_success(),
        "execution lease remains expired"
    );
    let reply = f
        .router
        .clone()
        .oneshot(member_request(
            &f,
            Some(&source),
            f.args(&f.first, &f.attachment),
        ))
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::OK);
    assert_eq!(read_json(reply).await["media"][0]["type"], "image");
    query("INSERT INTO cloud_chat_attachment_visibility(account_id,message_id,attachment_id) VALUES($1,$2::text::uuid,$3)")
        .bind(&f.peer.account_id).bind(&f.first).bind(&f.attachment).execute(&f.pool).await.unwrap();
    let hidden = f
        .router
        .clone()
        .oneshot(member_request(
            &f,
            Some(&source),
            f.args(&f.first, &f.attachment),
        ))
        .await
        .unwrap();
    assert!(!hidden.status().is_success());
    let private_owner = f
        .router
        .clone()
        .oneshot(member_request(&f, None, f.args(&f.first, &f.attachment)))
        .await
        .unwrap();
    assert_eq!(
        private_owner.status(),
        StatusCode::OK,
        "private Ask Agent uses the owner's visibility"
    );
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
        .bind(f.conversation).bind(&f.peer.account_id).execute(&f.pool).await.unwrap();
    let revoked = f
        .router
        .clone()
        .oneshot(member_request(
            &f,
            Some(&source),
            f.args(&f.second, &f.second_attachment),
        ))
        .await
        .unwrap();
    assert!(!revoked.status().is_success());
}

#[tokio::test]
async fn member_history_denies_cross_scope_unknown_source_and_revocation_during_download() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let other = f
        .router
        .clone()
        .oneshot(member_request(
            &f,
            None,
            json!({"sessionId":"another-chat","mode":"index"}),
        ))
        .await
        .unwrap();
    assert!(!other.status().is_success());
    let unknown = f
        .router
        .clone()
        .oneshot(member_request(
            &f,
            Some("unadmitted-request"),
            f.args(&f.first, &f.attachment),
        ))
        .await
        .unwrap();
    assert!(!unknown.status().is_success());
    let request = member_request(&f, None, f.args(&f.first, &f.attachment));
    *f.gate.lock().await = true;
    let router = f.router.clone();
    let pending = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    f.started.notified().await;
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
        .bind(f.conversation).bind(&f.owner.account_id).execute(&f.pool).await.unwrap();
    f.release.notify_one();
    assert!(!pending.await.unwrap().status().is_success());
}

#[tokio::test]
async fn member_images_work_for_private_direct_and_group_conversations() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    for (kind, members) in [
        (ConversationKind::Ai, vec![]),
        (ConversationKind::Direct, vec![f.peer.account_id.clone()]),
        (ConversationKind::Group, vec![f.peer.account_id.clone()]),
    ] {
        let scope = if matches!(kind, ConversationKind::Direct) {
            let mut accounts = [f.owner.account_id.as_str(), f.peer.account_id.as_str()];
            accounts.sort();
            format!("session:direct-person:{}:{}", accounts[0], accounts[1])
        } else {
            format!("session:member-media:{}", uuid::Uuid::new_v4())
        };
        let conversation =
            create_test_conversation(&f.pool, &f.owner.account_id, &scope, kind, members).await;
        let message = insert_test_message(
            &f.pool,
            &f.owner.account_id,
            conversation,
            "Synthetic image",
        )
        .await;
        let attachment =
            Fixture::attach(&f.pool, &f.owner, &message, images::RED_BLUE, &f.objects).await;
        let response = f.router.clone().oneshot(post_json_with_token("/v1/cloud/agent-runs/desktop/read-context",&f.owner.token,
            json!({"sessionId":scope,"tool":"read_session","arguments":{"sessionId":scope,"mode":"attachment","messageIds":[message],"attachmentId":attachment,"expectedVersion":1}}))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(read_json(response).await["media"][0]["type"], "image");
    }
}
