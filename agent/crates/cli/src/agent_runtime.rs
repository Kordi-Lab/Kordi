//! One engine selection boundary for every local agent entry point.

use anyhow::{Result, bail};
use kordi_hooks::Event;
use tokio::sync::mpsc;

use crate::turn_runner::{self, TurnConfig, TurnEvent};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentTurnEngine {
    Omp,
    Rust,
}

impl AgentTurnEngine {
    fn from_setting(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "omp" => Ok(Self::Omp),
            "rust" => Ok(Self::Rust),
            _ => bail!("Invalid agent engine setting; expected omp or rust"),
        }
    }
}

fn selected_engine() -> Result<AgentTurnEngine> {
    // Keep the old development override usable, but apply it consistently to
    // desktop, CLI, and managed child turns, including release builds.
    let setting = std::env::var("KORDI_AGENT_ENGINE")
        .or_else(|_| std::env::var("KORDI_DESKTOP_TURN_ENGINE"))
        .unwrap_or_default();
    AgentTurnEngine::from_setting(&setting)
}

pub(crate) async fn run_turn(
    config: TurnConfig,
    event_tx: mpsc::UnboundedSender<TurnEvent>,
    prompt: String,
) -> (TurnConfig, Result<()>) {
    match selected_engine() {
        Ok(AgentTurnEngine::Omp) => crate::omp_turn::run_turn(config, event_tx, prompt).await,
        Ok(AgentTurnEngine::Rust) => turn_runner::run_turn(config, event_tx, prompt).await,
        Err(error) => {
            let _ = event_tx.send(TurnEvent::Error(error.to_string()));
            (config, Err(error))
        }
    }
}

#[allow(dead_code, reason = "print mode is compiled in the CLI binary")]
pub(crate) async fn run_print_turn(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    prompt: &str,
) -> Result<()> {
    let result = match selected_engine()? {
        AgentTurnEngine::Omp => {
            crate::omp_turn::run_turn_inner(config, event_tx, prompt.to_owned()).await
        }
        AgentTurnEngine::Rust => turn_runner::run_turn_inner(config, event_tx, prompt).await,
    };
    let _ = turn_runner::send_extension_event_safe(
        &config.extensions,
        Event::AgentEnd,
        event_tx,
        "AgentEnd",
    )
    .await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omp_is_default_and_legacy_rust_requires_an_explicit_selection() {
        assert_eq!(
            AgentTurnEngine::from_setting("").unwrap(),
            AgentTurnEngine::Omp
        );
        assert_eq!(
            AgentTurnEngine::from_setting(" OMP ").unwrap(),
            AgentTurnEngine::Omp
        );
        assert_eq!(
            AgentTurnEngine::from_setting("rust").unwrap(),
            AgentTurnEngine::Rust
        );
        assert!(AgentTurnEngine::from_setting("unknown").is_err());
    }
}
