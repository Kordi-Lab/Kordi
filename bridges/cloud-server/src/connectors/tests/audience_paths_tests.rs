//! Consent boundary through the real run-creating paths (issue 1712, PR 5):
//! person and scheduled claims, the desktop claim, spawned subsessions, the
//! digest refresh, and the PiP sweep each record the audience themselves.

use super::audience_tests::conversation;
use super::broker_tests::TEST_RUNNER;
use super::*;
use crate::chat_sync::models::SendMessageRequest;
use crate::cloud_agent_runtime::runs::subsessions::{execute_tool, ToolInput};
use crate::cloud_agent_runtime::runs::{
    claim_run, claim_run_for_desktop, claim_run_for_person_message, lease_canary_run,
    ClaimRunRequest,
};
use crate::connectors::delivery;

async fn audience_of(pool: &PgPool, run_id: &str) -> String {
    let (audience,): (String,) =
        query_as("SELECT connector_audience FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(pool)
            .await
            .unwrap();
    audience
}

fn claim(owner: &str, session: &str, requester: &str) -> ClaimRunRequest {
    let id = Uuid::new_v4().simple();
    ClaimRunRequest {
        request_message_id: format!("msg_{id}"),
        session_id: session.to_string(),
        owner_account_id: owner.to_string(),
        requester_account_id: requester.to_string(),
        prompt: "Check my items".into(),
        runtime_route: None,
        idempotency_key: format!("audience:{id}"),
    }
}

async fn set_membership(pool: &PgPool, session: &str, account: &str, state: &str) {
    query(
        "UPDATE cloud_chat_conversation_members SET membership_state = $3 \
         WHERE account_id = $2 AND conversation_id = \
           (SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id = $1)",
    )
    .bind(session)
    .bind(account)
    .bind(state)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn claims_record_the_audience_of_their_conversation() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "paths_owner").await;
    let (contact, _) = signed_in_account(&pool, "paths_contact").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await;
    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();

    // Another member who left or was removed could still have read it.
    let left = conversation(&pool, "ai", &owner, &[&contact]).await;
    set_membership(&pool, &left, &contact, "left").await;
    let removed = conversation(&pool, "ai", &owner, &[&contact]).await;
    set_membership(&pool, &removed, &contact, "removed").await;
    for (label, session) in [("left", &left), ("removed", &removed)] {
        let run = claim_run_for_person_message(&pool, &claim(&owner, session, &owner))
            .await
            .unwrap();
        assert_eq!(audience_of(&pool, &run.run_id).await, "shared", "{label}");
    }

    // A scheduled task in its default session has no private conversation.
    let scheduled = claim_run(
        &pool,
        &claim(&owner, &format!("session:scheduled:{owner}"), &owner),
    )
    .await
    .unwrap();
    assert_eq!(audience_of(&pool, &scheduled.run_id).await, "shared");

    // The desktop claim: private gets read and act on the Mac lease; a group
    // gets nothing.
    let private = conversation(&pool, "ai", &owner, &[]).await;
    let group = conversation(&pool, "group", &owner, &[&contact]).await;
    let mut groups = Vec::new();
    for session in [&private, &group] {
        let executor = format!("desktop:dev_paths:{}", Uuid::new_v4());
        let run = claim_run_for_desktop(&pool, &claim(&owner, session, &owner), &executor)
            .await
            .unwrap();
        let tools = delivery::deliver_to_run(&pool, &runtime.providers, &run.run_id).await;
        groups.push((
            audience_of(&pool, &run.run_id).await,
            tools.iter().map(|tool| tool.group).collect::<Vec<_>>(),
        ));
    }
    assert_eq!(
        groups,
        [
            (
                "owner_private".to_string(),
                vec![ConnectorToolGroup::Read, ConnectorToolGroup::Act]
            ),
            ("shared".to_string(), Vec::new()),
        ]
    );
}

