//! Grounding card builds: the server's redaction and instructions, the
//! runner's Common ground completion on the same service credential, and the
//! server's reply parsing. No database is involved.

use chrono::{DateTime, Duration, Utc};
use kordi_cloud_agent_runner::client::CloudAgentRun;
use kordi_cloud_agent_runner::common_ground::generate;
use kordi_cloud_agent_runner::model_loop::OpenAiCompatibleProvider;
use kordi_cloud_server::common_ground::quality::{CardBuild, CardTopics, EvidenceItem};
use kordi_cloud_server::system_agent::SystemAgentConfig;
use serde::Serialize;
use serde_json::json;

use crate::client::EvalClient;
use crate::fixture::CardBuildFixture;
use crate::replay::{provider_material, timed, Engine, UsageRecord};
use crate::stub::StubProvider;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageRecord>,
    /// The reply as the model wrote it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Why the server would reject the reply (`invalid_output`, `no_topics`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topics: Option<Topics>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Topics {
    pub working_on: Vec<String>,
    pub interests: Vec<String>,
    pub can_help: Vec<String>,
    pub looking_for: Vec<String>,
    pub earlier: Vec<String>,
    /// Current topics that cite no evidence.
    pub uncited: Vec<String>,
}

impl Topics {
    pub fn current(&self) -> impl Iterator<Item = &String> {
        self.working_on
            .iter()
            .chain(&self.interests)
            .chain(&self.can_help)
            .chain(&self.looking_for)
    }
}

impl From<CardTopics> for Topics {
    fn from(topics: CardTopics) -> Self {
        let mut out = Topics {
            working_on: topics.working_on,
            interests: topics.interests,
            can_help: topics.can_help,
            looking_for: topics.looking_for,
            earlier: topics.earlier,
            uncited: Vec::new(),
        };
        out.uncited = out
            .current()
            .filter(|label| topics.refs.get(*label).is_none_or(Vec::is_empty))
            .cloned()
            .collect();
        out
    }
}

pub async fn build(
    config: &SystemAgentConfig,
    engine: Engine,
    fixture: &CardBuildFixture,
    now: DateTime<Utc>,
) -> anyhow::Result<BuildOutcome> {
    let evidence: Vec<EvidenceItem> = fixture
        .evidence
        .iter()
        .map(|item| EvidenceItem {
            source: item.source.clone(),
            title: item.title.clone(),
            date: Some(
                (now - Duration::days(item.days_ago))
                    .date_naive()
                    .to_string(),
            ),
            text: item.text.clone(),
        })
        .collect();
    let profile = &fixture.profile;
    let card = CardBuild::new(
        &profile.kind,
        &profile.name,
        profile.focus.as_deref(),
        &now.date_naive().to_string(),
        &evidence,
    );
    let run: CloudAgentRun = serde_json::from_value(json!({
        "runId": format!("{}eval_{}", kordi_cloud_server::common_ground::RUN_PREFIX,
            uuid::Uuid::new_v4().simple()),
        "status": "leased", "prompt": card.user_prompt, "systemPrompt": card.system_prompt,
        "ownerAccountId": config.account_id, "requesterAccountId": config.account_id,
        "sessionId": "grounding-quality-test", "sandboxId": null,
        "runtimeRoute": config.model_routing(), "providerAuthAvailable": true,
    }))?;
    let client = EvalClient::new(
        None,
        "system-agent-eval",
        provider_material(config, engine).await?,
    );
    let stub = StubProvider::new(
        fixture
            .stub
            .iter()
            .map(|text| json!({"final": text}))
            .collect(),
        Default::default(),
    );
    let live = OpenAiCompatibleProvider::default();
    let runner_engine = engine.runner_engine();
    let (result, latency, usage) = timed(async {
        if engine == Engine::Stub {
            generate(&client, &stub, runner_engine, &run).await
        } else {
            generate(&client, &live, runner_engine, &run).await
        }
    })
    .await;
    let mut outcome = BuildOutcome {
        latency_ms: latency,
        usage: (engine != Engine::Stub).then(|| usage.into()),
        ..BuildOutcome::default()
    };
    match result {
        Ok(text) => {
            match card.parse(&text) {
                Ok(topics) => outcome.topics = Some(topics.into()),
                Err(code) => outcome.rejected = Some(code.to_string()),
            }
            outcome.output = Some(text);
        }
        Err(error) => outcome.error = Some(error.chars().take(300).collect()),
    }
    Ok(outcome)
}
