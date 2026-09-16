//! Pip: the plan agent built into every group conversation.
//!
//! Pip is a system-managed account that runs on a Kordi-operated provider
//! credential, sweeps the conversations it belongs to, and keeps one plan
//! card per conversation honest through the `plan_card` tool. It posts as an
//! ordinary member; it never touches anyone's personal calendar.

mod agent;
mod config;
pub mod membership;
mod prompt;
pub mod store;
mod worker;

pub use agent::bootstrap_pip_agent;
pub use config::{PendingPipConfig, PipConfig, PipConfigError, PipProviderAuth};
pub use store::RUN_PREFIX;
pub use worker::spawn;

#[derive(Clone)]
pub struct PipService {
    config: PipConfig,
}

impl PipService {
    pub fn new(config: PipConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &PipConfig {
        &self.config
    }
}
