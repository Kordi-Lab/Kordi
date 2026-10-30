//! A cloud run whose model ends on tool calls with no closing text. The server
//! refuses an empty reply, so the run must reply with what it did, or fail
//! when its last tool failed or it ran none.

use std::sync::Mutex;

use async_trait::async_trait;
use kordi_tools::connector_tools::{ConnectorToolDescriptor, ConnectorToolGroup};
use serde_json::{json, Value};

use super::*;
use crate::client::{ArtifactExportInput, ArtifactExportResponse, ProviderAuthMaterial};
use crate::connectors::LeaseConnectors;
use crate::model_loop::{ModelLoopError, ModelProviderResponse, ModelToolCall};

/// Stands in for the server: runs `create_document` with the broker's result
/// shape and refuses an empty reply the way the completion route does.
struct ServerLikeClient {
    run: Mutex<Option<CloudAgentRun>>,
    calls: Mutex<Vec<String>>,
    tool_fails: bool,
}

impl ServerLikeClient {
    fn new(run: CloudAgentRun, tool_fails: bool) -> Self {
        Self {
            run: Mutex::new(Some(run)),
            calls: Mutex::new(Vec::new()),
            tool_fails,
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl CloudAgentRunClient for ServerLikeClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        Ok(self.run.lock().unwrap().take())
    }
    async fn mark_running(&self, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn complete_run(&self, run_id: &str, text: &str) -> Result<(), RunnerClientError> {
        if text.trim().is_empty() {
            return Err(RunnerClientError::Request(
                "Cloud agent run was not found for this runner.".into(),
            ));
        }
        self.calls
            .lock()
            .unwrap()
            .push(format!("complete:{run_id}:{text}"));
        Ok(())
    }
    async fn fail_run(&self, run_id: &str, code: &str, _: &str) -> Result<(), RunnerClientError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("fail:{run_id}:{code}"));
        Ok(())
    }
    async fn fetch_provider_auth(
        &self,
        _: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        Ok(ProviderAuthMaterial {
            snapshot_id: "snap_fixture".into(),
            provider: "openai".into(),
            auth_choice: "default".into(),
            payload: json!({
                "apiKey": "fixture-key",
                "baseUrl": "https://api.openai.com/v1",
                "model": "gpt-4.1-mini"
            }),
        })
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
        _: &str,
        tool: &ConnectorToolDescriptor,
        args: Value,
    ) -> Result<Value, RunnerClientError> {
        if self.tool_fails {
            return Err(RunnerClientError::Request(
                "The title is missing. (invalid_arguments)".into(),
            ));
        }
        Ok(match tool.name.as_str() {
            "create_document" => json!({
                "created": true,
                "attachmentId": "att_fixture",
                "title": args["title"],
                "fileName": "launch-plan.md",
                "format": "markdown",
                "note": "Saved. Reply briefly with what it covers."
            }),
            _ => json!({ "summary": "Found 2 invoices.", "messages": [] }),
        })
    }
}

/// Makes `call`, then ends the turn with no text.
struct EndsOnToolCall(Option<ModelToolCall>);

#[async_trait]
impl CloudModelProvider for EndsOnToolCall {
    async fn next_response(
        &self,
        _: &crate::model_loop::OpenAiProviderConfig,
        messages: &[Value],
        _: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        let answered = messages
            .last()
            .is_some_and(|message| message["role"] == "tool");
        Ok(match &self.0 {
            Some(call) if !answered => ModelProviderResponse::ToolCalls(vec![call.clone()]),
            _ => ModelProviderResponse::FinalText(String::new()),
        })
    }
}

fn descriptor(
    connector_id: &str,
    name: &str,
    group: ConnectorToolGroup,
) -> ConnectorToolDescriptor {
    ConnectorToolDescriptor {
        connector_id: connector_id.into(),
        provider: connector_id.replace('-', "_"),
        name: name.into(),
        group,
        description: format!("{name} description"),
        input_schema: json!({ "type": "object" }),
    }
}

