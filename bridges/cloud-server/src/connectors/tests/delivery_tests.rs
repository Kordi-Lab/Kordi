//! Connector tool delivery on leases (issue 1712, PR 2): lease shape, run
//! triggers, and the read-only rule for background runs.

use super::*;
use crate::cloud_agent_runtime::runs::{RunnerLeaseResponse, RunnerRunResponse};
use crate::connectors::delivery::LeaseConnectorTool;

#[test]
fn lease_types_have_no_secret_shaped_key() {
    assert_no_secret_keys(
        "LeaseConnectorTool",
        serde_json::to_value(sample_lease_tools()).unwrap(),
    );
    assert_no_secret_keys(
        "RunnerLeaseResponse",
        serde_json::to_value(RunnerLeaseResponse {
            run: Some(sample_runner_run(sample_lease_tools())),
        })
        .unwrap(),
    );
}

fn sample_lease_tools() -> Vec<LeaseConnectorTool> {
    let stub = StubConnectorProvider::default();
    let connector = record(ConnectorStatus::Connected, true);
    broker::tools_for_trigger(&connector, &stub, RunTrigger::PersonStarted)
        .into_iter()
        .map(|descriptor| LeaseConnectorTool {
            connector_id: connector.connector_id.clone(),
            provider: STUB.id.to_string(),
            name: descriptor.name.to_string(),
            group: descriptor.group,
            description: descriptor.description.to_string(),
            input_schema: crate::connectors::tool_schemas::input_schema(descriptor.name),
        })
        .collect()
}

fn sample_runner_run(connector_tools: Vec<LeaseConnectorTool>) -> RunnerRunResponse {
    RunnerRunResponse {
        turn_identity: json!({ "ownerAccountId": "acct_sample" }),
        history_messages: Vec::new(),
        subsession_id: None,
        subsession_write_scope: Vec::new(),
        run_id: "car_sample".into(),
        status: "leased".into(),
        prompt: "Prompt".into(),
        system_prompt: "System".into(),
        owner_account_id: "acct_sample".into(),
        requester_account_id: "acct_sample".into(),
        session_id: "session:sample".into(),
        sandbox_id: None,
        runtime_route: Default::default(),
        provider_auth_available: false,
        response_message_id: None,
        error_code: None,
        error_message: None,
        trigger: RunTrigger::PersonStarted,
        connector_audience: ConnectorAudience::OwnerPrivate,
        connector_tools,
    }
}

#[test]
fn lease_carries_trigger_and_connector_descriptors_in_camel_case() {
    let value = serde_json::to_value(sample_runner_run(sample_lease_tools())).unwrap();
    assert_eq!(value["trigger"], "person_started");
    assert_eq!(value["connectorAudience"], "owner_private");
    let tools = value["connectorTools"].as_array().unwrap();
    assert_eq!(tools.len(), 2);
    let mut keys = tools[0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        [
            "connectorId",
            "description",
            "group",
            "inputSchema",
            "name",
            "provider"
        ]
    );
    assert_eq!(tools[0]["group"], "read");
    assert_eq!(tools[1]["group"], "act");
    assert_eq!(tools[0]["inputSchema"]["type"], "object");
}

#[test]
fn run_triggers_fail_closed() {
    assert_eq!(RunTrigger::default(), RunTrigger::Background);
    assert_eq!(
        RunTrigger::parse("person_started"),
        RunTrigger::PersonStarted
    );
    assert_eq!(RunTrigger::parse("scheduled"), RunTrigger::Background);
    assert_eq!(RunTrigger::parse(""), RunTrigger::Background);
    assert_eq!(
        RunTrigger::for_person_message("acct_a", "acct_a"),
        RunTrigger::PersonStarted
    );
    assert_eq!(
        RunTrigger::for_person_message("acct_a", "acct_contact"),
        RunTrigger::Background,
        "a contact's message never unlocks the owner's act tools"
    );
    assert_eq!(
        RunTrigger::for_person_message("", ""),
        RunTrigger::Background
    );
}

/// Every place that creates a run names its trigger and its connector
/// audience explicitly. The column defaults fail closed, but a new insert
/// must decide on purpose.
#[test]
fn every_run_insert_sets_its_trigger_and_audience() {
    let sources = [
        (
            "runs/claims.rs",
            include_str!("../../cloud_agent_runtime/runs/claims.rs"),
        ),
        (
            "runs/subsessions.rs",
            include_str!("../../cloud_agent_runtime/runs/subsessions.rs"),
        ),
        (
            "auth/subsessions/conversation.rs",
            include_str!("../../auth/subsessions/conversation.rs"),
        ),
        ("digest/store.rs", include_str!("../../digest/store.rs")),
        ("pip/store.rs", include_str!("../../pip/store.rs")),
    ];
    for (label, source) in sources {
        let inserts = source
            .matches("INSERT INTO cloud_agent_fallback_runs")
            .count();
        assert!(
            inserts > 0,
            "{label} no longer creates runs; update this test"
        );
        for (index, _) in source.match_indices("INSERT INTO cloud_agent_fallback_runs") {
            let statement = &source[index..(index + 800).min(source.len())];
            let end = statement.find("VALUES").unwrap_or(statement.len());
            for column in ["run_trigger", "connector_audience"] {
                assert!(
                    statement[..end].contains(column),
                    "{label} creates a run without naming {column}"
                );
            }
        }
    }
    let pip = include_str!("../../pip/store.rs");
    let digest = include_str!("../../digest/store.rs");
    let spawned = include_str!("../../cloud_agent_runtime/runs/subsessions.rs");
    assert!(pip.contains("$7, $7, 'background', 'shared')"));
    assert!(digest.contains("$6,$6,'background','owner_private')"));
    assert!(spawned.contains("'background',COALESCE((SELECT parent.connector_audience"));
}

#[test]
fn connector_audiences_fail_closed() {
    assert_eq!(ConnectorAudience::default(), ConnectorAudience::Shared);
    assert_eq!(
        ConnectorAudience::parse("owner_private"),
        ConnectorAudience::OwnerPrivate
    );
    assert_eq!(ConnectorAudience::parse("group"), ConnectorAudience::Shared);
    assert_eq!(ConnectorAudience::parse(""), ConnectorAudience::Shared);
    assert_eq!(
        serde_json::to_value(ConnectorAudience::OwnerPrivate).unwrap(),
        "owner_private"
    );
}
