use kordi_provider::registry::{Model, ModelRegistry};

use super::*;

#[derive(Default)]
struct NormalizedModelSelection {
    provider_filter: Option<String>,
    match_term: String,
    thinking_override: Option<ThinkingLevel>,
}

impl TuiController {
    pub(super) fn handle_model_selection_command(&mut self, search: Option<&str>) -> Result<()> {
        let search_term = search.unwrap_or_default().trim();
        let normalized = self.normalize_model_selection(search_term);
        if normalized.provider_filter.is_none() {
            let providers = self.matching_model_providers(search_term);
            if providers.len() > 1 {
                self.pending_model_provider_search = Some(search_term.to_string());
                self.send_command(TuiCommand::OpenSelectMenu {
                    menu_id: super::MODEL_PROVIDER_MENU_ID.to_string(),
                    title: format!("Select provider for '{search_term}'"),
                    items: providers
                        .into_iter()
                        .map(|provider| SelectItem {
                            label: crate::login::provider_display_name(&provider).into_owned(),
                            detail: Some(crate::login::provider_model_selection_detail(&provider)),
                            value: provider,
                        })
                        .collect(),
                    selected_value: None,
                });
                return Ok(());
            }
        }

        if let Some((model, thinking)) = self.find_exact_model_match(search_term) {
            return self.select_model_with_auth(model, thinking);
        }
        if let Some((model, thinking)) = self.find_unique_model_match(search_term) {
            return self.select_model_with_auth(model, thinking);
        }

        self.open_model_menu(search_term, normalized.provider_filter.as_deref())
    }

    pub(super) fn select_model_with_auth(
        &mut self,
        model: Model,
        thinking_override: Option<ThinkingLevel>,
    ) -> Result<()> {
        if self.maybe_open_model_auth_menu(model.clone(), thinking_override)? {
            return Ok(());
        }
        self.apply_model_selection(model, thinking_override);
        Ok(())
    }

