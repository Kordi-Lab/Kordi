use std::path::PathBuf;

use crate::client::{CloudAgentRun, CloudAgentRunClient, RunnerClientError};
use crate::k8s_sandbox::K8sSandboxBackend;
use crate::model_loop::{run_model_loop, CloudModelProvider, OpenAiCompatibleProvider};
use crate::sandbox_client::{LocalSandboxBackend, SandboxBackendHandle};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerStepOutcome {
    NoRun,
    Completed { run_id: String },
    FailedMissingProviderAuth { run_id: String },
    FailedProviderError { run_id: String },
    FailedMissingSandbox { run_id: String },
    SkippedCancelled { run_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxBackendMode {
    Local,
    K8s,
}

pub fn sandbox_backend_mode_from_env() -> SandboxBackendMode {
    match std::env::var("KORDI_CLOUD_SANDBOX_BACKEND") {
        Ok(value) if value.trim().eq_ignore_ascii_case("k8s") => SandboxBackendMode::K8s,
        _ => SandboxBackendMode::Local,
    }
}

fn sentence_case_first(text: &str) -> String {
    let trimmed = text.trim();
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    first.to_uppercase().collect::<String>() + chars.as_str()
}

fn ensure_terminal_punctuation(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.ends_with('.') || trimmed.ends_with('!') || trimmed.ends_with('?') {
        trimmed.to_string()
    } else {
        format!("{trimmed}.")
    }
}

fn scheduled_reminder_response_text(prompt: &str) -> Option<String> {
    let trimmed = prompt.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("remind ") {
        return None;
    }

    let reminder = if let Some((_, message)) = trimmed.split_once(':') {
        message.trim()
    } else {
        lower
            .strip_prefix("remind the user to ")
            .and_then(|_| trimmed.get("Remind the user to ".len()..))
            .or_else(|| {
                lower
                    .strip_prefix("remind me to ")
                    .and_then(|_| trimmed.get("Remind me to ".len()..))
            })
            .or_else(|| {
                lower
                    .strip_prefix("remind us to ")
                    .and_then(|_| trimmed.get("Remind us to ".len()..))
            })
            .unwrap_or("")
            .trim()
    };
    if reminder.is_empty() {
        return None;
    }
    Some(ensure_terminal_punctuation(&sentence_case_first(reminder)))
}

pub fn sandbox_backend_for_run(
    run: &CloudAgentRun,
    local_root: PathBuf,
) -> Result<SandboxBackendHandle, &'static str> {
    match sandbox_backend_mode_from_env() {
        SandboxBackendMode::Local => Ok(std::sync::Arc::new(LocalSandboxBackend::new(local_root))),
        SandboxBackendMode::K8s => {
            let sandbox_id = run.sandbox_id.as_deref().ok_or("missing_sandbox")?;
            Ok(std::sync::Arc::new(K8sSandboxBackend::from_env(
                sandbox_id.to_string(),
            )))
        }
    }
}

pub async fn process_one_run<C: CloudAgentRunClient + Sync>(
    client: &C,
) -> Result<RunnerStepOutcome, RunnerClientError> {
    let provider = OpenAiCompatibleProvider::default();
    let sandbox_root = std::env::var("KORDI_CLOUD_SANDBOX_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("kordi-cloud-runner-sandbox"));
    process_one_run_with_provider(client, &provider, sandbox_root).await
}

pub async fn process_one_run_with_provider<C, P>(
    client: &C,
    provider: &P,
    sandbox_root: PathBuf,
) -> Result<RunnerStepOutcome, RunnerClientError>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    let Some(run) = client.lease_next_run().await? else {
        return Ok(RunnerStepOutcome::NoRun);
    };

    if run.status == "cancelled" {
        return Ok(RunnerStepOutcome::SkippedCancelled { run_id: run.run_id });
    }

    if let Some(response_text) = scheduled_reminder_response_text(&run.prompt) {
        client.mark_running(&run.run_id).await?;
        client.complete_run(&run.run_id, &response_text).await?;
        return Ok(RunnerStepOutcome::Completed { run_id: run.run_id });
    }

    if !run.provider_auth_available {
        client
            .fail_run(
                &run.run_id,
                "missing_provider_auth",
                "Cloud fallback cannot run because the owner has not enabled a provider-auth snapshot.",
            )
            .await?;
        return Ok(RunnerStepOutcome::FailedMissingProviderAuth { run_id: run.run_id });
    }

    client.mark_running(&run.run_id).await?;
    let sandbox = match sandbox_backend_for_run(&run, sandbox_root) {
        Ok(sandbox) => sandbox,
        Err("missing_sandbox") => {
            client
                .fail_run(
                    &run.run_id,
                    "missing_sandbox",
                    "Cloud fallback cannot run because this leased run has no sandbox id.",
                )
                .await?;
            return Ok(RunnerStepOutcome::FailedMissingSandbox { run_id: run.run_id });
        }
        Err(err) => {
            client
                .fail_run(
                    &run.run_id,
                    "sandbox_backend_error",
                    &format!("Cloud fallback sandbox backend could not be selected: {err}"),
                )
                .await?;
            return Ok(RunnerStepOutcome::FailedProviderError { run_id: run.run_id });
        }
    };
    let auth_material = match client.fetch_provider_auth(&run.run_id).await {
        Ok(auth_material) => auth_material,
        Err(err) => {
            client
                .fail_run(
                    &run.run_id,
                    "model_provider_error",
                    &format!("Cloud fallback could not load provider auth for this run: {err}"),
                )
                .await?;
            return Ok(RunnerStepOutcome::FailedProviderError { run_id: run.run_id });
        }
    };
    let response_text = match run_model_loop(client, provider, &run, &sandbox, auth_material).await
    {
        Ok(response_text) => response_text,
        Err(err) => {
            client
                .fail_run(
                    &run.run_id,
                    "model_provider_error",
                    &format!("Cloud fallback model loop failed: {err}"),
                )
                .await?;
            return Ok(RunnerStepOutcome::FailedProviderError { run_id: run.run_id });
        }
    };
    client.complete_run(&run.run_id, &response_text).await?;
    Ok(RunnerStepOutcome::Completed { run_id: run.run_id })
}

#[cfg(test)]
mod tests {
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
}
