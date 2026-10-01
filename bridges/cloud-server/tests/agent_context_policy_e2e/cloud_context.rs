use super::*;

/// A mention-only group history around R's request Q, with M opted out.
struct History {
    group: Group,
    secret: String,
    chatter: String,
    earlier: String,
    reply: String,
    forged_earlier: String,
    target: String,
    current: String,
    forged_current: String,
    notice: String,
}

impl History {
    async fn new(prefix: &str) -> Option<Self> {
        let group = Group::new(prefix).await?;
        let tag = group.tag.clone();
        let (status, body) = group
            .set_ai_access(&group.member, json!({"exclude_my_messages": true}))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (notice,): (String,) = query_as(
            "SELECT message_id::text FROM cloud_chat_messages
             WHERE conversation_id=$1 AND message_kind='ai-access-notice'",
        )
        .bind(group.conversation)
        .fetch_one(&group.pool)
        .await
        .unwrap();
        let secret = group
            .say(
                &group.member,
                &format!("m-{tag}"),
                &format!("SECRET_M_{tag}"),
            )
            .await;
        let chatter = group
            .say(
                &group.member2,
                &format!("c-{tag}"),
                &format!("CHATTER_M2_{tag}"),
            )
            .await;
        let earlier_id = format!("e-{tag}");
        let earlier = group
            .ask(
                &group.requester,
                &earlier_id,
                &format!("EARLIER_{tag}"),
                None,
            )
            .await;
        let (status, body) = group.claim_cloud(&group.requester, &earlier_id).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let reply = group
            .reply(&format!("a-{tag}"), &earlier_id, &format!("REPLY_{tag}"))
            .await;
        // Another member reuses the earlier request's id.
        let forged_earlier = group
            .say(
                &group.member2,
                &earlier_id,
                &format!("FORGED_EARLIER_{tag}"),
            )
            .await;
        let target = group
            .say(
                &group.member2,
                &format!("t-{tag}"),
                &format!("TARGET_{tag}"),
            )
            .await;
        let current_id = format!("q-{tag}");
        let current = group
            .ask(
                &group.requester,
                &current_id,
                &format!("CURRENT_{tag}"),
                Some(&format!("t-{tag}")),
            )
            .await;
        // ...and later reuses the current request's id.
        let forged_current = group
            .say(
                &group.member2,
                &current_id,
                &format!("FORGED_CURRENT_{tag}"),
            )
            .await;
        Some(Self {
            group,
            secret,
            chatter,
            earlier,
            reply,
            forged_earlier,
            target,
            current,
            forged_current,
            notice,
        })
    }

    fn tag(&self) -> &str {
        &self.group.tag
    }
}

