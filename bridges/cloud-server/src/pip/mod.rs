//! PiP: the plan agent groups can turn on.
//!
//! PiP is a system-managed account that runs on a Kordi-operated provider
//! credential, sweeps the conversations it belongs to, and keeps one plan
//! card per conversation honest through the `plan_card` tool. It posts as an
//! ordinary member; it never touches anyone's personal calendar. Each group
//! decides whether PiP is a member (`cloud_chat_ai_policies.pip_enabled`).

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
static SERVICE_PROVIDER_LABEL: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// PiP's account when it is running on this server, so other features (the
/// digest) can tell PiP's messages apart from members'.
pub fn service_account_id() -> Option<&'static str> {
    SERVICE_ACCOUNT_ID.get().map(String::as_str)
}

/// The model provider PiP runs on, as people know it ("OpenAI"), when PiP is
/// running on this server.
pub fn service_provider_label() -> Option<&'static str> {
    SERVICE_PROVIDER_LABEL.get().map(String::as_str)
}

/// Records which account and provider PiP runs as. Membership changes made
/// while PiP starts up already need both.
fn register_service(config: &PipConfig) {
    let _ = SERVICE_ACCOUNT_ID.set(config.account_id.clone());
    let _ = SERVICE_PROVIDER_LABEL.set(
        crate::cloud_agent_runtime::provider_auth::provider_display_label(
            config.provider_auth().provider(),
        ),
    );
}

#[derive(Clone)]
pub struct PipService {
    config: PipConfig,
}

impl PipService {
    pub fn new(config: PipConfig) -> Self {
        register_service(&config);
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

/// Startup reconciliation reads and changes every group in the database, so
/// its test holds this for writing, and tests that turn PiP on in their own
/// groups hold it for reading. Without it a parallel run lets one test's
/// reconcile join its PiP account to another test's group mid-test.
#[cfg(test)]
pub(crate) static GROUP_SETTING_TESTS: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

#[cfg(test)]
mod card_update_tests;
#[cfg(test)]
mod context_boundary_tests;
#[cfg(test)]
mod membership_tests;
#[cfg(test)]
mod sweep_tests;
