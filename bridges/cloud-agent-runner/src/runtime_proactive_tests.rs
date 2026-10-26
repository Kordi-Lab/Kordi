use std::sync::Mutex;

use super::tests::{leased_run, legacy_fixture_run, temp_sandbox, FakeClient};
use super::*;
use crate::connectors::LeaseConnectors;
use crate::memory::{RunMemory, RunnerMemory};
use crate::model_loop::{
    CloudModelProvider, ModelLoopError, ModelProviderResponse, ModelToolCall, OpenAiProviderConfig,
};
use async_trait::async_trait;
use kordi_tools::connector_tools::{ConnectorToolDescriptor, ConnectorToolGroup};
use serde_json::{json, Value};

struct EvaluationProvider(&'static str);

#[async_trait]
impl CloudModelProvider for EvaluationProvider {
    async fn next_response(
        &self,
        _: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        assert!(tools.is_empty(), "evaluations get no tools");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"], "Evaluation rules");
        assert_eq!(messages[1]["content"], "{\"messages\":[]}");
        Ok(ModelProviderResponse::FinalText(self.0.into()))
    }
}

fn evaluation_run(run_id: &str) -> CloudAgentRun {
    CloudAgentRun {
        prompt: "{\"messages\":[]}".into(),
        system_prompt: "Evaluation rules".into(),
        sandbox_id: None,
        session_id: "session:group:grp_alpha".into(),
        ..leased_run(run_id, true)
    }
}

#[tokio::test]
async fn evaluations_complete_with_one_turn_and_no_sandbox() {
    let client = FakeClient::with_run(evaluation_run("proactive_eval_fixture"));
    let root = temp_sandbox();
    let reply = "{\"decision\":\"silence\"}";
    let outcome = legacy_fixture_run(&client, &EvaluationProvider(reply), root.clone())
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "proactive_eval_fixture".into()
        }
    );
    assert!(!root.exists());
    assert_eq!(
        client.calls(),
        vec![
            "lease",
            "running:proactive_eval_fixture",
            "provider-auth:proactive_eval_fixture",
            "complete:proactive_eval_fixture:{\"decision\":\"silence\"}"
        ]
    );
}

#[tokio::test]
async fn personal_agent_evaluations_run_the_same_single_turn() {
    let run = CloudAgentRun {
        session_id: "personal-agent:cloud-agent:acct_fixture".into(),
        ..evaluation_run("personal_agent_eval_fixture")
    };
    let client = FakeClient::with_run(run);
    let root = temp_sandbox();
    let reply = "{\"decision\":\"skip\"}";
    let outcome = legacy_fixture_run(&client, &EvaluationProvider(reply), root.clone())
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "personal_agent_eval_fixture".into()
        }
    );
    assert!(!root.exists(), "no sandbox");
    assert_eq!(
        client.calls().last().map(String::as_str),
        Some("complete:personal_agent_eval_fixture:{\"decision\":\"skip\"}")
    );
    assert!(crate::memory::searches_memory(&evaluation_run(
        "personal_agent_eval_x"
    )));
}

#[tokio::test]
async fn an_empty_evaluation_reply_is_submitted_as_silence() {
    let client = FakeClient::with_run(evaluation_run("proactive_eval_empty"));
    let outcome = legacy_fixture_run(&client, &EvaluationProvider("  "), temp_sandbox())
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "proactive_eval_empty".into()
        }
    );
    assert!(client
        .calls()
        .contains(&"complete:proactive_eval_empty:{\"decision\":\"silence\"}".to_string()));
}

fn descriptor(connector_id: &str, name: &str) -> ConnectorToolDescriptor {
    ConnectorToolDescriptor {
        connector_id: connector_id.into(),
        provider: connector_id.replace('-', "_"),
        name: name.into(),
        group: ConnectorToolGroup::Read,
        description: format!("{name} tool"),
        input_schema: json!({"type": "object"}),
    }
}

/// An evaluation lease as the server delivers it: `search_memory`, plus a
/// tool an evaluation must never be offered.
fn searching_run(run_id: &str) -> CloudAgentRun {
    CloudAgentRun {
        connectors: LeaseConnectors {
            trigger: Some("background".into()),
            tools: vec![
                descriptor("kordi-memory", "search_memory"),
                descriptor("gmail", "gmail_search"),
            ],
            audience: Some("owner_private".into()),
        },
        ..evaluation_run(run_id)
    }
}

#[test]
fn proactive_runs_get_no_memory_section() {
    let loaded = RunMemory {
        enabled: true,
        exclude_sensitive: true,
        memories: vec![RunnerMemory {
            memory_id: "mem_1".into(),
            scope: "global".into(),
            scope_id: crate::memory::GLOBAL_SCOPE_ID.into(),
            source: "manual".into(),
            text: "Prefers short answers".into(),
            created_at: "2026-10-01T00:00:00Z".into(),
            updated_at: "2026-10-01T00:00:00Z".into(),
            ..RunnerMemory::default()
        }],
    };
    let ordinary = evaluation_run("car_ordinary");
    assert!(crate::memory::memory_prompt_section(&ordinary, &loaded)
        .unwrap()
        .contains("Prefers short answers"));
    for run in [
        evaluation_run("proactive_eval_memory"),
        evaluation_run("proactive_run_pro_memory"),
        searching_run("car_with_search"),
    ] {
        assert!(
            crate::memory::memory_prompt_section(&run, &loaded).is_none(),
            "{}",
            run.run_id
        );
    }
}

