//! Connector tools on the cloud runner (issue 1712, PR 2): lease
//! descriptors become model tools, the policy admits only names on the lease,
//! and a call returns the broker's result to the model.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kordi_tools::connector_tools::{ConnectorToolDescriptor, ConnectorToolGroup};
use serde_json::{json, Value};

use crate::client::{
    ArtifactExportInput, ArtifactExportResponse, CloudAgentRun, CloudAgentRunClient,
    ProviderAuthMaterial, RunnerClientError,
};
use crate::connectors::{self, LeaseConnectors};
use crate::model_loop::{
    run_model_loop, CloudModelProvider, ModelLoopError, ModelProviderResponse, ModelToolCall,
    OpenAiProviderConfig,
};
use crate::tool_policy::{
    decide_runner_tool, RunnerToolBlockReason, RunnerToolDecision, RunnerToolRequest,
};

pub(super) struct FakeModelProvider {
    pub(super) response: ModelProviderResponse,
}

#[async_trait]
impl CloudModelProvider for FakeModelProvider {
    async fn next_response(
        &self,
        _auth: &OpenAiProviderConfig,
        _messages: &[Value],
        _tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        Ok(self.response.clone())
    }
}

fn descriptor(name: &str, group: ConnectorToolGroup) -> ConnectorToolDescriptor {
    ConnectorToolDescriptor {
        connector_id: "conn_1".into(),
        provider: "gmail".into(),
        name: name.into(),
        group,
        description: format!("{name} description"),
        input_schema: json!({"type":"object","properties":{"q":{"type":"string"}}}),
    }
}

fn run(trigger: &str, tools: Vec<ConnectorToolDescriptor>) -> CloudAgentRun {
    CloudAgentRun {
        turn_identity: None,
        history_messages: Vec::new(),
        subsession_id: None,
        subsession_write_scope: Vec::new(),
        run_id: "car_connectors".into(),
        status: "leased".into(),
        prompt: "Find my invoices".into(),
        system_prompt: String::new(),
        owner_account_id: "acct_owner".into(),
        requester_account_id: "acct_owner".into(),
        session_id: "session:connectors".into(),
        sandbox_id: Some("cas_test".into()),
        runtime_route: Default::default(),
        provider_auth_available: true,
        connectors: LeaseConnectors {
            trigger: Some(trigger.into()),
            tools,
            audience: Some("owner_private".into()),
        },
    }
}

#[derive(Default)]
struct BrokerClient {
    calls: Mutex<Vec<(String, String, Value)>>,
}

#[async_trait]
impl CloudAgentRunClient for BrokerClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        Ok(None)
    }
    async fn mark_running(&self, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn complete_run(&self, _: &str, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn fail_run(&self, _: &str, _: &str, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn fetch_provider_auth(
        &self,
        _: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        unreachable!()
    }
    async fn export_artifact(
        &self,
        _: &str,
        _: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        unreachable!()
    }
    async fn call_connector_tool(
        &self,
        run_id: &str,
        tool: &ConnectorToolDescriptor,
        args: Value,
    ) -> Result<Value, RunnerClientError> {
        self.calls
            .lock()
            .unwrap()
            .push((run_id.to_string(), tool.name.clone(), args));
        Ok(json!({"messages": [{"subject": "Invoice 42"}]}))
    }
}

/// Answers with one connector call, then with final text; records what the
/// model saw.
#[derive(Default)]
struct ScriptedProvider {
    seen_tools: Mutex<Vec<String>>,
    seen_messages: Mutex<Vec<Value>>,
}

#[async_trait]
impl CloudModelProvider for ScriptedProvider {
    async fn next_response(
        &self,
        _auth: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        *self.seen_tools.lock().unwrap() = tools
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_string))
            .collect();
        *self.seen_messages.lock().unwrap() = messages.to_vec();
        if messages.iter().any(|message| message["role"] == "tool") {
            return Ok(ModelProviderResponse::FinalText("Found Invoice 42.".into()));
        }
        Ok(ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_1".into(),
            name: "gmail_search".into(),
            arguments: json!({"q": "invoice"}),
        }]))
    }
}

