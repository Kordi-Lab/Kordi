//! Settings from the environment and the suite run. The disposable database
//! lives in `crate::database`.
//!
//! The provider is configured exactly like a deployment's System agent
//! (`KORDI_SYSTEM_AGENT_PROVIDER`, `KORDI_SYSTEM_AGENT_OPENAI_*`,
//! `KORDI_SYSTEM_AGENT_VERTEX_MODEL`, `KORDI_SERVICE_*`), and the engine like
//! the runner (`KORDI_CLOUD_AGENT_ENGINE`). Nothing is read from files.

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::system_agent::{
    bootstrap_system_agent, PendingSystemAgentConfig, SystemAgentConfig, SystemAgentService,
};
use kordi_cloud_server::ServerState;
use sqlx_postgres::PgPool;

use crate::fixture::Fixture;
use crate::replay::{self, Engine, Harness};
use crate::report::{summarize, FixtureResult, PassResult, Prices, ProviderInfo, RunReport};
use crate::score::{score_build, score_turn};

pub use crate::database::DATABASE_URL_VAR;
const INPUT_PRICE_VAR: &str = "KORDI_SYSTEM_AGENT_EVAL_INPUT_USD_PER_MTOK";
const OUTPUT_PRICE_VAR: &str = "KORDI_SYSTEM_AGENT_EVAL_OUTPUT_USD_PER_MTOK";
/// A fallback would mix two models into one result.
const FALLBACK_VARS: [&str; 2] = [
    "KORDI_SYSTEM_AGENT_FALLBACK_API_KEY",
    "KORDI_PIP_FALLBACK_API_KEY",
];

pub struct Settings {
    pub engine: Engine,
    pub pending: PendingSystemAgentConfig,
    pub prices: Option<Prices>,
}

/// The configuration a stub run uses: synthetic, and the production prompt.
pub fn stub_settings() -> Settings {
    let pending = PendingSystemAgentConfig::from_lookup(|key| {
        let value = match key {
            "KORDI_SYSTEM_AGENT_OPENAI_API_KEY" => "stub-key",
            "KORDI_SYSTEM_AGENT_OPENAI_MODEL" => "stub-model",
            "KORDI_SYSTEM_AGENT_OPENAI_BASE_URL" => "https://model.example.test/v1",
            "KORDI_SYSTEM_AGENT_OWNER_EMAIL" => "system-agent@example.test",
            "KORDI_SYSTEM_AGENT_AGENT_NAME" => "System",
            "KORDI_SYSTEM_AGENT_AGENT_SUBTITLE" => "Keeps plans in this chat honest",
            "KORDI_SYSTEM_AGENT_PERSONA" => {
                "You are System, the plan agent in this group chat. You are brief and practical."
            }
            _ => return None,
        };
        Some(value.to_string())
    })
    .expect("synthetic stub configuration")
    .expect("stub configuration is enabled");
    Settings {
        engine: Engine::Stub,
        pending,
        prices: None,
    }
}

pub fn live_settings() -> Result<Settings> {
    for name in FALLBACK_VARS {
        if std::env::var(name).is_ok_and(|value| !value.trim().is_empty()) {
            bail!("unset {name}: a provider fallback would mix two models into one result");
        }
    }
    let pending = PendingSystemAgentConfig::from_env()
        .map_err(|error| anyhow::anyhow!("System agent provider settings: {error}"))?
        .context(
            "no System agent provider is configured (see docs/testing/system-agent-quality.md)",
        )?;
    let engine = match kordi_cloud_agent_runner::runtime::cloud_model_engine_from_env()
        .map_err(|error| anyhow::anyhow!("{error}"))?
    {
        kordi_cloud_agent_runner::runtime::CloudModelEngine::Omp => Engine::Omp,
        kordi_cloud_agent_runner::runtime::CloudModelEngine::Rust => Engine::Rust,
    };
    let price = |name: &str| -> Result<Option<f64>> {
        std::env::var(name)
            .ok()
            .map(|value| {
                value
                    .trim()
                    .parse::<f64>()
                    .with_context(|| format!("{name} must be a number"))
            })
            .transpose()
    };
    let prices = match (price(INPUT_PRICE_VAR)?, price(OUTPUT_PRICE_VAR)?) {
        (Some(input), Some(output)) => Some(Prices {
            input_per_million: input,
            output_per_million: output,
        }),
        (None, None) => None,
        _ => bail!("set both {INPUT_PRICE_VAR} and {OUTPUT_PRICE_VAR}, or neither"),
    };
    Ok(Settings {
        engine,
        pending,
        prices,
    })
}

