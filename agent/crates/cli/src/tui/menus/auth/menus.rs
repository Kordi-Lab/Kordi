use super::dialogs::{tui_auth_display_name, tui_auth_status_detail};
use super::*;

fn provider_title(provider: &str) -> &str {
    match provider {
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        "github-copilot" => "GitHub Copilot",
        "google" => "Google Gemini",
        "groq" => "Groq",
        "xai" => "xAI",
        "openrouter" => "OpenRouter",
        _ => provider,
    }
}

fn format_timestamp(timestamp_ms: Option<i64>) -> Option<String> {
    let timestamp_ms = timestamp_ms?;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp_ms)
        .map(|dt| dt.format("%Y-%m-%d %H:%M UTC").to_string())
}

fn auth_option_label(option: &crate::login::ProviderAuthOptionSummary) -> String {
    match (option.method, option.source) {
        (crate::login::ProviderAuthMethod::ApiKey, crate::login::AuthSource::EnvVar) => option
            .account_label
            .as_ref()
            .map(|label| format!("API key (env) • {label}"))
            .unwrap_or_else(|| "API key (env)".to_string()),
        (crate::login::ProviderAuthMethod::ApiKey, crate::login::AuthSource::KordiAuth) => option
            .account_label
            .as_ref()
            .map(|label| format!("Saved API key • {label}"))
            .unwrap_or_else(|| "Saved API key".to_string()),
        (crate::login::ProviderAuthMethod::OAuth, crate::login::AuthSource::EnvVar) => option
            .account_label
            .as_ref()
            .map(|label| format!("OAuth (env) • {label}"))
            .unwrap_or_else(|| "OAuth (env)".to_string()),
        (crate::login::ProviderAuthMethod::OAuth, crate::login::AuthSource::KordiAuth) => option
            .account_label
            .as_ref()
            .map(|label| format!("OAuth • {label}"))
            .unwrap_or_else(|| "OAuth".to_string()),
    }
}

fn short_profile_suffix(profile_id: &str) -> String {
    let suffix = profile_id
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    if suffix.is_empty() {
        profile_id.to_string()
    } else {
        suffix
    }
}

fn auth_option_detail(option: &crate::login::ProviderAuthOptionSummary) -> Option<String> {
    let mut parts = Vec::new();
    if option.active {
        parts.push("currently active".to_string());
    }
    if matches!(option.source, crate::login::AuthSource::KordiAuth)
        && matches!(option.method, crate::login::ProviderAuthMethod::ApiKey)
        && let Some(profile_id) = &option.profile_id
    {
        parts.push(format!("profile {}", short_profile_suffix(profile_id)));
    }
    if let Some(authority) = &option.authority {
        parts.push(authority.clone());
    }
    if let Some(saved_at) = format_timestamp(option.configured_at_ms.or(option.updated_at_ms)) {
        parts.push(format!("saved {saved_at}"));
    }
    (!parts.is_empty()).then_some(parts.join(" • "))
}

fn auth_option_value(option: &crate::login::ProviderAuthOptionSummary) -> String {
    option
        .profile_id
        .as_ref()
        .map(|profile_id| format!("profile:{profile_id}"))
        .unwrap_or_else(|| format!("env:{}", option.method.footer_label()))
}

fn auth_method_detail(
    provider: &str,
    method: crate::login::ProviderAuthMethod,
    base: &str,
) -> String {
    let options = crate::login::provider_auth_option_summaries(provider)
        .into_iter()
        .filter(|option| option.method == method)
        .collect::<Vec<_>>();
    if options.is_empty() {
        return base.to_string();
    }

    let mut detail = format!(
        "{base} • {} option{}",
        options.len(),
        if options.len() == 1 { "" } else { "s" }
    );
    if let Some(active) = options.iter().find(|option| option.active) {
        detail.push_str(" • active: ");
        detail.push_str(&auth_option_label(active));
        if let Some(authority) = &active.authority {
            detail.push_str(" • ");
            detail.push_str(authority);
        }
    }
    detail
}

