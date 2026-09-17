//! PiP: the plan agent built into every group conversation.
//!
//! PiP is a system-managed account that runs on a Kordi-operated provider
//! credential, sweeps the conversations it belongs to, and keeps one plan
//! card per conversation honest through the `plan_card` tool. It posts as an
//! ordinary member; it never touches anyone's personal calendar.

mod agent;
pub(crate) mod cards;
mod config;
pub(crate) mod context;
mod input;
pub mod membership;
mod mentions;
mod prompt;
mod retry;
pub mod store;
mod worker;

pub use agent::bootstrap_pip_agent;
pub use config::{PendingPipConfig, PipConfig, PipConfigError, PipProviderAuth};
pub use store::RUN_PREFIX;
pub use worker::spawn;

static SERVICE_ACCOUNT_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// PiP's account when it is running on this server, so other features (the
/// digest) can tell PiP's messages apart from members'.
pub fn service_account_id() -> Option<&'static str> {
    SERVICE_ACCOUNT_ID.get().map(String::as_str)
}

#[derive(Clone)]
pub struct PipService {
    config: PipConfig,
}

impl PipService {
    pub fn new(config: PipConfig) -> Self {
        let _ = SERVICE_ACCOUNT_ID.set(config.account_id.clone());
        Self { config }
    }

    pub fn config(&self) -> &PipConfig {
        &self.config
    }
}

/// PiP's production account id, registered for database tests that need
/// server-managed membership rules to apply.
#[cfg(test)]
pub(crate) fn test_service_account() -> &'static str {
    SERVICE_ACCOUNT_ID.get_or_init(|| "acct_kordi_pip".to_string())
}

#[cfg(test)]
mod membership_tests;
#[cfg(test)]
mod sweep_tests;