/// The host of a provider URL, or "unknown"; reports keep nothing else of it.
pub fn host(url: &str) -> String {
    url.split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .split(['/', '?', '#'])
        .next()
        .map(|authority| authority.rsplit('@').next().unwrap_or(authority))
        .map(|host| {
            if let Some(v6) = host.strip_prefix('[') {
                format!("[{}]", v6.split(']').next().unwrap_or(""))
            } else {
                host.split(':').next().unwrap_or("").to_string()
            }
        })
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

pub async fn harness(
    pool: PgPool,
    pending: PendingSystemAgentConfig,
    engine: Engine,
) -> Result<Harness> {
    let config = bootstrap_system_agent(&pool, pending)
        .await
        .map_err(|error| anyhow::anyhow!("provisioning the System agent: {error}"))?;
    let state = Arc::new(
        ServerState::new(pool.clone(), EventBus::noop())
            .with_system_agent(SystemAgentService::new(config.clone())),
    );
    Ok(Harness {
        pool,
        state,
        config,
        engine,
    })
}

fn provider_info(config: &SystemAgentConfig, engine: Engine) -> ProviderInfo {
    let auth = config.provider_auth();
    ProviderInfo {
        provider: auth.provider().to_string(),
        model: auth.model().to_string(),
        engine: engine.name().to_string(),
        endpoint_host: host(auth.base_url()),
    }
}

/// Replays `fixtures` and scores them. System agent fixtures need `harness`;
/// Grounding builds run on `config` alone.
pub async fn run_suite(
    label: &str,
    fixtures: &[Fixture],
    config: &SystemAgentConfig,
    harness: Option<&Harness>,
    engine: Engine,
    prices: Option<Prices>,
    now: DateTime<Utc>,
) -> Result<RunReport> {
    let mut results = Vec::new();
    for fixture in fixtures {
        let passes = match fixture {
            Fixture::SystemAgent(conversation) => {
                let harness = harness
                    .with_context(|| format!("{} needs {DATABASE_URL_VAR}", conversation.id))?;
                let (seeded, outcomes) = replay::conversation(harness, conversation)
                    .await
                    .with_context(|| format!("replaying {}", conversation.id))?;
                conversation
                    .turns
                    .iter()
                    .zip(outcomes)
                    .map(|(turn, outcome)| PassResult {
                        ran: outcome.ran,
                        latency_ms: outcome.latency_ms,
                        usage: outcome.usage,
                        checks: score_turn(
                            &turn.expect,
                            &outcome,
                            seeded.seeded_event_id.as_deref(),
                        ),
                        outcome: serde_json::to_value(&outcome).unwrap_or_default(),
                    })
                    .collect::<Vec<_>>()
            }
            Fixture::Grounding(build) => {
                let outcome = crate::grounding::build(config, engine, build, now)
                    .await
                    .with_context(|| format!("building {}", build.id))?;
                vec![PassResult {
                    ran: true,
                    latency_ms: Some(outcome.latency_ms),
                    usage: outcome.usage,
                    checks: score_build(&build.expect, &outcome),
                    outcome: serde_json::to_value(&outcome).unwrap_or_default(),
                }]
            }
        };
        let passed = passes
            .iter()
            .all(|pass| pass.checks.iter().all(|c| c.passed));
        eprintln!("{} {}", if passed { "pass" } else { "FAIL" }, fixture.id());
        results.push(FixtureResult {
            id: fixture.id().to_string(),
            kind: fixture.kind().to_string(),
            passed,
            passes,
        });
    }
    let summary = summarize(&results, prices);
    Ok(RunReport {
        schema_version: crate::report::SCHEMA_VERSION,
        label: label.to_string(),
        started_at: now.to_rfc3339(),
        provider: provider_info(config, engine),
        prices,
        fixtures: results,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_cloud_agent_runner::client::AgentRuntimeRoute;
    use kordi_cloud_agent_runner::model_loop::OpenAiProviderConfig;

    fn openai_compatible(model: &str) -> PendingSystemAgentConfig {
        let model = model.to_string();
        PendingSystemAgentConfig::from_lookup(move |key| {
            let value = match key {
                "KORDI_SYSTEM_AGENT_PROVIDER" => "openai-compatible",
                "KORDI_SYSTEM_AGENT_OPENAI_API_KEY" => "synthetic-gateway-key",
                "KORDI_SYSTEM_AGENT_OPENAI_BASE_URL" => "https://openrouter.ai/api/v1",
                "KORDI_SYSTEM_AGENT_OPENAI_MODEL" => model.as_str(),
                "KORDI_SYSTEM_AGENT_PERSONA" => "Synthetic persona.",
                _ => return None,
            };
            Some(value.to_string())
        })
        .unwrap()
        .unwrap()
    }

    /// What the runner would send for an OpenAI-compatible gateway, through
    /// the same material and route a live run uses.
    async fn runner_config(model: &str) -> (SystemAgentConfig, OpenAiProviderConfig) {
        let config = openai_compatible(model).unprovisioned();
        let material = crate::replay::provider_material(&config, Engine::Rust)
            .await
            .unwrap();
        let mut runner = OpenAiProviderConfig::from_material(&material).unwrap();
        let route: AgentRuntimeRoute = serde_json::from_value(config.model_routing()).unwrap();
        runner
            .apply_runtime_route(&route, &material.provider)
            .unwrap();
        (config, runner)
    }

    #[tokio::test]
    async fn openai_compatible_gateways_reach_the_runner_unchanged() {
        let (config, runner) = runner_config("anthropic/claude-sonnet-4.5").await;
        assert_eq!(runner.base_url, "https://openrouter.ai/api/v1");
        assert_eq!(runner.model, "anthropic/claude-sonnet-4.5");
        assert_eq!(runner.api_key, "synthetic-gateway-key");
        let info = provider_info(&config, Engine::Rust);
        assert_eq!(info.endpoint_host, "openrouter.ai");
        assert_eq!(info.model, "anthropic/claude-sonnet-4.5");
    }

    /// The System agent route drops an `openai/` prefix, as it does in
    /// production; the documentation tells gateway users about it.
    #[tokio::test]
    async fn the_route_drops_an_openai_prefix() {
        let (_, runner) = runner_config("openai/gpt-5.1").await;
        assert_eq!(runner.model, "gpt-5.1");
    }

    #[test]
    fn provider_hosts_keep_nothing_but_the_host() {
        assert_eq!(
            host("https://user:pw@openrouter.ai/api/v1?key=x"),
            "openrouter.ai"
        );
        assert_eq!(host("https://[::1]:8443/v1"), "[::1]");
        assert_eq!(host(""), "unknown");
    }
}
