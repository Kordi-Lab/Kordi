//! Connector tool delivery on leases (issue 1712, PR 2): lease shape, run
//! triggers, and the read-only rule for background runs.

use super::*;
use crate::cloud_agent_runtime::runs::{RunnerLeaseResponse, RunnerRunResponse};
use crate::connectors::delivery::{self, LeaseConnectorTool};

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
    delivery::tools_for_trigger(&connector, &stub, RunTrigger::PersonStarted)
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
        cancel_requested: false,
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

/// Non-test source files under `dir`, recursively, with paths relative to
/// `root`. Test code inserts historical rows on purpose and is skipped.
fn rust_sources(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy();
        if name == "tests" || name.ends_with("tests.rs") || name.ends_with("_tests") {
            continue;
        }
        if path.is_dir() {
            rust_sources(root, &path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let label = path.strip_prefix(root).unwrap().display().to_string();
            out.push((label, std::fs::read_to_string(&path).unwrap()));
        }
    }
}

/// Every place that creates a run names its trigger and its connector
/// audience explicitly. The column defaults fail closed, but a new insert
/// must decide on purpose. Walks the whole crate so a new insert site cannot
/// be missed.
#[test]
fn every_run_insert_sets_its_trigger_and_audience() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources = Vec::new();
    rust_sources(&root, &root, &mut sources);
    let marker = "INSERT INTO cloud_agent_fallback_runs";
    let mut sites = Vec::new();
    for (label, source) in &sources {
        for (index, _) in source.match_indices(marker) {
            let statement = &source[index..(index + 800).min(source.len())];
            let end = statement.find("VALUES").unwrap_or(statement.len());
            for column in ["run_trigger", "connector_audience"] {
                assert!(
                    statement[..end].contains(column),
                    "{label} creates a run without naming {column}"
                );
            }
            sites.push(label.as_str());
        }
    }
    for expected in [
        "cloud_agent_runtime/runs/claims.rs",
        "cloud_agent_runtime/runs/subsessions.rs",
        "auth/subsessions/conversation.rs",
        "pip/store.rs",
        "digest/store.rs",
    ] {
        assert!(
            sites.contains(&expected),
            "{expected} no longer creates runs; update this test"
        );
    }
    let read = |name: &str| std::fs::read_to_string(root.join(name)).unwrap();
    assert!(read("pip/store.rs").contains("$7, $7, 'background', 'shared')"));
    assert!(read("digest/store.rs").contains("$6,$6,'background','owner_private')"));
    assert!(read("cloud_agent_runtime/runs/subsessions.rs")
        .contains("'background',COALESCE((SELECT parent.connector_audience"));
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

#[tokio::test]
async fn delivered_tools_are_fixed_at_first_lease() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "fixed_set").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();
    let mac = super::broker_tests::desktop(&owner);
    let (run_id, first) = super::broker_tests::lease_run_for(
        &pool,
        &runtime,
        &owner,
        &owner,
        RunTrigger::PersonStarted,
        &mac,
    )
    .await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].group, ConnectorToolGroup::Read);

    connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await;
    let again = delivery::deliver_to_run(&pool, &runtime.providers, &run_id).await;
    assert_eq!(again, first, "re-lease reuses the first delivered set");
    let lease = delivery::load_active_lease(&pool, &run_id, &mac)
        .await
        .unwrap()
        .unwrap();
    assert!(!lease.has_tool(&connector_id, STUB_ACT_TOOL));
    let (delivered,): (bool,) = query_as(
        "SELECT connector_tools_delivered_at IS NOT NULL FROM cloud_agent_fallback_runs \
         WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(delivered);
}