impl TuiController {
    pub(crate) fn maybe_open_login_auth_option_menu(
        &mut self,
        provider: &str,
        method: crate::login::ProviderAuthMethod,
    ) -> bool {
        let options = crate::login::provider_auth_option_summaries(provider)
            .into_iter()
            .filter(|option| option.method == method)
            .collect::<Vec<_>>();
        if options.is_empty() {
            return false;
        }

        self.pending_login_auth_selection =
            Some(crate::tui::controller::PendingLoginAuthSelection {
                provider: provider.to_string(),
                method,
            });

        let mut items = options
            .into_iter()
            .map(|option| SelectItem {
                label: auth_option_label(&option),
                detail: auth_option_detail(&option),
                value: auth_option_value(&option),
            })
            .collect::<Vec<_>>();

        match (provider, method) {
            ("github-copilot", crate::login::ProviderAuthMethod::OAuth) => {
                items.push(SelectItem {
                    label: "Sign in with GitHub.com".to_string(),
                    detail: Some(
                        "Start a new Copilot OAuth/device login for github.com".to_string(),
                    ),
                    value: "action:copilot-github".to_string(),
                });
                items.push(SelectItem {
                    label: "Sign in with GitHub Enterprise Server".to_string(),
                    detail: Some(
                        "Choose a GitHub Enterprise Server host and start a new Copilot login"
                            .to_string(),
                    ),
                    value: "action:copilot-enterprise".to_string(),
                });
            }
            (_, crate::login::ProviderAuthMethod::OAuth) => {
                items.push(SelectItem {
                    label: "Sign in another account".to_string(),
                    detail: Some("Store another saved OAuth profile".to_string()),
                    value: "action:login-new".to_string(),
                });
            }
            (_, crate::login::ProviderAuthMethod::ApiKey) => {
                items.push(SelectItem {
                    label: "Paste a new API key".to_string(),
                    detail: Some("Save or replace the API key stored in auth.json".to_string()),
                    value: "action:login-new".to_string(),
                });
            }
        }

        let method_label = match method {
            crate::login::ProviderAuthMethod::OAuth => "OAuth",
            crate::login::ProviderAuthMethod::ApiKey => "API key",
        };
        self.send_command(TuiCommand::OpenSelectMenu {
            menu_id: LOGIN_AUTH_OPTION_MENU_ID.to_string(),
            title: format!("Use {} {}", provider_title(provider), method_label),
            items,
            selected_value: None,
        });
        true
    }

    pub(crate) fn open_login_provider_menu(&mut self) {
        self.send_command(TuiCommand::OpenSelectMenu {
            menu_id: LOGIN_PROVIDER_MENU_ID.to_string(),
            title: "Sign in provider".to_string(),
            items: LOGIN_PROVIDERS
                .iter()
                .map(|provider| {
                    let methods = match *provider {
                        "anthropic" | "openai" => "OAuth + API key",
                        "github-copilot" => "OAuth",
                        _ => "API key",
                    };
                    SelectItem {
                        label: provider_title(provider).to_string(),
                        detail: Some(format!("{methods} • {}", tui_auth_status_detail(provider))),
                        value: (*provider).to_string(),
                    }
                })
                .collect(),
            selected_value: None,
        });
    }

