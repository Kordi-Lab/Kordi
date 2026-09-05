use super::*;
use crate::model_loop::{
    CloudModelProvider, ModelLoopError, ModelProviderResponse, OpenAiProviderConfig,
};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct FakeClient {
    run: Arc<Mutex<Option<CloudAgentRun>>>,
    calls: Arc<Mutex<Vec<String>>>,
    fail_provider_auth_fetch: bool,
}

struct FakeModelProvider {
    response: ModelProviderResponse,
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

impl FakeClient {
    fn with_run(run: CloudAgentRun) -> Self {
        Self {
            run: Arc::new(Mutex::new(Some(run))),
            calls: Arc::new(Mutex::new(Vec::new())),
            fail_provider_auth_fetch: false,
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl CloudAgentRunClient for FakeClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        self.calls.lock().unwrap().push("lease".to_string());
        Ok(self.run.lock().unwrap().take())
    }

    async fn mark_running(&self, run_id: &str) -> Result<(), RunnerClientError> {
        self.calls.lock().unwrap().push(format!("running:{run_id}"));
        Ok(())
    }

    async fn complete_run(
        &self,
        run_id: &str,
        response_text: &str,
    ) -> Result<(), RunnerClientError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("complete:{run_id}:{response_text}"));
        Ok(())
    }

    async fn fail_run(
        &self,
        run_id: &str,
        error_code: &str,
        _message: &str,
    ) -> Result<(), RunnerClientError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("fail:{run_id}:{error_code}"));
        Ok(())
    }

    async fn fetch_provider_auth(
        &self,
        run_id: &str,
    ) -> Result<crate::client::ProviderAuthMaterial, RunnerClientError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("provider-auth:{run_id}"));
        if self.fail_provider_auth_fetch {
            return Err(RunnerClientError::Request(
                "provider-auth unavailable".to_string(),
            ));
        }
        Ok(crate::client::ProviderAuthMaterial {
            snapshot_id: "snap_fake".to_string(),
            provider: "openai".to_string(),
            auth_choice: "default".to_string(),
            payload: serde_json::json!({
                "apiKey": "fake-key",
                "baseUrl": "https://api.openai.com/v1",
                "model": "gpt-4.1-mini"
            }),
        })
    }

    async fn export_artifact(
        &self,
        run_id: &str,
        input: crate::client::ArtifactExportInput,
    ) -> Result<crate::client::ArtifactExportResponse, RunnerClientError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("export:{run_id}:{}", input.sandbox_path));
        Ok(crate::client::ArtifactExportResponse {
            artifact_id: "carartifact_fake".to_string(),
            attachment_id: "att_fake".to_string(),
            run_id: run_id.to_string(),
            message_id: "cloudrunmsg_fake".to_string(),
            name: input.name,
            sandbox_path: input.sandbox_path,
            content_type: input.content_type,
            size_bytes: 0,
            sha256_hex: Some(input.sha256_hex),
            created_at: "2026-05-24T00:00:00Z".to_string(),
        })
    }
}
fn leased_run(run_id: &str, provider_auth_available: bool) -> CloudAgentRun {
    CloudAgentRun {
        run_id: run_id.to_string(),
        status: "leased".to_string(),
        prompt: "hello".to_string(),
        system_prompt: String::new(),
        owner_account_id: "acct_owner".to_string(),
        requester_account_id: "acct_requester".to_string(),
        session_id: "session:direct-person:a:b".to_string(),
        sandbox_id: Some("cas_test".to_string()),
        runtime_route: Default::default(),
        provider_auth_available,
    }
}

#[test]
fn sandbox_backend_selection_defaults_to_local() {
    std::env::remove_var("KORDI_CLOUD_SANDBOX_BACKEND");
    assert_eq!(sandbox_backend_mode_from_env(), SandboxBackendMode::Local);
}

#[tokio::test]
async fn k8s_backend_requires_sandbox_id() {
    std::env::set_var("KORDI_CLOUD_SANDBOX_BACKEND", "k8s");
    let client = FakeClient::with_run(CloudAgentRun {
        sandbox_id: None,
        ..leased_run("car_no_sandbox", true)
    });
    let provider = FakeModelProvider {
        response: ModelProviderResponse::FinalText("unused".to_string()),
    };

    let outcome = process_one_run_with_provider(&client, &provider, temp_sandbox())
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunnerStepOutcome::FailedMissingSandbox {
            run_id: "car_no_sandbox".to_string()
        }
    );
    assert_eq!(
        client.calls(),
        vec![
            "lease",
            "running:car_no_sandbox",
            "fail:car_no_sandbox:missing_sandbox"
        ]
    );
    std::env::remove_var("KORDI_CLOUD_SANDBOX_BACKEND");
}

#[test]
fn scheduled_reminder_prompts_are_rendered_as_reminder_text() {
    assert_eq!(
        scheduled_reminder_response_text("Remind 111 and 222: dinner time for us.").as_deref(),
        Some("Dinner time for us.")
    );
    assert_eq!(
        scheduled_reminder_response_text("Remind the user to have dinner.").as_deref(),
        Some("Have dinner.")
    );
    assert_eq!(
        scheduled_reminder_response_text("Search OpenAI news and summarize it."),
        None
    );
}