/// Searches until it is told that no searches are left, then answers. With
/// `never_answers` it keeps searching. Like the Anthropic API, it refuses a
/// request whose history holds tool calls but defines no tools.
#[derive(Default)]
struct SearchingProvider {
    never_answers: bool,
    offered: Mutex<Vec<Vec<String>>>,
    last_messages: Mutex<Vec<Value>>,
}

#[async_trait]
impl CloudModelProvider for SearchingProvider {
    async fn next_response(
        &self,
        _: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        assert_eq!(
            messages[0]["content"], "Evaluation rules",
            "no memory section"
        );
        *self.last_messages.lock().unwrap() = messages.to_vec();
        if tools.is_empty()
            && messages
                .iter()
                .any(|message| message["tool_calls"].is_array())
        {
            return Err(ModelLoopError::Provider(
                "tool calls in the history need tool definitions".into(),
            ));
        }
        let mut offered = self.offered.lock().unwrap();
        offered.push(
            tools
                .iter()
                .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_string))
                .collect(),
        );
        let told_to_answer = messages.last().is_some_and(|message| {
            message["role"] == "tool"
                && message["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("No searches are left"))
        });
        if told_to_answer && !self.never_answers {
            return Ok(ModelProviderResponse::FinalText(
                "{\"decision\":\"silence\"}".into(),
            ));
        }
        Ok(ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: format!("call_{}", offered.len()),
            name: "search_memory".into(),
            arguments: json!({"query": "deploy"}),
        }]))
    }
}

/// Records memory reads and broker calls; answers every search the same.
#[derive(Default)]
struct SearchClient {
    calls: Mutex<Vec<String>>,
}

#[async_trait]
impl CloudAgentRunClient for SearchClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        Ok(None)
    }
    async fn mark_running(&self, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn complete_run(&self, run_id: &str, text: &str) -> Result<(), RunnerClientError> {
        let call = format!("complete:{run_id}:{text}");
        self.calls.lock().unwrap().push(call);
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
        run_id: &str,
    ) -> Result<crate::client::ProviderAuthMaterial, RunnerClientError> {
        FakeClient::with_run(evaluation_run(run_id))
            .fetch_provider_auth(run_id)
            .await
    }
    async fn export_artifact(
        &self,
        _: &str,
        _: crate::client::ArtifactExportInput,
    ) -> Result<crate::client::ArtifactExportResponse, RunnerClientError> {
        unreachable!()
    }
    async fn call_connector_tool(
        &self,
        run_id: &str,
        tool: &ConnectorToolDescriptor,
        args: Value,
    ) -> Result<Value, RunnerClientError> {
        let call = format!("search:{run_id}:{}:{}:{args}", tool.connector_id, tool.name);
        self.calls.lock().unwrap().push(call);
        Ok(json!({"memories": [{"text": "Deploys from the ops repo"}]}))
    }
    async fn fetch_memory(
        &self,
        run_id: &str,
    ) -> Result<crate::memory::RunnerMemoryContext, crate::memory::MemoryRequestError> {
        self.calls.lock().unwrap().push(format!("memory:{run_id}"));
        Err(crate::memory::MemoryRequestError::Unavailable)
    }
}

#[tokio::test]
async fn an_evaluation_searches_memory_three_times_at_most_then_answers() {
    let client = SearchClient::default();
    let provider = SearchingProvider::default();
    let run = searching_run("proactive_eval_search");
    let outcome = crate::proactive::step(&client, &provider, CloudModelEngine::Rust, run)
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "proactive_eval_search".into()
        }
    );
    let only = vec!["search_memory".to_string()];
    assert_eq!(
        *provider.offered.lock().unwrap(),
        vec![only; 5],
        "only search_memory, on every request: three searches, one call told \
         that none are left, and the answer"
    );
    let search = "search:proactive_eval_search:kordi-memory:search_memory:{\"query\":\"deploy\"}";
    assert_eq!(
        *client.calls.lock().unwrap(),
        vec![
            search.to_string(),
            search.to_string(),
            search.to_string(),
            "complete:proactive_eval_search:{\"decision\":\"silence\"}".to_string(),
        ],
        "the server answers each search; memories are never preloaded"
    );
    let messages = provider.last_messages.lock().unwrap();
    let results: Vec<&Value> = messages
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect();
    assert_eq!(results.len(), 4);
    assert!(results[0]["content"]
        .as_str()
        .unwrap()
        .contains("Deploys from the ops repo"));
    assert!(results[3]["content"]
        .as_str()
        .unwrap()
        .contains("No searches are left"));
}

#[tokio::test]
async fn an_evaluation_that_keeps_searching_fails_after_its_requests() {
    let client = SearchClient::default();
    let provider = SearchingProvider {
        never_answers: true,
        ..SearchingProvider::default()
    };
    let run = searching_run("proactive_eval_loop");
    let outcome = crate::proactive::step(&client, &provider, CloudModelEngine::Rust, run)
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::FailedProviderError {
            run_id: "proactive_eval_loop".into()
        }
    );
    assert_eq!(provider.offered.lock().unwrap().len(), 5);
    let calls = client.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.starts_with("search:"))
            .count(),
        3,
        "the server answers three searches at most"
    );
    assert_eq!(
        calls.last().unwrap(),
        "fail:proactive_eval_loop:proactive_evaluation_failed"
    );
}