#[tokio::test]
async fn spawned_subsessions_inherit_the_parent_audience() {
    let Some(pool) = pool().await else { return };
    let (owner, _) = signed_in_account(&pool, "spawn_owner").await;
    let (contact, _) = signed_in_account(&pool, "spawn_contact").await;
    let private = conversation(&pool, "ai", &owner, &[]).await;
    let group = conversation(&pool, "group", &owner, &[&contact]).await;
    for (session, expected) in [(&private, "owner_private"), (&group, "shared")] {
        let parent = claim_run_for_person_message(&pool, &claim(&owner, session, &owner))
            .await
            .unwrap();
        assert_eq!(audience_of(&pool, &parent.run_id).await, expected);
        lease_canary_run(&pool, TEST_RUNNER, &parent.run_id)
            .await
            .unwrap()
            .expect("parent run leased");
        execute_tool(
            &pool,
            &parent.run_id,
            ToolInput {
                runner_id: TEST_RUNNER.into(),
                tool_call_id: "call_spawn".into(),
                arguments: json!({
                    "action": "spawn", "taskName": "child_task", "message": "Do the part."
                }),
            },
        )
        .await
        .unwrap_or_else(|_| panic!("spawn from {expected} parent"));
        let (child,): (String,) =
            query_as("SELECT run_id FROM cloud_agent_fallback_runs WHERE parent_run_id = $1")
                .bind(&parent.run_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            audience_of(&pool, &child).await,
            expected,
            "child of {expected}"
        );
    }
}

#[tokio::test]
async fn digest_refresh_creates_an_owner_private_background_run() {
    let Some(pool) = pool().await else { return };
    let (owner, _) = signed_in_account(&pool, "digest_owner").await;
    let (author, _) = signed_in_account(&pool, "digest_author").await;
    crate::digest::store::initialize_preferences(&pool, &owner, "en-US", "UTC")
        .await
        .unwrap();
    let group = conversation(&pool, "group", &author, &[&owner]).await;
    query(
        "INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,\
         sender_account_id,client_message_id,request_fingerprint,content) \
         SELECT $1, conversation_id, 1, $2, $3, 'test', $4 FROM cloud_chat_conversations \
         WHERE legacy_session_id = $5",
    )
    .bind(Uuid::new_v4())
    .bind(&author)
    .bind(Uuid::new_v4())
    .bind(json!({"blocks":[{"type":"text","text":"Please review the draft by Friday."}]}))
    .bind(&group)
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_agent_provider_auth_snapshots(snapshot_id,account_id,device_id,\
         provider,auth_choice,encrypted_payload,encryption_key_id,created_at) \
         SELECT $1, $2, device_id, 'openai', 'api-key', '\\x00', 'test', $3 \
         FROM cloud_devices WHERE account_id = $2 LIMIT 1",
    )
    .bind(format!("snap_{}", Uuid::new_v4().simple()))
    .bind(&owner)
    .bind(Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();

    crate::digest::store::refresh(&pool, &owner).await.unwrap();
    let runs: Vec<(String, String, String)> = query_as(
        "SELECT run_id, run_trigger, connector_audience FROM cloud_agent_fallback_runs \
         WHERE owner_account_id = $1",
    )
    .bind(&owner)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert!(runs[0].0.starts_with(crate::digest::RUN_PREFIX));
    assert_eq!(
        (runs[0].1.as_str(), runs[0].2.as_str()),
        ("background", "owner_private")
    );
}

#[tokio::test]
async fn pip_sweep_creates_a_shared_run() {
    let Some(pool) = pool().await else { return };
    let (pip, _) = signed_in_account(&pool, "pip_service").await;
    let (jordan, _) = signed_in_account(&pool, "pip_member").await;
    let group = conversation(&pool, "group", &jordan, &[&pip]).await;
    let (conversation_id,): (Uuid,) = query_as(
        "SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id = $1",
    )
    .bind(&group)
    .fetch_one(&pool)
    .await
    .unwrap();
    query("INSERT INTO cloud_pip_conversation_state (conversation_id) VALUES ($1)")
        .bind(conversation_id)
        .execute(&pool)
        .await
        .unwrap();
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v4(),
        kind: "text".to_string(),
        content: json!({"schema": 1, "blocks": [{"type": "text", "text": "Dinner Friday at 7?"}],
                        "legacy_attachments": []}),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    crate::chat_sync::store::send_message(&pool, &jordan, conversation_id, request)
        .await
        .expect("send message");
    query(
        "UPDATE cloud_chat_messages SET created_at = now() - interval '5 minutes' \
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .execute(&pool)
    .await
    .unwrap();

    let queued = crate::pip::store::sweep(&pool, &crate::pip::test_config(&pip))
        .await
        .unwrap();
    assert_eq!(queued, 1);
    let runs: Vec<(String, String, String)> = query_as(
        "SELECT run_id, run_trigger, connector_audience FROM cloud_agent_fallback_runs \
         WHERE owner_account_id = $1",
    )
    .bind(&pip)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert!(runs[0].0.starts_with(crate::pip::RUN_PREFIX));
    assert_eq!(
        (runs[0].1.as_str(), runs[0].2.as_str()),
        ("background", "shared")
    );
}
