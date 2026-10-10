use super::*;

#[path = "memory_global_tests.rs"]
mod global_tests;
use crate::client::{
    ArtifactExportInput, ArtifactExportResponse, ProviderAuthMaterial, RunnerClientError,
};
use crate::model_loop::{
    run_model_loop, CloudModelProvider, ModelLoopError, ModelProviderResponse, ModelToolCall,
    OpenAiProviderConfig,
};
use crate::sandbox_client::{LocalSandboxBackend, SandboxBackendHandle};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const SESSION_ID: &str = "session:group:grp_alpha";

#[derive(Clone)]
enum FetchBehavior {
    Context(RunnerMemoryContext),
    Error(MemoryRequestError),
}

#[derive(Clone)]
struct MemoryClient {
    fetch: FetchBehavior,
    save_error: Option<MemoryRequestError>,
    existing_id: Option<String>,
    saved: Arc<Mutex<Vec<(String, NewRunnerMemory)>>>,
}

impl MemoryClient {
    fn new(fetch: FetchBehavior) -> Self {
        Self {
            fetch,
            save_error: None,
            existing_id: None,
            saved: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

#[async_trait]
impl CloudAgentRunClient for MemoryClient {
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
        Ok(auth_material())
    }
    async fn export_artifact(
        &self,
        _: &str,
        _: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        Err(RunnerClientError::Request("unused".into()))
    }
    async fn fetch_memory(&self, _: &str) -> Result<RunnerMemoryContext, MemoryRequestError> {
        match &self.fetch {
            FetchBehavior::Context(context) => Ok(context.clone()),
            FetchBehavior::Error(error) => Err(error.clone()),
        }
    }
    async fn save_memory(
        &self,
        run_id: &str,
        memory: NewRunnerMemory,
    ) -> Result<RunnerMemory, MemoryRequestError> {
        self.saved
            .lock()
            .unwrap()
            .push((run_id.to_string(), memory.clone()));
        if let Some(error) = &self.save_error {
            return Err(error.clone());
        }
        // Like the server: a new memory takes the clientMemoryId, and text the
        // scope already holds returns that memory.
        let id = self
            .existing_id
            .clone()
            .or(memory.client_memory_id.clone())
            .unwrap();
        Ok(memory_row(
            &id,
            &memory.scope,
            &memory.scope_id,
            &memory.text,
            "2026-10-07T00:00:00+00:00",
        ))
    }
}

struct ScriptedProvider {
    responses: Mutex<Vec<ModelProviderResponse>>,
    seen: Mutex<Vec<(Vec<Value>, Vec<Value>)>>,
}

impl ScriptedProvider {
    fn new(mut responses: Vec<ModelProviderResponse>) -> Self {
        responses.reverse();
        Self {
            responses: Mutex::new(responses),
            seen: Mutex::new(Vec::new()),
        }
    }

    fn system_prompt(&self) -> String {
        self.seen.lock().unwrap()[0].0[0]["content"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn tool_names(&self) -> Vec<String> {
        self.seen.lock().unwrap()[0]
            .1
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
            .collect()
    }

    fn last_messages(&self) -> Vec<Value> {
        self.seen.lock().unwrap().last().unwrap().0.clone()
    }
}

#[async_trait]
impl CloudModelProvider for ScriptedProvider {
    async fn next_response(
        &self,
        _auth: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        self.seen
            .lock()
            .unwrap()
            .push((messages.to_vec(), tools.to_vec()));
        Ok(self
            .responses
            .lock()
            .unwrap()
            .pop()
            .unwrap_or_else(|| ModelProviderResponse::FinalText("done".into())))
    }
}

fn auth_material() -> ProviderAuthMaterial {
    ProviderAuthMaterial {
        snapshot_id: "snap_fake".into(),
        provider: "openai".into(),
        auth_choice: "default".into(),
        payload: json!({
            "apiKey": "fake-key",
            "baseUrl": "https://api.openai.com/v1",
            "model": "gpt-4.1-mini"
        }),
    }
}

fn memory_row(id: &str, scope: &str, scope_id: &str, text: &str, at: &str) -> RunnerMemory {
    RunnerMemory {
        memory_id: id.into(),
        scope: scope.into(),
        scope_id: scope_id.into(),
        scope_label: None,
        source: "user_correction".into(),
        text: text.into(),
        created_at: at.into(),
        updated_at: at.into(),
    }
}

fn run() -> CloudAgentRun {
    CloudAgentRun {
        turn_identity: None,
        history_messages: Vec::new(),
        subsession_id: None,
        subsession_write_scope: Vec::new(),
        run_id: "car_memory".into(),
        status: "leased".into(),
        prompt: "hello".into(),
        system_prompt: String::new(),
        owner_account_id: "acct_owner".into(),
        requester_account_id: "acct_owner".into(),
        session_id: SESSION_ID.into(),
        sandbox_id: Some("cas_memory".into()),
        runtime_route: Default::default(),
        provider_auth_available: true,
        connectors: Default::default(),
    }
}

fn sandbox() -> SandboxBackendHandle {
    Arc::new(LocalSandboxBackend::new(std::env::temp_dir().join(
        format!("kordi-memory-test-{}", uuid::Uuid::new_v4().simple()),
    )))
}

fn context(enabled: bool, memories: Vec<RunnerMemory>) -> RunnerMemoryContext {
    RunnerMemoryContext {
        memories,
        settings: RunnerMemorySettings {
            memory_enabled: enabled,
            exclude_sensitive: true,
        },
    }
}

fn two_memories() -> Vec<RunnerMemory> {
    vec![
        memory_row(
            "mem_1",
            "conversation",
            SESSION_ID,
            "Use metric units here.",
            "2026-10-01T00:00:00+00:00",
        ),
        memory_row(
            "mem_2",
            "conversation",
            "session:group:other",
            "Other conversation memory.",
            "2026-10-02T00:00:00+00:00",
        ),
    ]
}

async fn run_with(client: &MemoryClient, provider: &ScriptedProvider) -> String {
    run_model_loop(client, provider, &run(), &sandbox(), auth_material())
        .await
        .expect("memory problems never fail the run")
}

#[tokio::test]
async fn enabled_memory_adds_matching_memories_and_the_reflection_tool() {
    let client = MemoryClient::new(FetchBehavior::Context(context(true, two_memories())));
    let provider = ScriptedProvider::new(Vec::new());
    run_with(&client, &provider).await;

    let prompt = provider.system_prompt();
    assert!(prompt.contains("## Memories"));
    assert!(prompt.contains("must not record health"));
    assert!(prompt.contains("\nThis conversation:\n- Use metric units here."));
    assert!(!prompt.contains("Other conversation memory."));
    assert!(provider
        .tool_names()
        .iter()
        .any(|name| name == "reflection"));
}

#[tokio::test]
async fn disabled_memory_removes_the_section_and_the_tool() {
    let client = MemoryClient::new(FetchBehavior::Context(context(false, two_memories())));
    let provider = ScriptedProvider::new(Vec::new());
    run_with(&client, &provider).await;

    assert!(!provider.system_prompt().contains("## Memories"));
    assert!(!provider
        .tool_names()
        .iter()
        .any(|name| name == "reflection"));
}

#[tokio::test]
async fn fetch_errors_disable_memory_without_failing_the_run() {
    for error in [
        MemoryRequestError::Unavailable,
        MemoryRequestError::Request("connection reset".into()),
        MemoryRequestError::Server {
            status: 500,
            code: "server_error".into(),
            message: "boom".into(),
        },
    ] {
        let client = MemoryClient::new(FetchBehavior::Error(error));
        let provider = ScriptedProvider::new(Vec::new());
        assert_eq!(run_with(&client, &provider).await, "done");
        assert!(!provider.system_prompt().contains("## Memories"));
        assert!(!provider
            .tool_names()
            .iter()
            .any(|name| name == "reflection"));
    }
}

#[tokio::test]
async fn reflection_call_saves_memory_and_relays_the_server_rejection() {
    let mut client = MemoryClient::new(FetchBehavior::Context(context(true, Vec::new())));
    client.save_error = Some(MemoryRequestError::Server {
        status: 422,
        code: "memory_rejected".into(),
        message: "This memory looks like health information. Save a memory about the task instead."
            .into(),
    });
    let provider = ScriptedProvider::new(vec![ModelProviderResponse::ToolCalls(vec![
        ModelToolCall {
            id: "call_1".into(),
            name: "reflection".into(),
            arguments: json!({
                "scope": "conversation",
                "scopeId": SESSION_ID,
                "source": "user_correction",
                "lesson": "  Prefer short answers.  "
            }),
        },
    ])]);
    run_with(&client, &provider).await;

    let saved = client.saved.lock().unwrap().clone();
    assert_eq!(saved.len(), 1);
    let (run_id, memory) = &saved[0];
    assert_eq!(run_id, "car_memory");
    assert_eq!(memory.scope, "conversation");
    assert_eq!(memory.scope_id, SESSION_ID);
    assert_eq!(memory.source, "user_correction");
    assert_eq!(memory.text, "Prefer short answers.");
    let client_id = memory.client_memory_id.as_deref().unwrap();
    assert!(client_id.starts_with("mem_") && client_id.len() == 36);
    let body = serde_json::to_value(memory).unwrap();
    assert_eq!(body["scopeId"], SESSION_ID);
    assert!(body.get("scopeLabel").is_none());

    let tool_message = provider
        .last_messages()
        .into_iter()
        .find(|message| message["role"] == "tool")
        .unwrap();
    assert_eq!(
        tool_message["content"],
        "This memory looks like health information. Save a memory about the task instead."
    );
}

#[tokio::test]
async fn saved_reflection_reports_a_pseudo_path_instead_of_a_file() {
    let client = MemoryClient::new(FetchBehavior::Context(context(true, Vec::new())));
    let provider = ScriptedProvider::new(vec![ModelProviderResponse::ToolCalls(vec![
        ModelToolCall {
            id: "call_1".into(),
            name: "reflection".into(),
            arguments: json!({
                "scope": "group",
                "scopeId": "grp_alpha",
                "source": "outcome",
                "lesson": "The weekly report goes out on Fridays."
            }),
        },
    ])]);
    run_with(&client, &provider).await;

    let tool_message = provider
        .last_messages()
        .into_iter()
        .find(|message| message["role"] == "tool")
        .unwrap();
    assert_eq!(
        tool_message["content"],
        "Reflection lesson saved to kordi-memory://group/grp_alpha"
    );
}

#[test]
fn prompt_section_scopes_caps_and_sensitive_sentence() {
    let mut memories = vec![
        memory_row(
            "mem_g",
            "group",
            "grp_alpha",
            "Group memory.",
            "2026-09-01T00:00:00+00:00",
        ),
        memory_row(
            "mem_p",
            "project",
            "proj_1",
            "Project memory.",
            "2026-09-01T00:00:00+00:00",
        ),
    ];
    for index in 0..45 {
        memories.push(memory_row(
            &format!("mem_{index}"),
            "conversation",
            SESSION_ID,
            &format!("Memory number {index:02}."),
            &format!("2026-10-01T00:00:{index:02}+00:00"),
        ));
    }
    let memory = RunMemory {
        enabled: true,
        exclude_sensitive: false,
        memories,
    };
    let section = memory_prompt_section(&run(), &memory).unwrap();
    assert!(!section.contains("must not record health"));
    assert!(section.contains(
        "Scope ids for this run: global `account`, conversation `session:group:grp_alpha`, group `grp_alpha`."
    ));
    assert!(section.contains("Memory number 44."));
    assert!(!section.contains("Memory number 04."));
    assert!(!section.contains("Project memory."));
    assert!(section.find("Memory number 44.") < section.find("Memory number 43."));
    assert_eq!(section.matches("\n- ").count(), MAX_PROMPT_MEMORIES);
    assert!(section.ends_with("(more memories omitted)"));

    let mut long = memory.clone();
    long.memories = (0..30)
        .map(|index| {
            memory_row(
                &format!("mem_long_{index}"),
                "conversation",
                SESSION_ID,
                &"x".repeat(400),
                &format!("2026-10-01T00:00:{index:02}+00:00"),
            )
        })
        .collect();
    let section = memory_prompt_section(&run(), &long).unwrap();
    assert!(section.ends_with("(more memories omitted)"));
    assert!(section.matches("\n- ").count() < 30);

    let empty = RunMemory {
        enabled: true,
        exclude_sensitive: true,
        memories: Vec::new(),
    };
    let section = memory_prompt_section(&run(), &empty).unwrap();
    assert!(!section.contains("\n- "));
    assert!(memory_prompt_section(&run(), &RunMemory::disabled()).is_none());
}