fn request<'a>(name: &'a str, tools: &'a [ConnectorToolDescriptor]) -> RunnerToolRequest<'a> {
    RunnerToolRequest {
        tool_name: name,
        path_args: Vec::new(),
        url_args: Vec::new(),
        requester_account_id: "acct_owner",
        owner_account_id: "acct_owner",
        data_owner_account_id: None,
        connector_tools: tools,
    }
}

#[test]
fn policy_admits_only_connector_tools_on_the_lease() {
    let tools = [descriptor("gmail_search", ConnectorToolGroup::Read)];
    assert_eq!(
        decide_runner_tool(&request("gmail_search", &tools)),
        RunnerToolDecision::AllowConnector
    );
    for name in ["gmail_send", "slack_post", "github_comment"] {
        assert_eq!(
            decide_runner_tool(&request(name, &tools)),
            RunnerToolDecision::Block(RunnerToolBlockReason::UnsupportedTool),
            "{name} is not on the lease"
        );
    }
    assert_eq!(
        decide_runner_tool(&request("gmail_search", &[])),
        RunnerToolDecision::Block(RunnerToolBlockReason::UnsupportedTool)
    );
}

#[test]
fn lease_membership_and_name_shape_decide_connector_tools() {
    let tools = [
        descriptor("gmail.search", ConnectorToolGroup::Read),
        descriptor("gmail_search", ConnectorToolGroup::Read),
        descriptor("read", ConnectorToolGroup::Read),
    ];
    // A dotted name on the lease fails the shape check.
    assert_eq!(
        decide_runner_tool(&request("gmail.search", &tools)),
        RunnerToolDecision::Block(RunnerToolBlockReason::UnsupportedTool)
    );
    // An underscore name on the lease is accepted.
    assert_eq!(
        decide_runner_tool(&request("gmail_search", &tools)),
        RunnerToolDecision::AllowConnector
    );
    // A lease descriptor never shadows a built-in tool.
    assert_eq!(
        decide_runner_tool(&request("read", &tools)),
        RunnerToolDecision::AllowSandbox
    );
    let run = run("person_started", tools.to_vec());
    let names = connectors::tool_definitions(&run)
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    // The owner-private test run also offers the connect link.
    assert_eq!(names, ["gmail_search", "connectors_request_connect"]);
    assert!(run.connectors.descriptor("gmail.search").is_none());
    assert!(run.connectors.descriptor("read").is_none());
    assert!(kordi_tools::connector_tools::is_connector_tool_name(
        "calendar_list-events"
    ));
    assert!(!kordi_tools::connector_tools::is_connector_tool_name(
        &"a".repeat(65)
    ));
    assert!(!kordi_tools::connector_tools::is_connector_tool_name(""));
}

