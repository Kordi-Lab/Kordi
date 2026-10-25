use super::tests::{leased_run, legacy_fixture_run, temp_sandbox, FakeClient};
use super::*;
use crate::memory::{RunMemory, RunnerMemory};
use crate::model_loop::{
    CloudModelProvider, ModelLoopError, ModelProviderResponse, OpenAiProviderConfig,
};
use async_trait::async_trait;
use serde_json::Value;

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

#[test]
fn the_memory_section_follows_the_run_scopes() {
    let run = evaluation_run("proactive_eval_memory");
    let memory = |scope: &str, scope_id: &str, text: &str| RunnerMemory {
        memory_id: format!("mem_{text}"),
        scope: scope.into(),
        scope_id: scope_id.into(),
        scope_label: None,
        source: "user".into(),
        text: text.into(),
        created_at: "2026-10-01T00:00:00Z".into(),
        updated_at: "2026-10-01T00:00:00Z".into(),
        owner_account_id: None,
        owner_name: None,
        ..RunnerMemory::default()
    };
    let loaded = RunMemory {
        enabled: true,
        exclude_sensitive: true,
        memories: vec![
            memory(
                "global",
                crate::memory::GLOBAL_SCOPE_ID,
                "Prefers short answers",
            ),
            memory("group", "grp_alpha", "This group ships on Fridays"),
            memory("group", "grp_other", "Unrelated group"),
        ],
    };
    let prompt = crate::proactive::system_prompt(&run, &loaded);
    assert!(prompt.starts_with("Evaluation rules\n\n## Memories"));
    assert!(prompt.contains("Prefers short answers"));
    assert!(prompt.contains("This group ships on Fridays"));
    assert!(!prompt.contains("Unrelated group"));
    assert!(prompt.ends_with("do not try to save new ones."));
    assert_eq!(
        crate::proactive::system_prompt(&run, &RunMemory::disabled()),
        "Evaluation rules"
    );
}
