//! A Kordi Cloud run reports the model it called when it completes.
use super::*;

struct ModelRecordingClient {
    inner: FakeClient,
    models: Mutex<Vec<Option<String>>>,
}

#[async_trait]
impl CloudAgentRunClient for ModelRecordingClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        self.inner.lease_next_run().await
    }
    async fn mark_running(&self, run_id: &str) -> Result<(), RunnerClientError> {
        self.inner.mark_running(run_id).await
    }
    async fn complete_run(&self, run_id: &str, text: &str) -> Result<(), RunnerClientError> {
        self.inner.complete_run(run_id, text).await
    }
    async fn complete_run_with_model(
        &self,
        run_id: &str,
        text: &str,
        model: Option<&str>,
    ) -> Result<(), RunnerClientError> {
        self.models.lock().unwrap().push(model.map(str::to_string));
        self.inner.complete_run(run_id, text).await
    }
    async fn fail_run(
        &self,
        run_id: &str,
        code: &str,
        message: &str,
    ) -> Result<(), RunnerClientError> {
        self.inner.fail_run(run_id, code, message).await
    }
    async fn fetch_provider_auth(
        &self,
        run_id: &str,
    ) -> Result<crate::client::ProviderAuthMaterial, RunnerClientError> {
        self.inner.fetch_provider_auth(run_id).await
    }
    async fn export_artifact(
        &self,
        run_id: &str,
        input: crate::client::ArtifactExportInput,
    ) -> Result<crate::client::ArtifactExportResponse, RunnerClientError> {
        self.inner.export_artifact(run_id, input).await
    }
}

#[tokio::test]
async fn completed_runs_report_the_route_model_they_called() {
    let mut run = leased_run("car_model", true);
    run.runtime_route.default_model = Some("gpt-5.6-luna".to_string());
    let client = ModelRecordingClient {
        inner: FakeClient::with_run(run),
        models: Mutex::new(Vec::new()),
    };
    let provider = FakeModelProvider {
        response: ModelProviderResponse::FinalText("answer".to_string()),
    };
    let outcome = process_one_run_with_provider(&client, &provider, temp_sandbox())
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "car_model".to_string()
        }
    );
    assert_eq!(
        *client.models.lock().unwrap(),
        vec![Some("gpt-5.6-luna".to_string())]
    );
    assert!(client
        .inner
        .calls()
        .contains(&"complete:car_model:answer".to_string()));
}