#[tokio::test]
async fn a_tool_not_on_the_lease_is_refused_without_calling_the_broker() {
    let client = BrokerClient::default();
    let run = run(
        "background",
        vec![descriptor("gmail_search", ConnectorToolGroup::Read)],
    );
    let call = ModelToolCall {
        id: "call_1".into(),
        name: "gmail_send".into(),
        arguments: json!({}),
    };
    // Not on the lease: not a connector call, so it reaches the built-in
    // tools, where the runner policy refuses the unknown name.
    assert!(connectors::execute_connector_call(&client, &run, &call)
        .await
        .is_none());
    let root = std::env::temp_dir().join(format!(
        "kordi-connector-refusal-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let sandbox: crate::sandbox_client::SandboxBackendHandle = Arc::new(
        crate::sandbox_client::LocalSandboxBackend::new(root.clone()),
    );
    let executor = crate::tools::CloudToolExecutor::new(sandbox.clone());
    let output =
        crate::model_loop::execute_model_tool(&client, &executor, &sandbox, &run, &call).await;
    assert!(output.as_str().unwrap().contains("not available"));
    assert!(client.calls.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(root);
    let builtin = ModelToolCall {
        name: "read".into(),
        ..call
    };
    assert!(connectors::execute_connector_call(&client, &run, &builtin)
        .await
        .is_none());
}

#[test]
fn descriptors_become_model_tools_and_the_prompt_lists_them() {
    let background = run(
        "background",
        vec![descriptor("gmail_search", ConnectorToolGroup::Read)],
    );
    let definitions = connectors::tool_definitions(&background);
    assert_eq!(definitions.len(), 2);
    assert_eq!(
        definitions[1]["function"]["name"],
        "connectors_request_connect"
    );
    assert_eq!(definitions[0]["function"]["name"], "gmail_search");
    assert_eq!(
        definitions[0]["function"]["parameters"]["properties"]["q"]["type"],
        "string"
    );
    let prompt = connectors::prompt_section(&background).unwrap();
    assert!(prompt.contains("- gmail_search: gmail_search description"));
    assert!(prompt.contains("only read tools are available"));

    let person = run(
        "person_started",
        vec![
            descriptor("gmail_search", ConnectorToolGroup::Read),
            descriptor("gmail_send", ConnectorToolGroup::Act),
        ],
    );
    let prompt = connectors::prompt_section(&person).unwrap();
    assert!(prompt.contains("gmail_send") && !prompt.contains("background run"));
    assert!(connectors::prompt_section(&run("person_started", Vec::new())).is_none());
}

#[tokio::test]
async fn model_loop_returns_the_broker_result_to_the_model() {
    let root = std::env::temp_dir().join(format!(
        "kordi-connector-runner-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let sandbox: crate::sandbox_client::SandboxBackendHandle = Arc::new(
        crate::sandbox_client::LocalSandboxBackend::new(root.clone()),
    );
    let client = BrokerClient::default();
    let provider = ScriptedProvider::default();
    let run = run(
        "person_started",
        vec![descriptor("gmail_search", ConnectorToolGroup::Read)],
    );
    let material = ProviderAuthMaterial {
        snapshot_id: "snap_fake".into(),
        provider: "openai".into(),
        auth_choice: "default".into(),
        payload: json!({"apiKey": "fake-key", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4.1-mini"}),
    };
    let text = run_model_loop(&client, &provider, &run, &sandbox, material)
        .await
        .unwrap();
    assert_eq!(text, "Found Invoice 42.");
    assert!(provider
        .seen_tools
        .lock()
        .unwrap()
        .contains(&"gmail_search".to_string()));
    assert_eq!(
        *client.calls.lock().unwrap(),
        [(
            "car_connectors".to_string(),
            "gmail_search".to_string(),
            json!({"q": "invoice"})
        )]
    );
    let messages = provider.seen_messages.lock().unwrap().clone();
    let tool_message = messages
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap();
    assert!(tool_message["content"]
        .as_str()
        .unwrap()
        .contains("Invoice 42"));
    assert!(messages[0]["content"]
        .as_str()
        .unwrap()
        .contains("Connector tools available in this run"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn no_token_shaped_field_is_read_from_the_lease() {
    let lease = json!({
        "runId": "car_1", "status": "leased", "prompt": "p",
        "ownerAccountId": "a", "requesterAccountId": "a", "sessionId": "s",
        "sandboxId": null, "providerAuthAvailable": true,
        "accessToken": "leaked-access", "refreshToken": "leaked-refresh",
        "trigger": "background",
        "connectorTools": [{
            "connectorId": "conn_1", "provider": "gmail", "name": "gmail_search",
            "group": "read", "description": "Search mail.",
            "inputSchema": {"type": "object"},
            "accessToken": "leaked-access", "secret": "leaked-secret"
        }]
    });
    let run: CloudAgentRun = serde_json::from_value(lease).unwrap();
    assert_eq!(run.connectors.tools.len(), 1);
    assert!(run.connectors.is_background());
    let reserialized = serde_json::to_string(&run).unwrap();
    assert!(!reserialized.contains("leaked"), "{reserialized}");
    for needle in ["token", "secret", "refresh", "ciphertext", "nonce"] {
        assert!(
            !reserialized.to_ascii_lowercase().contains(needle),
            "{needle} in {reserialized}"
        );
    }
}

#[test]
fn broker_answers_become_results_or_clear_errors() {
    let body = connectors::broker_call_body(
        "runner-1",
        "car_1",
        &descriptor("gmail_search", ConnectorToolGroup::Read),
        json!({"q": "x"}),
    );
    assert_eq!(body["leaseId"], "car_1");
    assert_eq!(body["runnerId"], "runner-1");
    assert_eq!(body["connectorId"], "conn_1");
    assert!(body.get("accountId").is_none() && body.get("trigger").is_none());
    assert_eq!(
        connectors::broker_result(200, r#"{"ok":true,"result":{"items":[]}}"#).unwrap(),
        json!({"items": []})
    );
    let denied = connectors::broker_result(
        403,
        r#"{"ok":false,"error":{"code":"blocked_background","message":"Background runs cannot use tools that act."}}"#,
    )
    .unwrap_err()
    .to_string();
    assert!(denied.contains("Background runs cannot use tools that act. (blocked_background)"));
    assert!(connectors::broker_result(502, "<html>")
        .unwrap_err()
        .to_string()
        .contains("HTTP 502"));
}

#[tokio::test]
async fn request_connect_returns_a_settings_link_only_on_owner_private_runs() {
    let client = BrokerClient::default();
    let call = ModelToolCall {
        id: "call_connect".into(),
        name: "connectors_request_connect".into(),
        arguments: json!({ "provider": "slack" }),
    };
    let private = run("person_started", Vec::new());
    assert!(connectors::tool_definitions(&private)
        .iter()
        .any(|tool| tool["function"]["name"] == "connectors_request_connect"));
    let output = connectors::execute_connector_call(&client, &private, &call)
        .await
        .unwrap();
    let result: Value = serde_json::from_str(output.as_str().unwrap()).unwrap();
    assert_eq!(
        result["openUrl"],
        "kordi://settings/connectors?provider=slack"
    );
    assert!(
        client.calls.lock().unwrap().is_empty(),
        "no grant, no broker"
    );

    let mut shared = run("person_started", Vec::new());
    shared.connectors.audience = Some("shared".into());
    assert!(connectors::tool_definitions(&shared).is_empty());
    let refused = connectors::execute_connector_call(&client, &shared, &call)
        .await
        .unwrap();
    assert!(refused.as_str().unwrap().contains("not available"));
    let parsed: LeaseConnectors = serde_json::from_value(json!({
        "trigger": "person_started",
        "connectorTools": [],
        "connectorAudience": "owner_private"
    }))
    .unwrap();
    assert!(parsed.is_owner_private());
    assert!(!LeaseConnectors::default().is_owner_private());
}

#[test]
fn offered_tools_skip_built_ins_bad_shapes_and_repeats() {
    let mut repeat = descriptor("gmail_search", ConnectorToolGroup::Read);
    repeat.description = "a second gmail_search".into();
    let tools = vec![
        descriptor("gmail.search", ConnectorToolGroup::Read),
        descriptor("gmail_search", ConnectorToolGroup::Read),
        repeat,
        descriptor("export_artifact", ConnectorToolGroup::Read),
    ];
    // The policy itself refuses a lease name that is a built-in tool.
    assert_eq!(
        decide_runner_tool(&request("export_artifact", &tools)),
        RunnerToolDecision::Block(RunnerToolBlockReason::UnsupportedTool)
    );
    let run = run("person_started", tools);
    let names = connectors::tool_definitions(&run)
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(names, ["gmail_search"]);
    let prompt = connectors::prompt_section(&run).unwrap();
    assert_eq!(prompt.matches("\n- ").count(), 1, "{prompt}");
    assert!(prompt.contains("- gmail_search: gmail_search description"));
    assert!(!prompt.contains("export_artifact") && !prompt.contains("gmail.search"));
}

#[test]
fn a_bad_lease_entry_drops_only_itself() {
    let lease = json!({
        "runId": "car_1", "status": "leased", "prompt": "p",
        "ownerAccountId": "a", "requesterAccountId": "a", "sessionId": "s",
        "sandboxId": null, "providerAuthAvailable": false,
        "trigger": "person_started",
        "connectorTools": [
            {"connectorId": "conn_1", "provider": "gmail", "name": "gmail_search",
             "group": "read", "description": "Search mail."},
            {"connectorId": "conn_1", "provider": "gmail", "name": "gmail_watch",
             "group": "stream", "description": "Unknown group."},
            {"name": "missing_fields"},
            {"connectorId": "conn_1", "provider": "gmail", "name": "gmail_send",
             "group": "act", "description": "Send mail."}
        ]
    });
    let run: CloudAgentRun = serde_json::from_value(lease).unwrap();
    let names = run
        .connectors
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(names, ["gmail_search", "gmail_send"]);
}
