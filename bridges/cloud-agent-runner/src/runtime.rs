#[cfg(test)]
use crate::client::CloudAgentRun;
use crate::client::{CloudAgentRunClient, RunnerClientError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerStepOutcome {
    NoRun,
    Completed { run_id: String },
    FailedMissingProviderAuth { run_id: String },
    SkippedCancelled { run_id: String },
}

pub async fn process_one_run<C: CloudAgentRunClient + Sync>(
    client: &C,
) -> Result<RunnerStepOutcome, RunnerClientError> {
    let Some(run) = client.lease_next_run().await? else {
        return Ok(RunnerStepOutcome::NoRun);
    };

    if run.status == "cancelled" {
        return Ok(RunnerStepOutcome::SkippedCancelled { run_id: run.run_id });
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
    client
        .complete_run(
            &run.run_id,
            "Cloud agent runner skeleton completed this fallback run.",
        )
        .await?;
    Ok(RunnerStepOutcome::Completed { run_id: run.run_id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct FakeClient {
        run: Arc<Mutex<Option<CloudAgentRun>>>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl FakeClient {
        fn with_run(run: CloudAgentRun) -> Self {
            Self {
                run: Arc::new(Mutex::new(Some(run))),
                calls: Arc::new(Mutex::new(Vec::new())),
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
            _response_text: &str,
        ) -> Result<(), RunnerClientError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("complete:{run_id}"));
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
            owner_account_id: "acct_owner".to_string(),
            requester_account_id: "acct_requester".to_string(),
            session_id: "session:direct-person:a:b".to_string(),
            sandbox_id: Some("cas_test".to_string()),
            provider_auth_available,
        }
    }

    #[tokio::test]
    async fn leases_marks_running_and_completes_one_run() {
        let client = FakeClient::with_run(leased_run("car_1", true));

        let outcome = process_one_run(&client).await.unwrap();

        assert_eq!(
            outcome,
            RunnerStepOutcome::Completed {
                run_id: "car_1".to_string()
            }
        );
        assert_eq!(
            client.calls(),
            vec!["lease", "running:car_1", "complete:car_1"]
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
