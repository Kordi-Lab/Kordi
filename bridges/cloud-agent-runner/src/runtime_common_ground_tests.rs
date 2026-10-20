use super::tests::{leased_run, legacy_fixture_run, temp_sandbox, FakeClient};
use super::*;
use crate::model_loop::{
    CloudModelProvider, ModelLoopError, ModelProviderResponse, OpenAiProviderConfig,
};
use async_trait::async_trait;
use serde_json::Value;

struct CardProvider(&'static str);

#[async_trait]
impl CloudModelProvider for CardProvider {
    async fn next_response(
        &self,
        _: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        assert!(tools.is_empty(), "card builds get no tools");
        assert_eq!(messages[0]["content"], "Card instructions");
        assert_eq!(messages[1]["content"], "Evidence");
        Ok(ModelProviderResponse::FinalText(self.0.into()))
    }
}

fn card_run(run_id: &str) -> CloudAgentRun {
    CloudAgentRun {
        prompt: "Evidence".into(),
        system_prompt: "Card instructions".into(),
        sandbox_id: None,
        ..leased_run(run_id, true)
    }
}

#[tokio::test]
async fn common_ground_runs_complete_without_a_sandbox_or_tools() {
    let client = FakeClient::with_run(card_run("cg_card_fixture"));
    let root = temp_sandbox();
    let outcome = legacy_fixture_run(&client, &CardProvider("{\"working_on\":[]}"), root.clone())
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "cg_card_fixture".into()
        }
    );
    assert!(!root.exists());
    assert_eq!(
        client.calls(),
        vec![
            "lease",
            "running:cg_card_fixture",
            "provider-auth:cg_card_fixture",
            "complete:cg_card_fixture:{\"working_on\":[]}"
        ]
    );
}

#[tokio::test]
async fn an_empty_reply_fails_the_run() {
    let client = FakeClient::with_run(card_run("cg_card_empty"));
    let outcome = legacy_fixture_run(&client, &CardProvider("  "), temp_sandbox())
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::FailedProviderError {
            run_id: "cg_card_empty".into()
        }
    );
    assert!(client
        .calls()
        .contains(&"fail:cg_card_empty:common_ground_run_failed".to_string()));
}
