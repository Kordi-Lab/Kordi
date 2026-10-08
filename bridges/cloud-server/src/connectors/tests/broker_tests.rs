//! Broker grant, trigger, and ownership checks.

use super::*;

#[tokio::test]
async fn broker_enforces_grants_triggers_and_ownership() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "broker_owner").await;
    let (stranger, _) = signed_in_account(&pool, "broker_stranger").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;

    // Agent without a grant: denied and audited.
    let denied = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(
            &owner,
            &connector_id,
            RunTrigger::PersonStarted,
            STUB_READ_TOOL,
        ),
    )
    .await;
    assert_eq!(denied.error_code(), Some(codes::AGENT_NOT_GRANTED));

    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();

    // Act tool while act is off: denied even for a person-started run.
    let act_off = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(
            &owner,
            &connector_id,
            RunTrigger::PersonStarted,
            STUB_ACT_TOOL,
        ),
    )
    .await;
    assert_eq!(act_off.error_code(), Some(codes::ACT_DISABLED));

    // Second OAuth grant for act turns act on and extends scopes.
    assert_eq!(
        connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await,
        connector_id
    );
    let upgraded = store::load_account_connector(&pool, &owner, &connector_id)
        .await
        .unwrap()
        .unwrap();
    assert!(upgraded.act_enabled);
    assert_eq!(upgraded.act_scopes, ["stub.act"]);

    // Background run asking for an act tool: blocked and audited.
    let blocked = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(&owner, &connector_id, RunTrigger::Background, STUB_ACT_TOOL),
    )
    .await;
    assert!(!blocked.ok);
    assert_eq!(blocked.error_code(), Some(codes::BLOCKED_BACKGROUND));
    assert!(!stub.calls().iter().any(|call| call.starts_with("execute:")));

    // Background read is fine.
    let read = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(
            &owner,
            &connector_id,
            RunTrigger::Background,
            STUB_READ_TOOL,
        ),
    )
    .await;
    assert!(read.ok, "{read:?}");

    // Person-started act with act on: executes through the stub.
    let acted = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(
            &owner,
            &connector_id,
            RunTrigger::PersonStarted,
            STUB_ACT_TOOL,
        ),
    )
    .await;
    assert!(acted.ok, "{acted:?}");
    assert_eq!(acted.result.as_ref().unwrap()["tool"], STUB_ACT_TOOL);
    assert!(stub
        .calls()
        .contains(&format!("execute:{STUB_ACT_TOOL}:stub-access-code-1")));
    let serialized = serde_json::to_string(&acted).unwrap();
    assert!(!serialized.contains("stub-access") && !serialized.contains("stub-refresh"));

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
    let refreshed = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(
            &owner,
            &connector_id,
            RunTrigger::Background,
            STUB_READ_TOOL,
        ),
    )
    .await;
    assert!(refreshed.ok, "{refreshed:?}");
    assert!(stub.calls().contains(&format!(
        "execute:{STUB_READ_TOOL}:expired-access-refreshed"
    )));

    // Another account naming this connector: not found, no audit row.
    let before = audit_outcomes(&pool, &connector_id).await.len();
    let mut foreign = call(
        &stranger,
        &connector_id,
        RunTrigger::PersonStarted,
        STUB_READ_TOOL,
    );
    foreign.agent_id = store::default_agent_id(&stranger);
    let foreign = broker::call_connector_tool(&pool, &runtime, &foreign).await;
    assert_eq!(foreign.error_code(), Some(codes::NOT_FOUND));
    // The owner's agent id under the wrong account is not found either.
    let mut mixed = call(
        &owner,
        &connector_id,
        RunTrigger::PersonStarted,
        STUB_READ_TOOL,
    );
    mixed.agent_id = store::default_agent_id(&stranger);
    assert_eq!(
        broker::call_connector_tool(&pool, &runtime, &mixed)
            .await
            .error_code(),
        Some(codes::NOT_FOUND)
    );
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
            "completed",          // read after refresh
        ]
    );
    assert_eq!(outcomes[4].0, STUB_ACT_TOOL);
}
