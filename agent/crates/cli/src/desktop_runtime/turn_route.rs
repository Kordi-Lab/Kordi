//! Per-turn request routes.
//!
//! A request names the model, account and thinking level its turn runs with.
//! That route belongs to the turn, not to the session: applying it records no
//! model or thinking change in the transcript, and the session's own settings
//! return as soon as the turn has taken its private copy of the runtime.

use super::*;

/// The session's own model settings while a request route is applied.
pub(super) struct ConfiguredRoute {
    model: Model,
    thinking_level: String,
    auth_choice_override: Option<SessionAuthChoiceOverride>,
}

impl DesktopRuntimeSession {
    /// Runs the next turn with `requested_model` without changing the session's model.
    pub fn apply_turn_model(&mut self, requested_model: &str) -> Result<()> {
        self.hold_configured_route();
        self.apply_model(requested_model).map(|_| ())
    }

    /// Runs the next turn with a model whose credentials come from a desktop
    /// execution lease. The route's exact model runs: another model is never
    /// substituted for one the local registry does not list.
    pub fn apply_turn_hosted_model(&mut self, requested_model: &str) -> Result<()> {
        let (provider, model_id) = requested_model
            .trim()
            .split_once('/')
            .ok_or_else(|| anyhow!("Hosted model must include a provider"))?;
        let (provider, model_id) = (provider.trim(), model_id.trim());
        if provider.is_empty() || model_id.is_empty() {
            bail!("Hosted model must include a provider and model");
        }
        let provider = login::normalize_provider_for_model_selection(provider);
        let settings = Settings::load_merged(&self.setup.tool_ctx.cwd);
        let mut registry = kordi_provider::registry::ModelRegistry::new();
        registry.load_custom_models(&settings);
        let model = registry
            .list()
            .iter()
            .find(|model| model.provider == provider && model.id.eq_ignore_ascii_case(model_id))
            .cloned()
            .unwrap_or_else(|| {
                crate::runtime_model::synthesize_model_candidate_with_settings(
                    &registry, &settings, &provider, model_id,
                )
            });
        self.hold_configured_route();
        self.setup.model = model;
        refresh_provider_runtime_fields(&mut self.setup);
        normalize_setup_thinking(&mut self.setup);
        Ok(())
    }

    /// Uses `choice` for the next turn without changing the session's account.
    pub fn apply_turn_auth_choice(&mut self, provider: &str, choice: &str) -> Result<()> {
        self.hold_configured_route();
        self.set_auth_choice(provider, choice)
    }

    /// Uses `requested_thinking` for the next turn without recording a change.
    pub fn apply_turn_thinking(&mut self, requested_thinking: &str) -> Result<()> {
        self.hold_configured_route();
        self.apply_thinking(requested_thinking).map(|_| ())
    }

    fn hold_configured_route(&mut self) {
        if self.configured_route.is_none() {
            self.configured_route = Some(ConfiguredRoute {
                model: self.setup.model.clone(),
                thinking_level: self.setup.thinking_level.clone(),
                auth_choice_override: self.setup.auth_choice_override.clone(),
            });
        }
    }

    /// Returns the session to its own settings after a request route applied.
    /// Any hosted credential the turn did not take is dropped with the route.
    pub(super) fn restore_configured_route(&mut self) {
        let Some(configured) = self.configured_route.take() else {
            return;
        };
        self.clear_ephemeral_provider_auth();
        self.setup.model = configured.model;
        self.setup.thinking_level = configured.thinking_level;
        self.setup.auth_choice_override = configured.auth_choice_override;
        refresh_provider_runtime_fields(&mut self.setup);
    }
}