    pub(crate) fn open_login_method_menu(&mut self, provider: &str) {
        let mut items = Vec::new();
        match provider {
            "anthropic" => {
                items.push(SelectItem {
                    label: "Claude Pro/Max".to_string(),
                    detail: Some(auth_method_detail(
                        "anthropic",
                        crate::login::ProviderAuthMethod::OAuth,
                        "OAuth subscription login",
                    )),
                    value: "oauth:anthropic".to_string(),
                });
                items.push(SelectItem {
                    label: "Anthropic API key".to_string(),
                    detail: Some(auth_method_detail(
                        "anthropic",
                        crate::login::ProviderAuthMethod::ApiKey,
                        "Use ANTHROPIC_API_KEY or paste a key",
                    )),
                    value: "api_key:anthropic".to_string(),
                });
            }
            "openai" => {
                items.push(SelectItem {
                    label: "ChatGPT Plus/Pro (Codex)".to_string(),
                    detail: Some(auth_method_detail(
                        "openai",
                        crate::login::ProviderAuthMethod::OAuth,
                        "OAuth subscription login",
                    )),
                    value: "oauth:openai-codex".to_string(),
                });
                items.push(SelectItem {
                    label: "OpenAI API key".to_string(),
                    detail: Some(auth_method_detail(
                        "openai",
                        crate::login::ProviderAuthMethod::ApiKey,
                        "Use OPENAI_API_KEY or paste a key",
                    )),
                    value: "api_key:openai".to_string(),
                });
            }
            "github-copilot" => {
                items.push(SelectItem {
                    label: "Use existing Copilot login".to_string(),
                    detail: Some(auth_method_detail(
                        "github-copilot",
                        crate::login::ProviderAuthMethod::OAuth,
                        "Switch between saved or env-backed Copilot auth",
                    )),
                    value: "oauth:github-copilot".to_string(),
                });
                items.push(SelectItem {
                    label: "Sign in with GitHub.com".to_string(),
                    detail: Some("Start a new github.com Copilot login".to_string()),
                    value: "copilot:github".to_string(),
                });
                items.push(SelectItem {
                    label: "GitHub Enterprise Server".to_string(),
                    detail: Some("Enter your GitHub Enterprise Server domain".to_string()),
                    value: "copilot:enterprise".to_string(),
                });
            }
            "google" => {
                items.push(SelectItem {
                    label: "Google API key".to_string(),
                    detail: Some(auth_method_detail(
                        "google",
                        crate::login::ProviderAuthMethod::ApiKey,
                        "Use GOOGLE_API_KEY / GEMINI_API_KEY or paste a key",
                    )),
                    value: "api_key:google".to_string(),
                });
            }
            "groq" => {
                items.push(SelectItem {
                    label: "Groq API key".to_string(),
                    detail: Some(auth_method_detail(
                        "groq",
                        crate::login::ProviderAuthMethod::ApiKey,
                        "Use GROQ_API_KEY or paste a key",
                    )),
                    value: "api_key:groq".to_string(),
                });
            }
            "xai" => {
                items.push(SelectItem {
                    label: "xAI API key".to_string(),
                    detail: Some(auth_method_detail(
                        "xai",
                        crate::login::ProviderAuthMethod::ApiKey,
                        "Use XAI_API_KEY or paste a key",
                    )),
                    value: "api_key:xai".to_string(),
                });
            }
            "openrouter" => {
                items.push(SelectItem {
                    label: "OpenRouter API key".to_string(),
                    detail: Some(auth_method_detail(
                        "openrouter",
                        crate::login::ProviderAuthMethod::ApiKey,
                        "Use OPENROUTER_API_KEY or paste a key",
                    )),
                    value: "api_key:openrouter".to_string(),
                });
            }
            _ => {}
        }

        self.send_command(TuiCommand::OpenSelectMenu {
            menu_id: LOGIN_METHOD_MENU_ID.to_string(),
            title: format!("Sign in method: {}", provider_title(provider)),
            items,
            selected_value: None,
        });
    }

    pub(crate) fn open_logout_provider_menu(&mut self) {
        let providers = crate::login::configured_providers();
        if providers.is_empty() {
            self.send_command(TuiCommand::SetStatusLine(
                "No logged-in providers".to_string(),
            ));
            return;
        }
        self.send_command(TuiCommand::OpenSelectMenu {
            menu_id: LOGOUT_PROVIDER_MENU_ID.to_string(),
            title: "Logout provider".to_string(),
            items: providers
                .into_iter()
                .map(|provider| SelectItem {
                    label: tui_auth_display_name(&provider),
                    detail: Some(tui_auth_status_detail(&provider)),
                    value: provider,
                })
                .collect(),
            selected_value: None,
        });
    }
}

#[cfg(test)]
mod tests;