fn group_run(run_id: &str) -> CloudAgentRun {
    CloudAgentRun {
        agent_communication: false,
        turn_identity: None,
        history_messages: Vec::new(),
        subsession_id: None,
        subsession_write_scope: Vec::new(),
        run_id: run_id.into(),
        status: "leased".into(),
        prompt: "@Kordi write up the launch plan as a doc".into(),
        system_prompt: String::new(),
        owner_account_id: "acct_owner".into(),
        requester_account_id: "acct_member".into(),
        session_id: "session:group:fixture".into(),
        sandbox_id: Some("cas_fixture".into()),
        runtime_route: Default::default(),
        provider_auth_available: true,
        provider_auth_needs_reconnect: false,
        connectors: LeaseConnectors {
            trigger: Some("person_started".into()),
            tools: vec![
                descriptor(
                    "kordi-documents",
                    "create_document",
                    ConnectorToolGroup::Act,
                ),
                descriptor("conn_mail", "gmail_search", ConnectorToolGroup::Read),
            ],
            audience: Some("shared".into()),
        },
    }
}

fn call(name: &str, arguments: Value) -> Option<ModelToolCall> {
    Some(ModelToolCall {
        id: format!("call_{name}"),
        name: name.into(),
        arguments,
    })
}

async fn run_once(client: &ServerLikeClient, provider: &EndsOnToolCall) -> RunnerStepOutcome {
    let root = std::env::temp_dir().join(format!(
        "kordi-tool-only-reply-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let outcome =
        process_one_run_with_engine(client, provider, root.clone(), CloudModelEngine::Rust)
            .await
            .expect("the run reaches a terminal state");
    let _ = std::fs::remove_dir_all(root);
    outcome
}

#[tokio::test]
async fn a_run_that_ends_on_create_document_replies_with_its_title() {
    let client = ServerLikeClient::new(group_run("car_doc"), false);
    let provider = EndsOnToolCall(call(
        "create_document",
        json!({ "title": "Launch plan", "content": "# Launch plan" }),
    ));
    let outcome = run_once(&client, &provider).await;
    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "car_doc".into()
        }
    );
    assert_eq!(client.calls(), ["complete:car_doc:Created “Launch plan”."]);
}

#[tokio::test]
async fn a_run_that_ends_on_another_tool_replies_with_its_summary_or_a_short_line() {
    let client = ServerLikeClient::new(group_run("car_search"), false);
    let provider = EndsOnToolCall(call("gmail_search", json!({ "q": "invoices" })));
    run_once(&client, &provider).await;
    assert_eq!(client.calls(), ["complete:car_search:Found 2 invoices."]);

    let client = ServerLikeClient::new(group_run("car_write"), false);
    let provider = EndsOnToolCall(call("write", json!({ "path": "notes.md", "content": "x" })));
    run_once(&client, &provider).await;
    assert_eq!(client.calls(), ["complete:car_write:Done."]);
}

#[tokio::test]
async fn a_failed_last_tool_fails_the_run_instead_of_claiming_success() {
    let client = ServerLikeClient::new(group_run("car_failed_doc"), true);
    let provider = EndsOnToolCall(call("create_document", json!({ "title": "Untitled" })));
    let outcome = run_once(&client, &provider).await;
    assert_eq!(
        outcome,
        RunnerStepOutcome::FailedProviderError {
            run_id: "car_failed_doc".into()
        }
    );
    assert_eq!(client.calls(), ["fail:car_failed_doc:tool_error"]);

    let client = ServerLikeClient::new(group_run("car_failed_bash"), false);
    let provider = EndsOnToolCall(call("bash", json!({ "command": "exit 3" })));
    run_once(&client, &provider).await;
    assert_eq!(client.calls(), ["fail:car_failed_bash:tool_error"]);
}

#[tokio::test]
async fn a_run_with_no_tool_and_no_text_still_fails() {
    let client = ServerLikeClient::new(group_run("car_empty"), false);
    let outcome = run_once(&client, &EndsOnToolCall(None)).await;
    assert_eq!(
        outcome,
        RunnerStepOutcome::FailedProviderError {
            run_id: "car_empty".into()
        }
    );
    assert_eq!(client.calls(), ["fail:car_empty:model_provider_error"]);
}
