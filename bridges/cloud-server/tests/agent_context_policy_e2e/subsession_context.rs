//! Agent task threads (subsessions) are shared with the members of their
//! group, and a follow-up run reads the thread's earlier posts and follow-ups
//! as context. A member who turned on "Don't let AI use my messages" is left
//! out of that context on every path: the desktop pending follow-up, the cloud
//! runner lease, and the OMP runtime context.

use super::*;
use kordi_cloud_server::cloud_agent_runtime::runs;

/// Posts to a task thread, mentioning the bound agent when `agent` is set.
async fn thread_post(
    group: &Group,
    thread: Uuid,
    sender: &TestAccount,
    text: &str,
    agent: Option<&str>,
) -> Uuid {
    let message = Uuid::new_v4();
    let mentions = agent
        .map(|agent| {
            json!([{"label": "Kordi", "targetKind": "agent", "agentId": agent,
                "targetIdentityId": agent, "startUtf16": 0, "lengthUtf16": 6}])
        })
        .unwrap_or_else(|| json!([]));
    let (status, body) = call(
        &group.router,
        request(
            "POST",
            &format!("/v1/cloud/agent-subsessions/{thread}/messages"),
            Some(&sender.token),
            Some(json!({"clientMessageId": message, "text": text, "mentions": mentions})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    message
}

/// The owner's Mac publishes a finished task thread for the requester's request.
async fn publish_thread(group: &Group, parent_request: &str) -> Uuid {
    let thread = Uuid::new_v4();
    let (status, body) = call(
        &group.router,
        request(
            "PUT",
            &format!("/v1/cloud/agent-subsessions/{thread}"),
            Some(&group.owner.token),
            Some(json!({
                "parentSessionId": group.session, "parentRequestId": parent_request,
                "title": "Trip plan", "status": "done", "expectedVersion": 0,
                "messages": [
                    {"id": "brief", "role": "user", "text": "Plan the trip", "timestampMs": 1000},
                    {"id": "result", "role": "assistant",
                        "text": format!("CHILD_RESULT_{}", group.tag), "timestampMs": 2000},
                ],
            })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    thread
}

/// What the OMP runtime receives for a leased cloud run.
async fn omp_context(group: &Group, run_id: &str) -> Value {
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let (status, published) = call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            Some(&group.owner.token),
            Some(json!({"provider": "openai", "authChoice": "default",
                "payload": {"accessToken": "synthetic-omp-subsession-test"}})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{published}");
    let (snapshot,): (String,) = query_as(
        "SELECT snapshot_id FROM cloud_agent_provider_auth_snapshots
         WHERE account_id=$1 AND revoked_at IS NULL",
    )
    .bind(&group.owner.account_id)
    .fetch_one(&group.pool)
    .await
    .unwrap();
    let run_token = group.lease_for_runner(run_id).await;
    query(
        "UPDATE cloud_agent_fallback_runs SET status='running', execution_backend='cloud',
             runtime_route_json=$2 WHERE run_id=$1",
    )
    .bind(run_id)
    .bind(
        json!({"defaultModel": "openai/fixture-model", "defaultAuthProvider": "openai",
        "defaultAuthChoice": "default"}),
    )
    .execute(&group.pool)
    .await
    .unwrap();
    let mut context = request(
        "POST",
        &format!("/v1/cloud/agent-runs/{run_id}/omp-context"),
        Some(RUNNER_TOKEN),
        Some(
            json!({"runnerId": RUNNER_ID, "provider": "openai", "model": "fixture-model",
            "authSnapshotId": snapshot}),
        ),
    );
    context
        .headers_mut()
        .insert("x-kordi-run-token", run_token.parse().unwrap());
    let (status, context) = call(&group.router, context).await;
    assert_eq!(status, StatusCode::OK, "{context}");
    context
}

#[tokio::test]
async fn an_opted_out_members_task_thread_posts_never_reach_the_agent() {
    let Some(group) = Group::new("policy-thread").await else {
        return;
    };
    let tag = group.tag.clone();
    let parent_request = format!("q-{tag}");
    group
        .ask(&group.requester, &parent_request, "plan the trip", None)
        .await;
    let thread = publish_thread(&group, &parent_request).await;

    let secret = format!("SECRET_M_{tag}");
    let chatter = format!("CHATTER_M2_{tag}");
    let own_note = format!("REQUESTER_NOTE_{tag}");
    let owner_note = format!("OWNER_NOTE_{tag}");
    thread_post(&group, thread, &group.member, &secret, None).await;
    thread_post(&group, thread, &group.member2, &chatter, None).await;
    thread_post(&group, thread, &group.requester, &own_note, None).await;
    thread_post(&group, thread, &group.owner, &owner_note, None).await;
    // The member also asked the agent in the thread, and it answered.
    let member_ask = format!("MEMBER_ASK_{tag}");
    let member_reply = format!("MEMBER_REPLY_{tag}");
    let asked = thread_post(
        &group,
        thread,
        &group.member,
        &format!("@Kordi {member_ask}"),
        Some(&group.agent()),
    )
    .await;
    query(
        "UPDATE cloud_agent_fallback_runs SET status='completed', completed_at=now()::text
         WHERE run_id=(SELECT run_id FROM cloud_agent_subsession_chat WHERE message_id=$1)",
    )
    .bind(asked)
    .execute(&group.pool)
    .await
    .unwrap();
    query("UPDATE cloud_agent_subsession_chat SET response_text=$2 WHERE message_id=$1")
        .bind(asked)
        .bind(&member_reply)
        .execute(&group.pool)
        .await
        .unwrap();
    // The member keeps their messages from other people's AI. The requester
    // and the owner opt out too: their own opt-outs never apply to their own
    // runs.
    for account in [&group.member, &group.requester, &group.owner] {
        let (status, body) = group
            .set_ai_access(account, json!({"exclude_my_messages": true}))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let follow_up = thread_post(
        &group,
        thread,
        &group.requester,
        &format!("@Kordi continue {tag}"),
        Some(&group.agent()),
    )
    .await;
    let (run_id,): (String,) =
        query_as("SELECT run_id FROM cloud_agent_subsession_chat WHERE message_id=$1")
            .bind(follow_up)
            .fetch_one(&group.pool)
            .await
            .unwrap();

    // The owner's Mac lists the queued follow-up with its thread context.
    let (status, pending) = call(
        &group.router,
        request(
            "GET",
            "/v1/cloud/agent-subsessions/pending",
            Some(&group.owner.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{pending}");
    let desktop = pending
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["runId"] == run_id)
        .unwrap_or_else(|| panic!("follow-up is pending: {pending}"))["contextMessages"]
        .to_string();

    // A cloud runner leases the follow-up with the thread history.
    let leased = runs::lease_canary_run(&group.pool, RUNNER_ID, &run_id)
        .await
        .unwrap()
        .expect("the follow-up is leased");
    assert_eq!(leased.subsession_id, Some(thread.to_string()));
    let lease = serde_json::to_string(&leased.history_messages).unwrap();

    // The OMP runtime reads the same history through its context route.
    let omp = omp_context(&group, &run_id).await.to_string();

    let views = [
        ("desktop pending follow-up", &desktop),
        ("cloud lease", &lease),
        ("OMP context", &omp),
    ];
    let leaked: Vec<(&str, &String)> = views
        .iter()
        .flat_map(|(name, text)| {
            [&secret, &member_ask, &member_reply]
                .into_iter()
                .filter(|left_out| text.contains(left_out.as_str()))
                .map(move |left_out| (*name, left_out))
        })
        .collect();
    assert!(
        leaked.is_empty(),
        "an opted-out member's thread messages reached {leaked:?}"
    );
    for (name, text) in views {
        for kept in [&chatter, &own_note, &owner_note] {
            assert!(text.contains(kept.as_str()), "{name} keeps {kept}: {text}");
        }
    }
    for (name, text) in [("cloud lease", &lease), ("OMP context", &omp)] {
        assert!(
            text.contains(&format!("CHILD_RESULT_{tag}")),
            "{name} keeps the task result: {text}"
        );
    }
}