#[tokio::test]
async fn the_cloud_prompt_holds_only_what_the_request_may_use() {
    let Some(history) = History::new("policy-prompt").await else {
        return;
    };
    let group = &history.group;
    let tag = history.tag();
    let (status, run) = group
        .claim_cloud(&group.requester, &format!("q-{tag}"))
        .await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let prompt = group.run_prompt(run["runId"].as_str().unwrap()).await;
    for included in [
        format!("EARLIER_{tag}"),
        format!("REPLY_{tag}"),
        format!("TARGET_{tag}"),
    ] {
        assert!(prompt.contains(&included), "missing {included}: {prompt}");
    }
    assert!(
        prompt.ends_with(&format!("Current request:\nCURRENT_{tag}")),
        "the current request is the requester's own message: {prompt}"
    );
    for excluded in [
        format!("SECRET_M_{tag}"),
        format!("CHATTER_M2_{tag}"),
        format!("FORGED_EARLIER_{tag}"),
        format!("FORGED_CURRENT_{tag}"),
        "Don't let AI use my messages".to_string(),
    ] {
        assert!(!prompt.contains(&excluded), "leaked {excluded}: {prompt}");
    }
    let (system,): (String,) =
        query_as("SELECT system_prompt FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(run["runId"].as_str().unwrap())
            .fetch_one(&group.pool)
            .await
            .unwrap();
    assert!(system.contains("to find older messages you are allowed to see"));
}

#[tokio::test]
async fn run_retrieval_follows_scope_and_opt_outs() {
    let Some(history) = History::new("policy-retrieval").await else {
        return;
    };
    let group = &history.group;
    let tag = history.tag().to_string();
    let (status, run) = group
        .claim_cloud(&group.requester, &format!("q-{tag}"))
        .await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let run_id = run["runId"].as_str().unwrap().to_string();
    let token = group.lease_for_runner(&run_id).await;
    let read = |tool: &'static str, arguments: Value| {
        let (run_id, token) = (run_id.clone(), token.clone());
        async move { group.runner_read(&run_id, &token, tool, arguments).await }
    };

    let (status, index) = read(
        "read_session",
        json!({"sessionId": group.session, "mode": "index"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{index}");
    let ids = message_ids(&index);
    for admitted in [
        &history.earlier,
        &history.reply,
        &history.target,
        &history.current,
    ] {
        assert!(ids.contains(admitted), "{admitted} missing from {ids:?}");
    }
    for left_out in [
        &history.secret,
        &history.chatter,
        &history.forged_earlier,
        &history.forged_current,
        &history.notice,
    ] {
        assert!(!ids.contains(left_out), "{left_out} leaked in {ids:?}");
    }
    let search = |query_text: String| {
        read(
            "search_sessions",
            json!({"query": query_text, "includeMessages": true}),
        )
    };
    let (status, hits) = search(format!("TARGET_{tag}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(message_ids(&hits), vec![history.target.clone()]);
    for hidden in [format!("SECRET_M_{tag}"), format!("CHATTER_M2_{tag}")] {
        let (status, hits) = search(hidden).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(hits["sessions"], json!([]), "{hits}");
    }
    let (status, selected) = read(
        "read_session",
        json!({"sessionId": group.session, "mode": "messages",
            "messageIds": [history.secret, history.target]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(message_ids(&selected), vec![history.target.clone()]);
    let (status, _) = read(
        "read_session",
        json!({"sessionId": group.session, "mode": "index", "aroundMessageId": history.secret}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a left-out message anchors nothing"
    );

    // Recent messages: other members' chatter becomes readable, opted-out
    // members' messages never do.
    let (status, _) = group
        .set_ai_access(&group.owner, json!({"history_scope": "recent"}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, hits) = search(format!("CHATTER_M2_{tag}")).await;
    assert_eq!(message_ids(&hits), vec![history.chatter.clone()]);
    let (_, hits) = search(format!("SECRET_M_{tag}")).await;
    assert_eq!(hits["sessions"], json!([]));
}

#[tokio::test]
async fn private_reads_and_digests_apply_opt_outs_but_not_scope() {
    let Some(history) = History::new("policy-private").await else {
        return;
    };
    let group = &history.group;
    let tag = history.tag();
    let member_read = |source: Option<&str>, query_text: String| {
        call(
            &group.router,
            request(
                "POST",
                "/v1/cloud/agent-runs/desktop/read-context",
                Some(&group.owner.token),
                Some(
                    json!({"sessionId": group.session, "sourceRequestId": source,
                    "tool": "search_sessions",
                    "arguments": {"query": query_text, "includeMessages": true}}),
                ),
            ),
        )
    };
    // The owner's own private assistant: everything but opted-out members.
    let (status, hits) = member_read(None, format!("CHATTER_M2_{tag}")).await;
    assert_eq!(status, StatusCode::OK, "{hits}");
    assert_eq!(message_ids(&hits), vec![history.chatter.clone()]);
    let (_, hits) = member_read(None, format!("SECRET_M_{tag}")).await;
    assert_eq!(hits["sessions"], json!([]));
    // A read for another member's request gets that request's scope.
    let (status, run) = group
        .claim_cloud(&group.requester, &format!("q-{tag}"))
        .await;
    assert_eq!(status, StatusCode::OK, "{run}");
    group.lease_for_runner(run["runId"].as_str().unwrap()).await;
    let (status, hits) = member_read(Some(&format!("q-{tag}")), format!("CHATTER_M2_{tag}")).await;
    assert_eq!(status, StatusCode::OK, "{hits}");
    assert_eq!(hits["sessions"], json!([]));

    // Digests: other members' digests leave the opted-out member out; the
    // member's own digest keeps their messages. Notices are never sources.
    let pool = &group.pool;
    let authorized = |account: &TestAccount, id: &String| {
        let (account, id) = (account.account_id.clone(), id.clone());
        async move {
            kordi_cloud_server::digest::authorized(pool, &account, &[id])
                .await
                .unwrap()
        }
    };
    assert!(!authorized(&group.owner, &history.secret).await);
    assert!(!authorized(&group.member2, &history.secret).await);
    assert!(authorized(&group.member, &history.secret).await);
    assert!(authorized(&group.owner, &history.chatter).await);
    assert!(!authorized(&group.owner, &history.notice).await);
}
