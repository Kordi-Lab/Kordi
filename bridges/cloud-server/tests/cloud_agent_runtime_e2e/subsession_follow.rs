use super::*;
use kordi_cloud_server::cloud_agent_runtime::runs;

pub(super) async fn verify(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    [owner, peer, outsider]: [&TestAccount; 3],
    id: &str,
    agent: &str,
    desktop: bool,
) {
    let uuid = uuid::Uuid::parse_str(id).unwrap();
    let uri = format!("/v1/cloud/agent-subsessions/{id}");
    let clock = || {
        sqlx_core::query_as::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT execution_started_at::text,execution_finished_at::text FROM cloud_agent_subsessions WHERE subsession_id=$1",
    ).bind(uuid).fetch_one(pool)
    };
    let original_clock = clock().await.unwrap();
    let snapshot = read_json(
        router
            .clone()
            .oneshot(get_with_token(
                &format!("{uri}?includeMessages=true"),
                &peer.token,
            ))
            .await
            .unwrap(),
    )
    .await;
    for account in [owner, peer] {
        let (avatar, seed): (Option<String>, String) = sqlx_core::query_as::query_as(
            "SELECT avatar_url,avatar_seed FROM cloud_accounts WHERE account_id=$1",
        )
        .bind(&account.account_id)
        .fetch_one(pool)
        .await
        .unwrap();
        let member = snapshot["participants"]
            .as_array()
            .unwrap()
            .iter()
            .find(|member| member["accountId"] == account.account_id)
            .unwrap();
        assert_eq!(member["avatarUrl"], json!(avatar));
        assert_eq!(member["avatarSeed"], seed);
        assert_ne!(
            seed, account.account_id,
            "account IDs must not generate replacement avatars"
        );
    }
    let (avatar,): (Option<String>,) = sqlx_core::query_as::query_as(
        "SELECT CASE WHEN $1='cloud-agent:'||$2 THEN (SELECT avatar_url FROM cloud_default_agent_profiles WHERE owner_account_id=$2) ELSE (SELECT avatar_url FROM cloud_agent_definitions WHERE agent_id=$1 AND owner_account_id=$2) END",
    ).bind(agent).bind(&owner.account_id).fetch_one(pool).await.unwrap();
    assert_eq!(snapshot["agentAvatarUrl"], json!(avatar));
    let input = |message: uuid::Uuid, text: &str, target: Option<&str>| {
        json!({
            "clientMessageId":message,"text":text,"mentions":target.map(|agent|vec![json!({
                "label":"Kordi","targetKind":"agent","agentId":agent,"targetIdentityId":agent,"startUtf16":0,"lengthUtf16":6
            })]).unwrap_or_default()
        })
    };
    for (actor, text, target) in [
        (peer, "Ordinary shared context", None),
        (owner, "@Kordi wrong identity", Some("another-agent")),
    ] {
        let response = router
            .clone()
            .oneshot(post_json_with_token(
                &format!("{uri}/messages"),
                &actor.token,
                input(uuid::Uuid::new_v4(), text, target),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let linked:(i64,)=sqlx_core::query_as::query_as("SELECT count(*) FROM cloud_agent_subsession_chat WHERE subsession_id=$1 AND run_id IS NOT NULL").bind(uuid).fetch_one(pool).await.unwrap();
    assert_eq!(
        linked.0, 0,
        "plain messages and wrong Agent IDs must not invoke a runtime"
    );
    assert_eq!(
        clock().await.unwrap(),
        original_clock,
        "ordinary conversation messages must not change execution time"
    );
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let request = input(a, "@Kordi explain", Some(agent));
    for actor in [peer, peer] {
        let response = router
            .clone()
            .oneshot(post_json_with_token(
                &format!("{uri}/messages"),
                &actor.token,
                request.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("{uri}/messages"),
            &owner.token,
            input(b, "@Kordi summarize", Some(agent)),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = read_json(response).await;
    let messages = response["messages"].as_array().unwrap();
    for (id, account) in [(a, &peer.account_id), (b, &owner.account_id)] {
        let row = messages
            .iter()
            .find(|row| row["id"] == id.to_string())
            .unwrap();
        assert_eq!(row["senderAccountId"], *account);
        assert!(
            row["senderAgentId"].is_null(),
            "human follow-ups must not be attributed to the Agent"
        );
    }
    assert_eq!(
        messages
            .iter()
            .find(|row| row["id"] == a.to_string())
            .unwrap()["requestState"],
        "pending"
    );
    assert_eq!(
        messages
            .iter()
            .find(|row| row["id"] == b.to_string())
            .unwrap()["requestState"],
        "queued"
    );
    assert_eq!(
        router
            .clone()
            .oneshot(post_json_with_token(
                &format!("{uri}/messages"),
                &outsider.token,
                input(uuid::Uuid::new_v4(), "Not allowed", None)
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let run_for = |message| {
        sqlx_core::query_as::query_as::<_, (String,)>(
            "SELECT run_id FROM cloud_agent_subsession_chat WHERE message_id=$1",
        )
        .bind(message)
        .fetch_one(pool)
    };
    let (run_a,) = run_for(a).await.unwrap();
    let (run_b,) = run_for(b).await.unwrap();
    let claim_id = uuid::Uuid::new_v4();
    if desktop {
        sqlx_core::query::query(
            "UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1",
        )
        .bind(&owner.account_id)
        .execute(pool)
        .await
        .unwrap();
        let ready = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/ready",
                &owner.token,
                json!({"agentIds":[agent]}),
            ))
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let claim = |message, claim| json!({"claimId":claim,"requestMessageId":message,"sessionId":id,"ownerAccountId":owner.account_id,"requesterAccountId":peer.account_id,"prompt":"@Kordi explain","idempotencyKey":format!("follow:{message}")});
        let blocked = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/claim",
                &owner.token,
                claim(b, uuid::Uuid::new_v4()),
            ))
            .await
            .unwrap();
        assert_eq!(read_json(blocked).await["acquired"], false);
        let acquired = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/claim",
                &owner.token,
                claim(a, claim_id),
            ))
            .await
            .unwrap();
        assert_eq!(read_json(acquired).await["acquired"], true);
        assert!(runs::lease_canary_run(pool, "other-runtime", &run_a)
            .await
            .unwrap()
            .is_none());
        let admitted = router
            .clone()
            .oneshot(post_json_with_token(
                &format!("/v1/cloud/agent-runs/desktop/{run_a}/admit"),
                &owner.token,
                json!({"claimId":claim_id}),
            ))
            .await
            .unwrap();
        assert_eq!(read_json(admitted).await["admitted"], true);
    } else {
        assert!(runs::lease_canary_run(pool, "out-of-order", &run_b)
            .await
            .unwrap()
            .is_none());
        let leased = runs::lease_canary_run(pool, "follow-a", &run_a)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(leased.subsession_id.as_deref(), Some(id));
        assert_eq!(leased.turn_identity["ownerAccountId"], owner.account_id);
        assert_eq!(leased.turn_identity["requesterAccountId"], peer.account_id);
        assert_eq!(leased.turn_identity["agentId"], agent);
        let history = serde_json::to_string(&leased.history_messages).unwrap();
        assert!(history.contains("CHILD_ONLY_RESULT"));
        assert!(history.contains("Ordinary shared context"));
        assert!(
            !history.contains("@Kordi summarize"),
            "future queued requests must not enter the current turn"
        );
        runs::mark_run_running(pool, &run_a, "follow-a")
            .await
            .unwrap();
    }
    let active = read_json(
        router
            .clone()
            .oneshot(get_with_token(
                &format!("{uri}?includeMessages=true"),
                &peer.token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(active["status"], "running");
    assert_eq!(active["agentId"], agent);
    let active_clock = clock().await.unwrap();
    assert!(active_clock.0.is_some());
    assert!(active_clock.1.is_none());
    if desktop {
        let body = format!(
            "kordi-cloud-agent-response:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                json!({"requestId":a,"text":"FOLLOW_A_ONLY","deliveryState":"complete"})
                    .to_string()
            )
        );
        let publication =
            json!({"claimId":claim_id,"clientMessageId":uuid::Uuid::new_v4(),"body":body});
        for _ in 0..2 {
            let response = router
                .clone()
                .oneshot(post_json_with_token(
                    &format!("/v1/cloud/agent-runs/desktop/{run_a}/progress"),
                    &owner.token,
                    publication.clone(),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        // Simulate the Mac going offline before the next queued request.
        sqlx_core::query::query("DELETE FROM cloud_agent_desktop_capabilities WHERE agent_id=$1")
            .bind(agent)
            .execute(pool)
            .await
            .unwrap();
    } else {
        runs::complete_run(pool, &run_a, "follow-a", "FOLLOW_A_ONLY")
            .await
            .unwrap();
    }
    let next = runs::lease_canary_run(pool, "follow-b", &run_b)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.owner_account_id, owner.account_id);
    assert_eq!(next.turn_identity["ownerAccountId"], owner.account_id);
    assert_eq!(next.turn_identity["requesterAccountId"], owner.account_id);
    assert_eq!(next.turn_identity["agentId"], agent);
    assert!(next
        .history_messages
        .iter()
        .any(|message| message["role"] == "runtimeIdentity"
            && message["content"]["requesterAccountId"] == peer.account_id));
    assert_eq!(next.subsession_id.as_deref(), Some(id));
    assert!(serde_json::to_string(&next.history_messages)
        .unwrap()
        .contains("FOLLOW_A_ONLY"));
    runs::mark_run_running(pool, &run_b, "follow-b")
        .await
        .unwrap();
    let next_clock = clock().await.unwrap();
    assert_ne!(
        next_clock.0, original_clock.0,
        "follow-ups start a new execution clock"
    );
    assert!(next_clock.1.is_none());
    runs::complete_run(pool, &run_b, "follow-b", "FOLLOW_B_ONLY")
        .await
        .unwrap();
    let finished = read_json(
        router
            .clone()
            .oneshot(get_with_token(
                &format!("{uri}?includeMessages=true"),
                &peer.token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(finished["status"], "done");
    assert!(clock().await.unwrap().1.is_some());
    let messages = finished["messages"].as_array().unwrap();
    assert_eq!(
        messages
            .iter()
            .filter(|row| row["id"] == a.to_string())
            .count(),
        1
    );
    assert_eq!(
        messages
            .iter()
            .filter(|row| row["text"] == "FOLLOW_A_ONLY")
            .count(),
        1
    );
    assert_eq!(
        messages
            .iter()
            .filter(|row| row["text"] == "FOLLOW_B_ONLY")
            .count(),
        1
    );
}
