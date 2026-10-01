use super::*;

/// The owner's Mac: a macOS device that published readiness.
async fn ready_mac(group: &Group, contract: Option<u8>) {
    query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&group.owner.account_id)
        .execute(&group.pool)
        .await
        .unwrap();
    let mut body = json!({"agentIds": [group.agent()]});
    if let Some(contract) = contract {
        body["contextContract"] = json!(contract);
    }
    let (status, response) = call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/agent-runs/desktop/ready",
            Some(&group.owner.token),
            Some(body),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    // Fixture clocks keep readiness fresh regardless of scheduling delays.
    query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1")
        .bind(group.agent())
        .execute(&group.pool)
        .await
        .unwrap();
}

async fn desktop_claim(
    group: &Group,
    requester: &TestAccount,
    request_id: &str,
    contract: Option<u8>,
) -> (StatusCode, Value) {
    let claim_id = Uuid::new_v4();
    let mut body = json!({"claimId": claim_id, "requestMessageId": request_id,
        "sessionId": group.session, "ownerAccountId": group.owner.account_id,
        "requesterAccountId": requester.account_id, "prompt": "@Kordi help",
        "idempotencyKey": format!("desktop:{claim_id}")});
    if let Some(contract) = contract {
        body["contextContract"] = json!(contract);
    }
    call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/agent-runs/desktop/claim",
            Some(&group.owner.token),
            Some(body),
        ),
    )
    .await
}

async fn run_count(group: &Group, request_id: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE session_id=$1 AND request_message_id=$2",
    )
    .bind(&group.session)
    .bind(request_id)
    .fetch_one(&group.pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn legacy_macs_answer_only_where_their_local_context_is_safe() {
    let Some(group) = Group::new("contract-legacy").await else {
        return;
    };
    let tag = group.tag.clone();
    ready_mac(&group, None).await;
    // Another member's request in a mention-only group: a quiet refusal, so
    // the requester's app claims cloud fallback instead.
    let other = format!("r1-{tag}");
    group.ask(&group.requester, &other, "summarize", None).await;
    let (status, body) = desktop_claim(&group, &group.requester, &other, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["acquired"], false);
    assert_eq!(body["reason"], "desktop_update_required");
    assert!(body["runId"].is_null());
    assert_eq!(run_count(&group, &other).await, 0);

    // The owner's own request runs as before while no one opted out.
    let own = format!("o1-{tag}");
    group.ask(&group.owner, &own, "plan my day", None).await;
    let (status, body) = desktop_claim(&group, &group.owner, &own, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["acquired"], true);
    assert!(
        body.get("serverContext").is_none(),
        "legacy claims get no server context"
    );

    // Once a member opts out, the owner sees a visible update failure.
    let (status, _) = group
        .set_ai_access(&group.member, json!({"exclude_my_messages": true}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let own_again = format!("o2-{tag}");
    group
        .ask(&group.owner, &own_again, "plan again", None)
        .await;
    let (status, body) = desktop_claim(&group, &group.owner, &own_again, None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["errorCode"], "desktop_update_required");
    assert!(body["message"]
        .as_str()
        .unwrap()
        .starts_with("Update Kordi on this Mac"));
    assert_eq!(run_count(&group, &own_again).await, 0);
}

#[tokio::test]
async fn current_macs_receive_the_same_history_as_the_cloud() {
    let Some(group) = Group::new("contract-current").await else {
        return;
    };
    let tag = group.tag.clone();
    ready_mac(&group, Some(2)).await;
    let (status, _) = group
        .set_ai_access(&group.member, json!({"exclude_my_messages": true}))
        .await;
    assert_eq!(status, StatusCode::OK);
    group
        .say(
            &group.member,
            &format!("m-{tag}"),
            &format!("SECRET_M_{tag}"),
        )
        .await;
    group
        .say(
            &group.member2,
            &format!("c-{tag}"),
            &format!("CHATTER_M2_{tag}"),
        )
        .await;
    let target = group
        .say(
            &group.member2,
            &format!("t-{tag}"),
            &format!("TARGET_{tag}"),
        )
        .await;
    let request_id = format!("q-{tag}");
    group
        .ask(
            &group.requester,
            &request_id,
            "what about this",
            Some(&format!("t-{tag}")),
        )
        .await;
    let (status, body) = desktop_claim(&group, &group.requester, &request_id, Some(2)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["acquired"], true);
    let context = &body["serverContext"];
    assert_eq!(context["contract"], 2);
    assert_eq!(context["historyScope"], "mentions");
    let messages = context["messages"].as_array().unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|message| message["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![target.as_str()],
        "{context}"
    );
    assert_eq!(messages[0]["authorKind"], "human");
    assert_eq!(messages[0]["authorName"], "Max Member");
    assert!(messages[0]["text"].as_str().unwrap().contains("TARGET_"));
    assert!(messages[0]["createdAtMs"].as_i64().unwrap() > 0);
    let serialized = context.to_string();
    assert!(!serialized.contains("SECRET_M_") && !serialized.contains("CHATTER_M2_"));
    // Both runtimes render the access note from the run identity.
    let policy = body["turnIdentity"]["requestPolicy"].as_str().unwrap();
    assert!(policy.contains("Conversation access: this group shares messages with agents only when they are sent to them."));
    assert!(policy.contains("Some members don't allow other people's AI to use their messages."));
}

#[tokio::test]
async fn a_legacy_mac_does_not_delay_cloud_fallback_for_other_members() {
    let Some(group) = Group::new("contract-fallback").await else {
        return;
    };
    let tag = group.tag.clone();
    let (status, _) = call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/presence/online",
            Some(&group.owner.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text WHERE account_id=$1")
        .bind(&group.owner.account_id)
        .execute(&group.pool)
        .await
        .unwrap();
    ready_mac(&group, None).await;
    let first = format!("r1-{tag}");
    group.ask(&group.requester, &first, "help", None).await;
    let (status, body) = group.claim_cloud(&group.requester, &first).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["executionBackend"], "cloud");

    // Positive control: a current Mac is preferred for a fresh request.
    ready_mac(&group, Some(2)).await;
    let second = format!("r2-{tag}");
    group
        .ask(&group.requester, &second, "help again", None)
        .await;
    let (status, body) = group.claim_cloud(&group.requester, &second).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["errorCode"], "owner_online");
}
