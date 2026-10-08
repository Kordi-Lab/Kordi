//! Connector tool delivery on leases (issue 1712, PR 2): lease shape, run
//! triggers, and the read-only rule for background runs.

use super::broker_tests::{runner, TEST_RUNNER};
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
        trigger: RunTrigger::PersonStarted,
        connector_tools,
    }
}

#[test]
fn lease_carries_trigger_and_connector_descriptors_in_camel_case() {
    let value = serde_json::to_value(sample_runner_run(sample_lease_tools())).unwrap();
    assert_eq!(value["trigger"], "person_started");
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

/// Every place that creates a run names its trigger explicitly. The column
/// default is background, but a new insert must decide on purpose. Walks the
/// whole crate so a new insert site cannot be missed.
#[test]
fn every_run_insert_sets_its_trigger() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources = Vec::new();
    rust_sources(&root, &root, &mut sources);
    let marker = "INSERT INTO cloud_agent_fallback_runs";
    let mut sites = Vec::new();
    for (label, source) in &sources {
        for (index, _) in source.match_indices(marker) {
            let statement = &source[index..(index + 700).min(source.len())];
            let end = statement.find("VALUES").unwrap_or(statement.len());
            assert!(
                statement[..end].contains("run_trigger"),
                "{label} creates a run without naming run_trigger"
            );
            sites.push(label.as_str());
        }
    }
    for expected in [
        "cloud_agent_runtime/runs/claims.rs",
        "pip/store.rs",
        "digest/store.rs",
    ] {
        assert!(
            sites.contains(&expected),
            "{expected} no longer creates runs; update this test"
        );
    }
    let read = |name: &str| std::fs::read_to_string(root.join(name)).unwrap();
    assert!(read("pip/store.rs").contains("$7, $7, 'background')"));
    assert!(read("digest/store.rs").contains("$6,$6,'background')"));
}

/// Leases of scheduled-task occurrences and PiP runs carry no `act` tool even
/// with `act` turned on; the owner's own message does.
#[tokio::test]
async fn lease_connector_tools_follow_the_run_trigger() {
    use crate::cloud_agent_runtime::runs::{
        claim_run, claim_run_for_person_message, lease_canary_run, ClaimRunRequest,
    };
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "lease_owner").await;
    let (contact, _) = signed_in_account(&pool, "lease_contact").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await;
    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();

    let claim = |requester: &str, label: &str| ClaimRunRequest {
        request_message_id: format!("{label}_{}", Uuid::new_v4().simple()),
        session_id: format!("session:connectors-lease:{}", Uuid::new_v4().simple()),
        owner_account_id: owner.clone(),
        requester_account_id: requester.to_string(),
        prompt: "Check my items".into(),
        runtime_route: None,
        idempotency_key: format!("{label}:{}", Uuid::new_v4().simple()),
    };
    // Scheduled occurrences are admitted through `claim_run`, exactly as
    // `scheduled_tasks::store` does.
    let scheduled = claim_run(&pool, &claim(&owner, "scheduled")).await.unwrap();
    let person = claim_run_for_person_message(&pool, &claim(&owner, "person"))
        .await
        .unwrap();
    let from_contact = claim_run_for_person_message(&pool, &claim(&contact, "contact"))
        .await
        .unwrap();
    // A PiP run, inserted with the column list `pip::store` uses.
    let pip_run = format!(
        "{}{}",
        crate::pip::store::RUN_PREFIX,
        Uuid::new_v4().simple()
    );
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs (
             run_id, idempotency_key, request_message_id, session_id, owner_account_id,
             requester_account_id, status, prompt, system_prompt, runtime_route_json,
             created_at, updated_at, run_trigger
         ) VALUES ($1, $1, $1, $2, $3, $3, 'queued', $4, $5, $6, $7, $7, 'background')",
    )
    .bind(&pip_run)
    .bind(format!("session:connectors-pip:{pip_run}"))
    .bind(&owner)
    .bind("{}")
    .bind("PiP")
    .bind(json!({}))
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();

    let mut leases = Vec::new();
    for (label, run_id) in [
        ("scheduled", scheduled.run_id.as_str()),
        ("pip", pip_run.as_str()),
        ("contact", from_contact.run_id.as_str()),
        ("person", person.run_id.as_str()),
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
        leases.push((label, lease));
    }
    for (label, lease) in &leases {
        let groups = lease["run"]["connectorTools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["group"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        if *label == "person" {
            assert_eq!(lease["run"]["trigger"], "person_started");
            assert_eq!(groups, ["read"], "cloud leases wait for an approval flow");
        } else if *label == "contact" {
            assert!(groups.is_empty(), "a contact's run gets no connector tools");
        } else {
            assert_eq!(lease["run"]["trigger"], "background", "{label}");
            assert_eq!(groups, ["read"], "{label} must not receive act tools");
        }
    }

    // The broker reads the same stored set back from the lease.
    let stored = delivery::load_active_lease(&pool, &pip_run, &runner())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.trigger, RunTrigger::Background);
    assert!(stored.has_tool(&connector_id, STUB_READ_TOOL));
    assert!(!stored.has_tool(&connector_id, STUB_ACT_TOOL));

    // The broker refuses the contact's lease outright.
    let refused = broker::call_connector_tool(
        &pool,
        &runtime,
        &runner(),
        &super::broker_tests::call(&from_contact.run_id, &connector_id, STUB_READ_TOOL),
    )
    .await;
    assert_eq!(refused.error_code(), Some(codes::REQUESTER_NOT_OWNER));
}

/// The delivered set is fixed at the first lease: turning act on afterwards
/// does not add act tools when the same run is leased again.
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
