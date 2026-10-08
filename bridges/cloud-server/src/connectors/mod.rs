//! Connectors: owner-granted access to third-party services (issue 1712).
//!
//! The server holds each credential, encrypted, and executes connector tool
//! calls through the broker. Runs receive tool results only, never a token.

pub mod broker;
mod credentials;
pub mod delivery;
pub mod digest_input;
pub mod events;
pub mod hooks;
pub mod models;
pub mod oauth;
pub mod oauth_complete;
pub mod polling;
pub mod providers;
mod refresh;
pub mod routes;
mod settings;
pub mod store;
pub mod tool_schemas;
pub mod webhooks;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use crate::cloud_agent_runtime::provider_auth::{EnvProviderAuthCipher, ProviderAuthCipher};

pub use hooks::ConnectorHooks;

/// Version reported as `connectorsVersion` in `/v1/cloud/auth/capabilities`.
pub const CONNECTORS_VERSION: u32 = 1;

/// Process-wide connector dependencies, held once by `ServerState`.
#[derive(Clone)]
pub struct ConnectorRuntime {
    /// The provider-auth cipher. `None` when
    /// `KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY` is unset; connecting and
    /// broker calls then fail closed.
    pub cipher: Option<Arc<dyn ProviderAuthCipher>>,
    pub providers: providers::ProviderRegistry,
    /// Webhook secrets, push verification, and polling interval.
    pub hooks: ConnectorHooks,
}

impl ConnectorRuntime {
    pub fn from_env() -> Self {
        Self {
            cipher: EnvProviderAuthCipher::from_env()
                .ok()
                .map(|cipher| Arc::new(cipher) as Arc<dyn ProviderAuthCipher>),
            providers: providers::ProviderRegistry::production(),
            hooks: ConnectorHooks::from_env(),
        }
    }

    pub fn new(
        cipher: Option<Arc<dyn ProviderAuthCipher>>,
        providers: providers::ProviderRegistry,
    ) -> Self {
        Self {
            cipher,
            providers,
            hooks: ConnectorHooks::default(),
        }
    }

    pub fn with_hooks(mut self, hooks: ConnectorHooks) -> Self {
        self.hooks = hooks;
        self
    }
}
