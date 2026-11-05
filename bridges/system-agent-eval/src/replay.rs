//! Replays fixtures through the production path: the server's sweep builds
//! the run input and queues the run, the runner's System agent loop calls the
//! model and the plan_card tool, and the server's completion posts the reply.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use kordi_cloud_agent_runner::client::{CloudAgentRun, ProviderAuthMaterial};
use kordi_cloud_agent_runner::model_loop::{ModelLoopError, OpenAiCompatibleProvider};
use kordi_cloud_agent_runner::runtime::CloudModelEngine;
use kordi_cloud_agent_runner::usage_meter::{measure, Usage, UsageMeter};
use kordi_cloud_server::plan_cards::models::PlanCardRsvp;
use kordi_cloud_server::system_agent::{store, SystemAgentConfig};
use kordi_cloud_server::ServerState;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::client::{EvalClient, ToolCall};
use crate::fixture::Conversation;
use crate::seed::{self, Seeded};
use crate::stub::StubProvider;

/// Longest a single replayed run may take before it counts as failed.
const RUN_TIMEOUT: Duration = Duration::from_secs(300);
const RUNNER_ID: &str = "system-agent-eval";

/// Which model answers: the scripted stub, or the configured provider through
/// one of the runner's engines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Stub,
    Rust,
    Omp,
}

impl Engine {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stub => "stub",
            Self::Rust => "rust",
            Self::Omp => "omp",
        }
    }

    pub fn runner_engine(self) -> CloudModelEngine {
        match self {
            Self::Omp => CloudModelEngine::Omp,
            Self::Stub | Self::Rust => CloudModelEngine::Rust,
        }
    }
}

/// The card as the turn left it, with members named by fixture key.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardSnapshot {
    pub event_id: String,
    pub revision: i64,
    pub state: String,
    pub title: String,
    pub start_at: Option<String>,
    pub location: Option<String>,
    pub option_count: usize,
    pub going: Vec<String>,
    pub declined: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnOutcome {
    /// False when the sweep's free check decided no model call was needed.
    pub ran: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageRecord>,
    pub tool_calls: Vec<ToolCall>,
    /// Text the System agent posted in this pass.
    pub messages: Vec<String>,
    /// Card-only messages it posted.
    pub card_messages: usize,
    /// Text the System agent had posted before this pass.
    #[serde(skip)]
    pub earlier_messages: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_before: Option<CardSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<CardSnapshot>,
    /// The run's final envelope, as the runner returned it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub model_calls: u64,
    pub reported_calls: u64,
}

impl From<Usage> for UsageRecord {
    fn from(usage: Usage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            model_calls: usage.calls,
            reported_calls: usage.reported_calls,
        }
    }
}

/// Everything a replay needs: the database, the server state the plan_card
/// handler reads, and the configured System agent.
pub struct Harness {
    pub pool: PgPool,
    pub state: Arc<ServerState>,
    pub config: SystemAgentConfig,
    pub engine: Engine,
}

impl Harness {
    /// Provider material exactly as the server hands it to a runner.
    pub async fn material(&self) -> Result<ProviderAuthMaterial> {
        provider_material(&self.config, self.engine).await
    }
}

pub async fn provider_material(
    config: &SystemAgentConfig,
    engine: Engine,
) -> Result<ProviderAuthMaterial> {
    let auth = config.provider_auth();
    let payload = if engine == Engine::Stub {
        json!({"apiKey": "stub-key", "baseUrl": auth.base_url(), "model": auth.model(), "verbatimModel": true})
    } else {
        auth.runner_payload()
            .await
            .map_err(|error| anyhow::anyhow!("provider credential: {error}"))?
    };
    Ok(ProviderAuthMaterial {
        snapshot_id: auth.snapshot_id().to_string(),
        provider: auth.provider().to_string(),
        auth_choice: auth.auth_choice().to_string(),
        payload,
    })
}

/// Runs one System agent or Grounding run under a usage meter and timeout.
pub async fn timed<F>(future: F) -> (Result<String, String>, u64, Usage)
where
    F: std::future::Future<Output = Result<String, String>>,
{
    let meter = Arc::new(UsageMeter::default());
    let start = Instant::now();
    let result = tokio::time::timeout(RUN_TIMEOUT, measure(meter.clone(), future))
        .await
        .unwrap_or_else(|_| Err("timed out".to_string()));
    let latency = start.elapsed().as_millis() as u64;
    (result, latency, meter.snapshot())
}

/// Provider errors can echo request headers or keys; reports keep a masked,
/// shortened copy.
fn short(error: &ModelLoopError) -> String {
    crate::redact::provider_error(&error.to_string())
}

pub async fn card_snapshot(pool: &PgPool, seeded: &Seeded) -> Result<Option<CardSnapshot>> {
    let Some(event_id) = seed::latest_card(pool, seeded.conversation_id).await? else {
        return Ok(None);
    };
    let Some(row) = kordi_cloud_server::plan_cards::store::load(pool, &event_id).await? else {
        return Ok(None);
    };
    let named = |rsvp: PlanCardRsvp| {
        row.participants
            .iter()
            .filter(|participant| participant.rsvp == rsvp)
            .filter_map(|participant| seeded.key_of(&participant.account_id))
            .map(str::to_string)
            .collect()
    };
    Ok(Some(CardSnapshot {
        event_id: row.event_id.clone(),
        revision: row.revision,
        state: row.state.as_db_str().to_string(),
        title: row.title.clone(),
        start_at: row.start_at.clone(),
        location: row.location.clone(),
        option_count: row.options.len(),
        going: named(PlanCardRsvp::Yes),
        declined: named(PlanCardRsvp::No),
    }))
}

