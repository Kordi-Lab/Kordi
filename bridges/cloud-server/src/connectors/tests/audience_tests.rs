//! Consent boundary on connector delivery (issue 1712, PR 5), against
//! `$DATABASE_URL`: only runs whose output the owner alone can read receive
//! connector tools, and the trigger still limits them to `read` when nobody
//! started the run.

use super::broker_tests::{runner, TEST_RUNNER};
use super::*;
use crate::cloud_agent_runtime::runs::{
    claim_run, claim_run_for_person_message, lease_canary_run, ClaimRunRequest, RunnerLeaseResponse,
};
use crate::connectors::audience::audience_for_message;
use crate::connectors::delivery;

/// Creates a conversation and returns its session id.
async fn conversation(pool: &PgPool, kind: &str, creator: &str, others: &[&str]) -> String {
    let conversation_id = Uuid::new_v4();
    let session_id = format!("session:connectors-{kind}:{}", conversation_id.simple());
    query(
        "INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,\
         client_operation_id,creation_fingerprint,legacy_session_id) \
         VALUES($1,$2,$3,$4,'connectors-audience',$5)",
    )
    .bind(conversation_id)
    .bind(kind)
    .bind(creator)
    .bind(Uuid::new_v4())
    .bind(&session_id)
    .execute(pool)
    .await
    .unwrap();
    for member in std::iter::once(&creator).chain(others) {
        query(
            "INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,$2)",
        )
        .bind(conversation_id)
        .bind(*member)
        .execute(pool)
        .await
        .unwrap();
    }
    session_id
}

/// Inserts a queued background run with the column list `digest::store` or
/// `pip::store` uses.
async fn background_run(
    pool: &PgPool,
    prefix: &str,
    session: &str,
    owner: &str,
    audience: &str,
) -> String {
    let run_id = format!("{prefix}{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id,idempotency_key,request_message_id,\
         session_id,owner_account_id,requester_account_id,status,prompt,system_prompt,\
         runtime_route_json,created_at,updated_at,run_trigger,connector_audience) \
         VALUES($1,$1,$1,$2,$3,$3,'queued','{}','System','{}',$4,$4,'background',$5)",
    )
    .bind(&run_id)
    .bind(session)
    .bind(owner)
    .bind(Utc::now().to_rfc3339())
    .bind(audience)
    .execute(pool)
    .await
    .unwrap();
    run_id
}

#[tokio::test]
async fn connector_tools_reach_only_runs_the_owner_alone_can_read() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "audience_owner").await;
    let (contact, _) = signed_in_account(&pool, "audience_contact").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await;
    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();

    // Agent conversations run one request at a time, so each run below gets
    // its own conversation.
    let private = conversation(&pool, "ai", &owner, &[]).await;
    let private_scheduled = conversation(&pool, "ai", &owner, &[]).await;
    let private_contact = conversation(&pool, "ai", &owner, &[]).await;
    let group = conversation(&pool, "group", &owner, &[&contact]).await;
    // An agent conversation another account ever joined is not private.
    let joined = conversation(&pool, "ai", &owner, &[&contact]).await;
    for (session, requester, expected) in [
        (&private, &owner, ConnectorAudience::OwnerPrivate),
        (&private, &contact, ConnectorAudience::Shared),
        (&group, &owner, ConnectorAudience::Shared),
        (&joined, &owner, ConnectorAudience::Shared),
        (
            &"session:connectors:no-conversation".to_string(),
            &owner,
            ConnectorAudience::Shared,
        ),
    ] {
        let audience = audience_for_message(&pool, session, &owner, requester)
            .await
            .unwrap();
        assert_eq!(audience, expected, "{session} from {requester}");
    }

    let claim = |session: &str, requester: &str, label: &str| ClaimRunRequest {
        request_message_id: format!("{label}_{}", Uuid::new_v4().simple()),
        session_id: session.to_string(),
        owner_account_id: owner.clone(),
        requester_account_id: requester.to_string(),
        prompt: "Check my items".into(),
        runtime_route: None,
        idempotency_key: format!("{label}:{}", Uuid::new_v4().simple()),
    };
    let person = claim_run_for_person_message(&pool, &claim(&private, &owner, "person"))
        .await
        .unwrap();
    let in_group = claim_run_for_person_message(&pool, &claim(&group, &owner, "group"))
        .await
        .unwrap();
    let from_contact =
        claim_run_for_person_message(&pool, &claim(&private_contact, &contact, "contact"))
            .await
            .unwrap();
    // Scheduled occurrences are admitted through `claim_run`, exactly as
    // `scheduled_tasks::store` does; this one was created in the owner's
    // private conversation.
    let scheduled = claim_run(&pool, &claim(&private_scheduled, &owner, "scheduled"))
        .await
        .unwrap();
    let digest = background_run(
        &pool,
        crate::digest::RUN_PREFIX,
        &format!("digest:{owner}"),
        &owner,
        "owner_private",
    )
    .await;
    let pip = background_run(
        &pool,
        crate::pip::store::RUN_PREFIX,
        &group,
        &owner,
        "shared",
    )
    .await;

    let mut groups_by_label = Vec::new();
    for (label, run_id) in [
        ("person", person.run_id.as_str()),
        ("group", in_group.run_id.as_str()),
        ("contact", from_contact.run_id.as_str()),
        ("scheduled", scheduled.run_id.as_str()),
        ("digest", digest.as_str()),
        ("pip", pip.as_str()),
    ] {
        let mut run = lease_canary_run(&pool, TEST_RUNNER, run_id)
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("{label} run was not leased"));
        // What the lease route does after leasing.
        run.connector_tools =
            delivery::deliver_to_run(&pool, &runtime.providers, &run.run_id).await;
        let lease = serde_json::to_value(RunnerLeaseResponse { run: Some(run) }).unwrap();
        assert_no_secret_keys(label, lease.clone());
        let groups = lease["run"]["connectorTools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["group"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        groups_by_label.push((label, lease["run"]["connectorAudience"].clone(), groups));
    }
    // A cloud lease never carries `act`: only a desktop claim does.
    let read = vec!["read".to_string()];
    assert_eq!(
        groups_by_label,
        [
            ("person", json!("owner_private"), read.clone()),
            ("group", json!("shared"), Vec::new()),
            ("contact", json!("shared"), Vec::new()),
            ("scheduled", json!("owner_private"), read.clone()),
            ("digest", json!("owner_private"), read),
            ("pip", json!("shared"), Vec::new()),
        ]
    );

    // The broker reads the same stored set back: a shared lease holds no
    // tool, so a call is refused before any provider is reached.
    let stored = delivery::load_active_lease(&pool, &in_group.run_id, &runner())
        .await
        .unwrap()
        .unwrap();
    assert!(!stored.has_tool(&connector_id, STUB_READ_TOOL));
    let stored = delivery::load_active_lease(&pool, &scheduled.run_id, &runner())
        .await
        .unwrap()
        .unwrap();
    assert!(stored.has_tool(&connector_id, STUB_READ_TOOL));
    assert!(!stored.has_tool(&connector_id, STUB_ACT_TOOL));

    // The broker refuses a contact's lease outright.
    let refused = crate::connectors::broker::call_connector_tool(
        &pool,
        &runtime,
        &runner(),
        &super::broker_tests::call(&from_contact.run_id, &connector_id, STUB_READ_TOOL),
    )
    .await;
    assert_eq!(
        refused.error_code(),
        Some(crate::connectors::broker::codes::REQUESTER_NOT_OWNER)
    );
}
