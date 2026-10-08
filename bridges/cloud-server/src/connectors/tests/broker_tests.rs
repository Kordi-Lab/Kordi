//! Broker lease checks (issue 1712, PR 2), against `$DATABASE_URL` like the
//! other connector database tests: a call must name an active lease held by
//! the caller, account, agent, and trigger come from the lease, and only
//! tools delivered on the lease may run.

use super::*;
use crate::connectors::delivery::{self, LeaseConnectorTool, LeaseHolder};

pub(super) const TEST_RUNNER: &str = "runner-connectors-test";

pub(super) fn runner() -> LeaseHolder {
    LeaseHolder::Runner {
        runner_id: TEST_RUNNER.to_string(),
    }
}

/// Inserts a cloud run leased by [`TEST_RUNNER`] for the account's built-in
/// agent and delivers its connector tools, as the lease route does.
pub(super) async fn leased_run(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    account_id: &str,
    trigger: RunTrigger,
) -> (String, Vec<LeaseConnectorTool>) {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = Utc::now();
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
         updated_at, execution_backend, claimed_by, lease_expires_at, run_trigger) \
         VALUES ($1, $1, $1, $2, $3, $3, 'leased', 'Prompt', $4, $4, 'cloud', $5, $6, $7)",
    )
    .bind(&run_id)
    .bind(format!("session:connectors:{run_id}"))
    .bind(account_id)
    .bind(now.to_rfc3339())
    .bind(TEST_RUNNER)
    .bind((now + ChronoDuration::minutes(2)).to_rfc3339())
    .bind(trigger.as_str())
    .execute(pool)
    .await
    .unwrap();
    let tools = delivery::deliver_to_run(pool, &runtime.providers, &run_id).await;
    (run_id, tools)
}

fn tool_names(tools: &[LeaseConnectorTool]) -> Vec<&str> {
    tools.iter().map(|tool| tool.name.as_str()).collect()
}

pub(super) fn call(lease_id: &str, connector_id: &str, tool: &str) -> BrokerCallRequest {
    BrokerCallRequest {
        lease_id: lease_id.to_string(),
        runner_id: Some(TEST_RUNNER.to_string()),
        claim_id: None,
        account_id: None,
        agent_id: None,
        trigger: None,
        connector_id: connector_id.to_string(),
        tool: tool.to_string(),
        args: json!({ "q": "today" }),
    }
}