/// Replays every turn of one conversation; the seeded data stays in the
/// database for inspection, with the System agent no longer a member.
pub async fn conversation(
    harness: &Harness,
    fixture: &Conversation,
) -> Result<(Seeded, Vec<TurnOutcome>)> {
    let pool = &harness.pool;
    let seeded = seed::conversation(pool, &harness.config.account_id, fixture).await?;
    let mut outcomes = Vec::new();
    for turn in &fixture.turns {
        let before = seed::latest_sequence(pool, seeded.conversation_id).await?;
        let (earlier_messages, _) = seed::system_messages(pool, &seeded, 0).await?;
        for message in &turn.messages {
            seed::post(pool, &seeded, message).await?;
        }
        for action in &turn.card_actions {
            seed::card_action(pool, &seeded, action).await?;
        }
        // The card as the System agent finds it, after members acted on it.
        let card_before = card_snapshot(pool, &seeded).await?;
        let mut outcome = run_turn(harness, &seeded, &turn.stub).await?;
        let (messages, card_messages) = seed::system_messages(pool, &seeded, before).await?;
        outcome.messages = messages;
        outcome.card_messages = card_messages;
        outcome.earlier_messages = earlier_messages;
        outcome.card_before = card_before;
        outcome.card = card_snapshot(pool, &seeded).await?;
        outcomes.push(outcome);
    }
    seed::retire(pool, &seeded).await?;
    Ok((seeded, outcomes))
}

async fn run_turn(harness: &Harness, seeded: &Seeded, stub: &[Value]) -> Result<TurnOutcome> {
    let pool = &harness.pool;
    // Make this conversation due first, as if its quiet period just ended.
    query(
        "UPDATE cloud_pip_conversation_state
         SET checked_at = now() - interval '10 years', retry_after = now() - interval '1 second',
             attempts = 0
         WHERE conversation_id = $1",
    )
    .bind(seeded.conversation_id)
    .execute(pool)
    .await?;
    store::sweep(pool, &harness.config).await.context("sweep")?;
    let active: Option<(Option<String>,)> = query_as(
        "SELECT active_run_id FROM cloud_pip_conversation_state WHERE conversation_id = $1",
    )
    .bind(seeded.conversation_id)
    .fetch_optional(pool)
    .await?;
    let Some(run_id) = active.and_then(|(run_id,)| run_id) else {
        return Ok(TurnOutcome::default());
    };
    let lease = (chrono::Utc::now() + chrono::Duration::minutes(15)).to_rfc3339();
    let (prompt, system_prompt, route, owner, session): (String, String, Value, String, String) =
        query_as(
            "UPDATE cloud_agent_fallback_runs
             SET status = 'leased', claimed_by = $2, lease_expires_at = $3, updated_at = $4
             WHERE run_id = $1
             RETURNING prompt, system_prompt, runtime_route_json, owner_account_id, session_id",
        )
        .bind(&run_id)
        .bind(RUNNER_ID)
        .bind(&lease)
        .bind(chrono::Utc::now().to_rfc3339())
        .fetch_one(pool)
        .await
        .context("claiming the queued run")?;
    let run: CloudAgentRun = serde_json::from_value(json!({
        "runId": run_id, "status": "leased", "prompt": prompt, "systemPrompt": system_prompt,
        "ownerAccountId": owner, "requesterAccountId": owner, "sessionId": session,
        "sandboxId": null, "runtimeRoute": route, "providerAuthAvailable": true,
    }))
    .context("run shape")?;
    let material = harness.material().await?;
    let client = EvalClient::new(Some(harness.state.clone()), RUNNER_ID, material.clone());
    let stub = StubProvider::new(stub.to_vec(), seeded.members.clone());
    let live = OpenAiCompatibleProvider::default();
    use kordi_cloud_agent_runner::system_agent::{run_legacy, run_omp};
    let (result, latency, usage) = timed(async {
        match harness.engine {
            Engine::Stub => run_legacy(&client, &stub, &run, material).await,
            Engine::Rust => run_legacy(&client, &live, &run, material).await,
            Engine::Omp => run_omp(&client, &run, material).await,
        }
        .map_err(|error| short(&error))
    })
    .await;
    let mut outcome = TurnOutcome {
        ran: true,
        latency_ms: Some(latency),
        usage: (harness.engine != Engine::Stub).then(|| usage.into()),
        tool_calls: client.calls(),
        ..TurnOutcome::default()
    };
    match result {
        Ok(text) => {
            store::complete(pool, &run_id, RUNNER_ID, &text).await?;
            outcome.output = Some(text);
        }
        Err(error) => {
            store::fail(pool, &run_id, Some(RUNNER_ID), "quality_test_failure").await?;
            outcome.error = Some(error);
        }
    }
    Ok(outcome)
}