    fn maybe_open_model_auth_menu(
        &mut self,
        model: Model,
        thinking_override: Option<ThinkingLevel>,
    ) -> Result<bool> {
        let options = crate::login::provider_auth_option_summaries(&model.provider);
        if options.len() <= 1 {
            return Ok(false);
        }

        self.pending_model_auth_selection =
            Some(crate::tui::controller::PendingModelAuthSelection {
                model: model.clone(),
                thinking_override,
            });
        self.send_command(TuiCommand::OpenSelectMenu {
            menu_id: super::MODEL_AUTH_MENU_ID.to_string(),
            title: format!(
                "Select auth for {}",
                crate::login::provider_display_name(&model.provider)
            ),
            items: options
                .into_iter()
                .map(|option| {
                    let label = match (option.method, option.source) {
                        (
                            crate::login::ProviderAuthMethod::ApiKey,
                            crate::login::AuthSource::EnvVar,
                        ) => option
                            .account_label
                            .as_ref()
                            .map(|label| format!("API key (env) • {label}"))
                            .unwrap_or_else(|| "API key (env)".to_string()),
                        (
                            crate::login::ProviderAuthMethod::ApiKey,
                            crate::login::AuthSource::KordiAuth,
                        ) => option
                            .account_label
                            .as_ref()
                            .map(|label| format!("API key • {label}"))
                            .unwrap_or_else(|| "API key".to_string()),
                        (
                            crate::login::ProviderAuthMethod::OAuth,
                            crate::login::AuthSource::EnvVar,
                        ) => option
                            .account_label
                            .as_ref()
                            .map(|label| format!("OAuth (env) • {label}"))
                            .unwrap_or_else(|| "OAuth (env)".to_string()),
                        (
                            crate::login::ProviderAuthMethod::OAuth,
                            crate::login::AuthSource::KordiAuth,
                        ) => option
                            .account_label
                            .as_ref()
                            .map(|label| format!("OAuth • {label}"))
                            .unwrap_or_else(|| "OAuth".to_string()),
                    };
                    let mut detail_parts = Vec::new();
                    if option.active {
                        detail_parts.push("currently active".to_string());
                    }
                    if matches!(option.source, crate::login::AuthSource::KordiAuth)
                        && matches!(option.method, crate::login::ProviderAuthMethod::ApiKey)
                        && let Some(profile_id) = option.profile_id.as_ref()
                    {
                        let suffix = profile_id
                            .chars()
                            .rev()
                            .take(6)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect::<String>();
                        detail_parts.push(format!("profile {suffix}"));
                    }
                    if let Some(authority) = option.authority {
                        detail_parts.push(authority);
                    }
                    if let Some(timestamp_ms) = option.configured_at_ms.or(option.updated_at_ms)
                        && let Some(dt) =
                            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp_ms)
                    {
                        detail_parts.push(format!("saved {}", dt.format("%Y-%m-%d %H:%M UTC")));
                    }
                    SelectItem {
                        label,
                        detail: (!detail_parts.is_empty()).then_some(detail_parts.join(" • ")),
                        value: option
                            .profile_id
                            .map(|profile_id| format!("profile:{profile_id}"))
                            .unwrap_or_else(|| format!("env:{}", option.method.footer_label())),
                    }
                })
                .collect(),
            selected_value: None,
        });
        Ok(true)
    }

    pub(super) fn open_model_menu(
        &mut self,
        search_term: &str,
        provider_filter: Option<&str>,
    ) -> Result<()> {
        let normalized = self.normalize_model_selection(search_term);
        let provider_filter = provider_filter
            .map(ToString::to_string)
            .or(normalized.provider_filter);
        let needle = normalized.match_term.to_ascii_lowercase();
        let mut items: Vec<SelectItem> = self
            .get_model_candidates()
            .into_iter()
            .filter(|model| {
                if let Some(provider) = provider_filter.as_deref()
                    && model.provider != provider
                {
                    return false;
                }
                if needle.is_empty() {
                    true
                } else {
                    let provider_id =
                        format!("{}/{}", model.provider, model.id).to_ascii_lowercase();
                    let provider_colon_id =
                        format!("{}:{}", model.provider, model.id).to_ascii_lowercase();
                    provider_id.contains(&needle)
                        || provider_colon_id.contains(&needle)
                        || model.id.to_ascii_lowercase().contains(&needle)
                        || model.name.to_ascii_lowercase().contains(&needle)
                }
            })
            .map(|model| SelectItem {
                label: format!("{}/{}", model.provider, model.id),
                detail: Some(model.name.clone()),
                value: format!("{}/{}", model.provider, model.id),
            })
            .collect();
        items.sort_by(|a, b| {
            let (a_provider, a_model) = a.value.split_once('/').unwrap_or(("", &a.value));
            let (b_provider, b_model) = b.value.split_once('/').unwrap_or(("", &b.value));
            a_provider.cmp(b_provider).then_with(|| {
                crate::login::model_catalog_rank(a_provider, a_model)
                    .cmp(&crate::login::model_catalog_rank(b_provider, b_model))
            })
        });

        self.send_command(TuiCommand::OpenSelectMenu {
            menu_id: "model".to_string(),
            title: if let Some(provider) = provider_filter.as_deref() {
                if search_term.is_empty() {
                    format!("Select model from {provider}")
                } else {
                    format!("Select {provider} model matching '{search_term}'")
                }
            } else if search_term.is_empty() {
                "Select model".to_string()
            } else {
                format!("Select model matching '{search_term}'")
            },
            items,
            selected_value: None,
        });
        Ok(())
    }

    pub(crate) fn maybe_switch_to_preferred_post_login_model(
        &mut self,
        provider: &str,
    ) -> Option<String> {
        let settings = Settings::load_merged(&self.session_setup.tool_ctx.cwd);
        let preferred_provider = match provider {
            "openai-codex" => "openai",
            other => other,
        };
        let preferred_model_id = if settings.default_provider.as_deref() == Some(preferred_provider)
            || (provider == "openai-codex"
                && settings.default_provider.as_deref() == Some("openai-codex"))
        {
            crate::login::available_model_for_provider(
                &settings,
                preferred_provider,
                settings.default_model.as_deref(),
            )?
        } else {
            crate::login::preferred_available_model_for_provider(&settings, preferred_provider)?
        };
        let mut registry = ModelRegistry::new();
        registry.load_custom_models(&settings);
        crate::login::add_cached_github_copilot_models(&mut registry);
        let model = registry
            .find(preferred_provider, &preferred_model_id)
            .cloned()
            .or_else(|| {
                registry
                    .find_fuzzy(&preferred_model_id, Some(preferred_provider))
                    .cloned()
            })?;
        let display = format!("{}/{}", model.provider, model.id);
        self.apply_model_selection(model, None);
        Some(display)
    }

    pub(super) fn apply_model_selection(
        &mut self,
        model: Model,
        thinking_override: Option<ThinkingLevel>,
    ) {
        let auth = crate::login::resolve_provider_auth(&model.provider);
        self.apply_model_selection_with_auth(model, thinking_override, auth);
    }

    pub(super) fn apply_model_selection_with_auth(
        &mut self,
        model: Model,
        thinking_override: Option<ThinkingLevel>,
        auth: Option<crate::login::ResolvedProviderAuth>,
    ) {
        let settings = Settings::load_merged(&self.session_setup.tool_ctx.cwd);
        let runtime = crate::runtime_model::build_runtime_config_with_settings(
            &model,
            &settings,
            auth.clone(),
        );
        let display = format!("{}/{}", model.provider, model.id);

        self.runtime_host.session_mut().set_model(ModelRef {
            provider: model.provider.clone(),
            id: model.id.clone(),
            reasoning: model.reasoning,
        });
        self.runtime_host
            .runtime_mut()
            .set_model(Some(RuntimeModelRef {
                provider: model.provider.clone(),
                id: model.id.clone(),
                context_window: model.context_window as usize,
            }));
        self.session_setup.model = model;
        self.session_setup.provider = runtime.provider.clone();
        self.session_setup.auth = runtime.auth;
        self.session_setup.api_key = runtime.api_key.clone();
        self.session_setup.base_url = runtime.base_url.clone();
        self.session_setup.headers = runtime.headers.clone();
        let requested = thinking_override.unwrap_or_else(|| {
            ThinkingLevel::parse(&self.session_setup.thinking_level).unwrap_or(ThinkingLevel::Off)
        });
        let effective = crate::runtime_model::effective_thinking_level_for_model(
            &self.session_setup.model,
            self.session_setup.auth.as_ref().map(|auth| auth.method),
            requested,
        );
        self.session_setup.thinking_level = effective.as_str().to_string();
        self.runtime_host
            .session_mut()
            .set_thinking_level(effective);
        self.session_setup.tool_ctx.web_search = Some(kordi_tools::WebSearchRuntime {
            provider: self.session_setup.provider.clone(),
            model: self.session_setup.model.clone(),
            api_key: self.session_setup.api_key.clone(),
            base_url: self.session_setup.base_url.clone(),
            headers: runtime.headers,
            enabled: true,
        });
        let status = if thinking_override.is_some() || effective != requested {
            format!("Model: {display} • thinking: {}", effective.as_str())
        } else {
            format!("Model: {display}")
        };
        self.options.model_display = Some(display);
        if let Ok(mut tracker) = self.session_setup.request_metrics_tracker.try_lock() {
            tracker.reset_history();
        }
        self.publish_footer();
        self.send_command(TuiCommand::SetStatusLine(status));
    }

    pub(super) fn get_model_candidates(&self) -> Vec<Model> {
        let settings = Settings::load_merged(&self.session_setup.tool_ctx.cwd);
        crate::login::authenticated_model_candidates(&settings)
    }

    pub(super) fn find_exact_model_match(
        &self,
        search_term: &str,
    ) -> Option<(Model, Option<ThinkingLevel>)> {
        let normalized = self.normalize_model_selection(search_term);
        let needle = normalized.match_term.to_ascii_lowercase();
        self.get_model_candidates().into_iter().find_map(|model| {
            if let Some(provider) = normalized.provider_filter.as_deref()
                && model.provider != provider
            {
                return None;
            }
            let provider_id = format!("{}/{}", model.provider, model.id).to_ascii_lowercase();
            let provider_colon_id = format!("{}:{}", model.provider, model.id).to_ascii_lowercase();
            let matched = model.id.eq_ignore_ascii_case(&needle)
                || model.name.eq_ignore_ascii_case(&needle)
                || provider_id == needle
                || provider_colon_id == needle;
            matched.then_some((model, normalized.thinking_override))
        })
    }

    pub(super) fn find_unique_model_match(
        &self,
        search_term: &str,
    ) -> Option<(Model, Option<ThinkingLevel>)> {
        let normalized = self.normalize_model_selection(search_term);
        if normalized.match_term.is_empty() {
            return None;
        }
        let needle = normalized.match_term.to_ascii_lowercase();
        let mut matches = self.get_model_candidates().into_iter().filter(|model| {
            if let Some(provider) = normalized.provider_filter.as_deref()
                && model.provider != provider
            {
                return false;
            }
            let provider_id = format!("{}/{}", model.provider, model.id).to_ascii_lowercase();
            let provider_colon_id = format!("{}:{}", model.provider, model.id).to_ascii_lowercase();
            provider_id.contains(&needle)
                || provider_colon_id.contains(&needle)
                || model.id.to_ascii_lowercase().contains(&needle)
                || model.name.to_ascii_lowercase().contains(&needle)
        });
        let first = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        Some((first, normalized.thinking_override))
    }

    pub(super) fn matching_model_providers(&self, search_term: &str) -> Vec<String> {
        let normalized = self.normalize_model_selection(search_term);
        if normalized.provider_filter.is_some() || normalized.match_term.is_empty() {
            return Vec::new();
        }
        let needle = normalized.match_term.to_ascii_lowercase();
        let mut providers = self
            .get_model_candidates()
            .into_iter()
            .filter(|model| {
                let provider_id = format!("{}/{}", model.provider, model.id).to_ascii_lowercase();
                let provider_colon_id =
                    format!("{}:{}", model.provider, model.id).to_ascii_lowercase();
                provider_id.contains(&needle)
                    || provider_colon_id.contains(&needle)
                    || model.id.to_ascii_lowercase().contains(&needle)
                    || model.name.to_ascii_lowercase().contains(&needle)
            })
            .map(|model| model.provider)
            .collect::<Vec<_>>();
        providers.sort();
        providers.dedup();
        providers
    }

    fn normalize_model_selection(&self, search_term: &str) -> NormalizedModelSelection {
        let search_term = search_term.trim();
        if search_term.is_empty() {
            return NormalizedModelSelection::default();
        }

        let current_provider = self.session_setup.model.provider.as_str();
        let (parsed_provider, parsed_model, thinking_override) =
            parse_model_arg(Some(current_provider), Some(search_term));
        let thinking_override = thinking_override.as_deref().and_then(ThinkingLevel::parse);

        if search_term.contains('/') {
            return NormalizedModelSelection {
                provider_filter: Some(parsed_provider),
                match_term: parsed_model,
                thinking_override,
            };
        }

        if let Some((provider, model)) = search_term.split_once(':')
            && !provider.is_empty()
            && !model.is_empty()
            && self
                .get_model_candidates()
                .iter()
                .any(|candidate| candidate.provider.eq_ignore_ascii_case(provider))
        {
            return NormalizedModelSelection {
                provider_filter: Some(provider.to_string()),
                match_term: model.to_string(),
                thinking_override,
            };
        }

        NormalizedModelSelection {
            provider_filter: None,
            match_term: if parsed_provider == current_provider {
                parsed_model
            } else {
                search_term.to_string()
            },
            thinking_override,
        }
    }

    pub(super) fn copy_last_assistant_message(&mut self) -> Result<()> {
        let session_context =
            context::build_context(&self.session_setup.conn, &self.session_setup.session_id)?;
        let last_text =
            session_context
                .messages
                .into_iter()
                .rev()
                .find_map(|message| match message {
                    AgentMessage::Assistant(message) => {
                        let text = format_assistant_text(&message);
                        if text.trim().is_empty() {
                            None
                        } else {
                            Some(text)
                        }
                    }
                    _ => None,
                });

        if let Some(text) = last_text {
            copy_text_to_clipboard(&text)?;
            self.send_command(TuiCommand::SetStatusLine(
                "Copied last assistant message to clipboard".to_string(),
            ));
        } else {
            self.send_command(TuiCommand::SetStatusLine(
                "No assistant messages to copy".to_string(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
