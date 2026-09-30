use super::model_options::resolve_auth_choice_override_for_model;
use super::*;

impl DesktopRuntimeSession {
    /// Select a model whose auth is supplied by a server-validated desktop
    /// lease rather than the local login store. The caller must resolve that
    /// lease before using this path.
    pub fn set_hosted_model(&mut self, requested_model: &str) -> Result<()> {
        let (provider, model_id) = requested_model
            .trim()
            .split_once('/')
            .ok_or_else(|| anyhow!("Hosted model must include a provider"))?;
        if provider.trim().is_empty() || model_id.trim().is_empty() {
            bail!("Hosted model must include a provider and model");
        }
        let provider = login::normalize_provider_for_model_selection(provider);
        let settings = Settings::load_merged(&self.setup.tool_ctx.cwd);
        let mut registry = kordi_provider::registry::ModelRegistry::new();
        registry.load_custom_models(&settings);
        let model = crate::runtime_model::resolve_or_synthesize_model_with_settings(
            &registry, &settings, &provider, model_id,
        );
        let previous_provider = self.setup.model.provider.clone();
        let previous_model = self.setup.model.id.clone();
        let previous_thinking = self.setup.thinking_level.clone();
        self.setup.model = model;
        refresh_provider_runtime_fields(&mut self.setup);
        normalize_setup_thinking(&mut self.setup);
        let session_has_visible_history = self.setup.session_created
            && session_has_visible_message_entries(&self.setup.conn, &self.setup.session_id);
        if session_has_visible_history
            && (previous_provider != self.setup.model.provider
                || previous_model != self.setup.model.id)
        {
            append_model_change_entry(&self.setup.conn, &self.setup.session_id, &self.setup.model)?;
        }
        if session_has_visible_history && previous_thinking != self.setup.thinking_level {
            let thinking = ThinkingLevel::parse(&self.setup.thinking_level)
                .ok_or_else(|| anyhow!("Unknown thinking level"))?;
            append_thinking_level_change_entry(&self.setup.conn, &self.setup.session_id, thinking)?;
        }
        Ok(())
    }

    /// Supplies provider credentials only to the next desktop turn. The
    /// credential is held in memory and is never saved as a local auth profile.
    pub fn set_ephemeral_provider_auth(
        &mut self,
        provider: &str,
        auth: login::ResolvedProviderAuth,
    ) -> Result<()> {
        self.set_ephemeral_provider_auth_with_options(provider, auth, None, None)
    }

    pub fn set_ephemeral_provider_auth_with_options(
        &mut self,
        provider: &str,
        auth: login::ResolvedProviderAuth,
        base_url: Option<String>,
        api: Option<&str>,
    ) -> Result<()> {
        if !login::provider_names_match(&self.setup.model.provider, provider)
            || !login::provider_names_match(provider, &auth.credential_provider)
            || auth.credential.trim().is_empty()
        {
            bail!("Hosted provider credentials do not match the selected model");
        }
        let api = match api {
            Some("openai-completions" | "openrouter") => {
                Some(kordi_provider::registry::ApiType::OpenaiCompletions)
            }
            Some("openai-responses" | "openai-codex-responses") => {
                Some(kordi_provider::registry::ApiType::OpenaiResponses)
            }
            Some("anthropic-messages") => {
                Some(kordi_provider::registry::ApiType::AnthropicMessages)
            }
            Some("google-generative-ai") => {
                Some(kordi_provider::registry::ApiType::GoogleGenerative)
            }
            Some(_) => bail!("Hosted provider API is unsupported by the local runtime"),
            None => None,
        };
        if let Some(base_url) = base_url.as_deref() {
            let parsed = reqwest::Url::parse(base_url)
                .map_err(|_| anyhow!("Hosted provider endpoint is invalid"))?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                bail!("Hosted provider endpoint is invalid");
            }
        }
        self.setup.auth_choice_override = None;
        self.clear_ephemeral_provider_auth();
        if let Some(api) = api {
            self.setup.ephemeral_original_model_api = Some(self.setup.model.api.clone());
            self.setup.model.api = api;
        }
        self.setup.ephemeral_auth = Some(auth);
        self.setup.ephemeral_base_url = base_url;
        refresh_provider_runtime_fields(&mut self.setup);
        normalize_setup_thinking(&mut self.setup);
        Ok(())
    }

    pub fn clear_ephemeral_provider_auth(&mut self) {
        if let Some(api) = self.setup.ephemeral_original_model_api.take() {
            self.setup.model.api = api;
        }
        self.setup.ephemeral_auth = None;
        self.setup.ephemeral_base_url = None;
        refresh_provider_runtime_fields(&mut self.setup);
    }
}

pub(super) fn refresh_provider_runtime_fields(setup: &mut SessionRuntimeSetup) {
    let settings = Settings::load_merged(&setup.tool_ctx.cwd);
    let auth_override = setup.ephemeral_auth.clone().or_else(|| {
        setup.auth_choice_override.as_ref().and_then(|choice| {
            resolve_auth_choice_override_for_model(&setup.model.provider, choice)
        })
    });
    let runtime = crate::runtime_model::build_runtime_config_with_settings(
        &setup.model,
        &settings,
        auth_override,
    );

    setup.provider = runtime.provider.clone();
    setup.auth = runtime.auth;
    setup.api_key = runtime.api_key.clone();
    setup.base_url = setup
        .ephemeral_base_url
        .clone()
        .unwrap_or_else(|| runtime.base_url.clone());
    setup.headers = runtime.headers.clone();
    setup.tool_ctx.web_search = Some(kordi_tools::WebSearchRuntime {
        provider: setup.provider.clone(),
        model: setup.model.clone(),
        api_key: setup.api_key.clone(),
        base_url: setup.base_url.clone(),
        headers: runtime.headers,
        enabled: true,
    });
}