#[tokio::test]
async fn scheduled_reminder_runs_complete_without_model_or_provider_auth() {
    let client = FakeClient::with_run(CloudAgentRun {
        prompt: "Remind 111 and 222: dinner time for us.".to_string(),
        provider_auth_available: false,
        sandbox_id: None,
        ..leased_run("car_reminder", false)
    });
    let provider = FakeModelProvider {
        response: ModelProviderResponse::FinalText("wrong model answer".to_string()),
    };

    let outcome = process_one_run_with_provider(&client, &provider, temp_sandbox())
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "car_reminder".to_string()
        }
    );
    assert_eq!(
        client.calls(),
        vec![
            "lease",
            "running:car_reminder",
            "complete:car_reminder:Dinner time for us.",
        ]
    );
}

#[tokio::test]
async fn uses_model_loop_text_instead_of_placeholder() {
    let client = FakeClient::with_run(leased_run("car_1", true));
    let provider = FakeModelProvider {
        response: ModelProviderResponse::FinalText("real model answer".to_string()),
    };

    let outcome = process_one_run_with_provider(&client, &provider, temp_sandbox())
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "car_1".to_string()
        }
    );
    assert_eq!(
        client.calls(),
        vec![
            "lease",
            "running:car_1",
            "provider-auth:car_1",
            "complete:car_1:real model answer",
        ]
    );
}

#[tokio::test]
async fn marks_failed_when_provider_auth_fetch_fails() {
    let mut client = FakeClient::with_run(leased_run("car_fetch_fail", true));
    client.fail_provider_auth_fetch = true;
    let provider = FakeModelProvider {
        response: ModelProviderResponse::FinalText("unused".to_string()),
    };

    let outcome = process_one_run_with_provider(&client, &provider, temp_sandbox())
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunnerStepOutcome::FailedProviderError {
            run_id: "car_fetch_fail".to_string()
        }
    );
    assert_eq!(
        client.calls(),
        vec![
            "lease",
            "running:car_fetch_fail",
            "provider-auth:car_fetch_fail",
            "fail:car_fetch_fail:model_provider_error",
        ]
    );
}

#[tokio::test]
async fn marks_failed_when_provider_auth_is_missing() {
    let client = FakeClient::with_run(leased_run("car_missing", false));

    let outcome = process_one_run(&client).await.unwrap();

    assert_eq!(
        outcome,
        RunnerStepOutcome::FailedMissingProviderAuth {
            run_id: "car_missing".to_string()
        }
    );
    assert_eq!(
        client.calls(),
        vec!["lease", "fail:car_missing:missing_provider_auth"]
    );
}

fn temp_sandbox() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "kordi-runtime-model-loop-test-{}",
        uuid::Uuid::new_v4().simple()
    ))
}

#[tokio::test]
async fn does_not_process_cancelled_runs() {
    let client = FakeClient::with_run(CloudAgentRun {
        status: "cancelled".to_string(),
        ..leased_run("car_cancelled", true)
    });

    let outcome = process_one_run(&client).await.unwrap();

    assert_eq!(
        outcome,
        RunnerStepOutcome::SkippedCancelled {
            run_id: "car_cancelled".to_string()
        }
    );
    assert_eq!(client.calls(), vec!["lease"]);
}

#[tokio::test]
async fn reports_no_run_when_queue_is_empty() {
    let client = FakeClient::default();

    let outcome = process_one_run(&client).await.unwrap();
    assert_eq!(outcome, RunnerStepOutcome::NoRun);
    assert_eq!(client.calls(), vec!["lease"]);
}

#[tokio::test]
async fn digest_observes_simulated_chat_without_creating_a_sandbox() {
    struct DigestProvider;
    #[async_trait]
    impl CloudModelProvider for DigestProvider {
        async fn next_response(
            &self,
            _: &OpenAiProviderConfig,
            messages: &[Value],
            tools: &[Value],
        ) -> Result<ModelProviderResponse, ModelLoopError> {
            assert_eq!(tools.len(), 2);
            assert_eq!(tools[1]["function"]["name"], "read_session");
            if messages.last().unwrap()["role"] == "tool" {
                let observed: Value =
                    serde_json::from_str(messages.last().unwrap()["content"].as_str().unwrap())
                        .unwrap();
                assert_eq!(observed["sources"][0]["text"], "Review the draft tomorrow.");
                return Ok(ModelProviderResponse::FinalText("digest fixture".into()));
            }
            Ok(ModelProviderResponse::ToolCalls(vec![
                crate::model_loop::ModelToolCall {
                    id: "read".into(),
                    name: "read_session".into(),
                    arguments: serde_json::json!({"sessionId":"planning"}),
                },
            ]))
        }
    }
    let client = FakeClient::with_run(CloudAgentRun {
        prompt: serde_json::json!({"sources":[{"id":"m1","sessionId":"planning","text":"Review the draft tomorrow."}]}).to_string(),
        sandbox_id: None,
        ..leased_run("digest_fixture", true)
    });
    let root = temp_sandbox();
    let outcome = process_one_run_with_provider(&client, &DigestProvider, root.clone())
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "digest_fixture".into()
        }
    );
    assert!(!root.exists());
    assert_eq!(
        client.calls(),
        vec![
            "lease",
            "running:digest_fixture",
            "provider-auth:digest_fixture",
            "complete:digest_fixture:digest fixture"
        ]
    );
}