#[tokio::test]
async fn broker_enforces_leases_grants_triggers_and_ownership() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "broker_owner").await;
    let (stranger, _) = signed_in_account(&pool, "broker_stranger").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    let broker_call = |request: BrokerCallRequest| {
        let (pool, runtime) = (pool.clone(), runtime.clone());
        async move { broker::call_connector_tool(&pool, &runtime, &runner(), &request).await }
    };

    // Agent without a grant: no descriptors on the lease, and denied.
    let (ungranted, tools) = leased_run(&pool, &runtime, &owner, RunTrigger::PersonStarted).await;
    assert!(tools.is_empty(), "an agent without a grant sees no tools");
    let denied = broker_call(call(&ungranted, &connector_id, STUB_READ_TOOL)).await;
    assert_eq!(denied.error_code(), Some(codes::AGENT_NOT_GRANTED));

    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();

    // Act tool while act is off: not delivered and denied.
    let (act_off_lease, tools) =
        leased_run(&pool, &runtime, &owner, RunTrigger::PersonStarted).await;
    assert_eq!(tool_names(&tools), [STUB_READ_TOOL]);
    let act_off = broker_call(call(&act_off_lease, &connector_id, STUB_ACT_TOOL)).await;
    assert_eq!(act_off.error_code(), Some(codes::ACT_DISABLED));

    // Second OAuth grant for act turns act on and extends scopes.
    assert_eq!(
        connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await,
        connector_id
    );

    // Background lease: read only, and an act call is blocked and audited.
    let (background, tools) = leased_run(&pool, &runtime, &owner, RunTrigger::Background).await;
    assert_eq!(tool_names(&tools), [STUB_READ_TOOL]);
    let blocked = broker_call(call(&background, &connector_id, STUB_ACT_TOOL)).await;
    assert_eq!(blocked.error_code(), Some(codes::BLOCKED_BACKGROUND));
    assert!(!stub.calls().iter().any(|call| call.starts_with("execute:")));
    let read = broker_call(call(&background, &connector_id, STUB_READ_TOOL)).await;
    assert!(read.ok, "{read:?}");

    // Person-started lease with act on: both tools, and act executes.
    let (person, tools) = leased_run(&pool, &runtime, &owner, RunTrigger::PersonStarted).await;
    assert_eq!(tool_names(&tools), [STUB_READ_TOOL, STUB_ACT_TOOL]);
    let acted = broker_call(call(&person, &connector_id, STUB_ACT_TOOL)).await;
    assert!(acted.ok, "{acted:?}");
    assert_eq!(acted.result.as_ref().unwrap()["tool"], STUB_ACT_TOOL);
    let serialized = serde_json::to_string(&acted).unwrap();
    assert!(!serialized.contains("stub-access") && !serialized.contains("stub-refresh"));

    // The lease issued while act was off never gains the act tool.
    let not_on_lease = broker_call(call(&act_off_lease, &connector_id, STUB_ACT_TOOL)).await;
    assert_eq!(not_on_lease.error_code(), Some(codes::NOT_ON_LEASE));

    // Expired credential: refreshed through the provider before executing.
    let sealed = broker::seal_secret(
        &TestCipher,
        &ConnectorSecret {
            access_token: "expired-access".into(),
            refresh_token: Some("stub-refresh".into()),
            expires_at: Some(Utc::now() - ChronoDuration::minutes(5)),
        },
    )
    .unwrap();
    store::write_secret(&pool, &connector_id, &sealed)
        .await
        .unwrap();
    let refreshed = broker_call(call(&background, &connector_id, STUB_READ_TOOL)).await;
    assert!(refreshed.ok, "{refreshed:?}");
    assert!(stub.calls().contains(&format!(
        "execute:{STUB_READ_TOOL}:expired-access-refreshed"
    )));

    // Body fields never override the lease: a background lease claiming to be
    // person-started for another agent still runs as the lease says.
    let mut spoofed = call(&background, &connector_id, STUB_ACT_TOOL);
    spoofed.trigger = Some(RunTrigger::PersonStarted);
    spoofed.account_id = Some(stranger.clone());
    spoofed.agent_id = Some(store::default_agent_id(&stranger));
    assert_eq!(
        broker_call(spoofed).await.error_code(),
        Some(codes::BLOCKED_BACKGROUND)
    );

    // Leases that do not exist, are held by another runner, or expired.
    let before = audit_outcomes(&pool, &connector_id).await.len();
    let missing = broker_call(call("car_missing", &connector_id, STUB_READ_TOOL)).await;
    assert_eq!(missing.error_code(), Some(codes::LEASE_INVALID));
    let other_runner = broker::call_connector_tool(
        &pool,
        &runtime,
        &LeaseHolder::Runner {
            runner_id: "another-runner".into(),
        },
        &call(&person, &connector_id, STUB_READ_TOOL),
    )
    .await;
    assert_eq!(other_runner.error_code(), Some(codes::LEASE_INVALID));
    let desktop = broker::call_connector_tool(
        &pool,
        &runtime,
        &LeaseHolder::Desktop {
            account_id: owner.clone(),
            executor: TEST_RUNNER.into(),
        },
        &call(&person, &connector_id, STUB_READ_TOOL),
    )
    .await;
    assert_eq!(
        desktop.error_code(),
        Some(codes::LEASE_INVALID),
        "a cloud lease is not a desktop lease"
    );
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at = $2 WHERE run_id = $1")
        .bind(&person)
        .bind((Utc::now() - ChronoDuration::seconds(1)).to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();
    let expired = broker_call(call(&person, &connector_id, STUB_READ_TOOL)).await;
    assert_eq!(expired.error_code(), Some(codes::LEASE_INVALID));

    // Another account's lease naming this connector: not found.
    let (foreign, _) = leased_run(&pool, &runtime, &stranger, RunTrigger::PersonStarted).await;
    let foreign = broker_call(call(&foreign, &connector_id, STUB_READ_TOOL)).await;
    assert_eq!(foreign.error_code(), Some(codes::NOT_FOUND));
    assert_eq!(audit_outcomes(&pool, &connector_id).await.len(), before);

    let outcomes = audit_outcomes(&pool, &connector_id).await;
    let outcome_names = outcomes
        .iter()
        .map(|(_, outcome)| outcome.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        outcome_names,
        [
            "completed",          // oauth.grant read
            "denied",             // no agent grant
            "denied",             // act off
            "completed",          // oauth.grant act
            "blocked_background", // act from background
            "completed",          // background read
            "completed",          // person-started act
            "denied",             // act not on the earlier lease
            "completed",          // read after refresh
            "blocked_background", // spoofed body fields
        ]
    );
    assert_eq!(outcomes[4].0, STUB_ACT_TOOL);
    let runs: Vec<(Option<String>, Option<String>)> = query_as(
        "SELECT run_id, agent_id FROM cloud_connector_audit WHERE connector_id = $1 \
         AND outcome = 'blocked_background' ORDER BY created_at, audit_id",
    )
    .bind(&connector_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    for (run_id, agent_id) in runs {
        assert_eq!(run_id.as_deref(), Some(background.as_str()));
        assert_eq!(agent_id, Some(store::default_agent_id(&owner)));
    }
}
