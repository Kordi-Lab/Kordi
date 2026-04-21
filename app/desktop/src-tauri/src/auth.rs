use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthOption {
    pub value: String,
    pub profile_id: Option<String>,
    pub method: String,
    pub source: String,
    pub label: String,
    pub detail: Option<String>,
    pub active: bool,
    pub account_label: Option<String>,
    pub authority: Option<String>,
    pub configured_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthProvider {
    pub id: String,
    pub label: String,
    pub status_summary: String,
    pub login_hint: String,
    pub env_var: String,
    pub help_url: String,
    pub supports_oauth: bool,
    pub supports_api_key: bool,
    pub configured: bool,
    pub authority: Option<String>,
    pub options: Vec<DesktopAuthOption>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthState {
    pub auth_path: String,
    pub has_any_auth: bool,
    pub providers: Vec<DesktopAuthProvider>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthAttemptSnapshot {
    pub id: String,
    pub provider: String,
    pub status: String,
    pub message: String,
    pub auth_url: Option<String>,
    pub browser_opened: bool,
    pub verification_url: Option<String>,
    pub user_code: Option<String>,
    pub can_paste_callback: bool,
    pub completed: bool,
    pub succeeded: bool,
    pub error: Option<String>,
}

struct DesktopAuthAttemptHandle {
    manual_tx: tokio::sync::mpsc::UnboundedSender<String>,
    snapshot: Arc<Mutex<DesktopAuthAttemptSnapshot>>,
}

#[derive(Default)]
pub struct DesktopAuthManager {
    attempts: tokio::sync::Mutex<HashMap<String, DesktopAuthAttemptHandle>>,
}

fn looks_like_uuid(value: &str) -> bool {
    let value = value.trim();
    value.len() == 36
        && value.chars().enumerate().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit(),
        })
}

fn short_account_suffix(value: &str) -> Option<String> {
    let compact = value.trim();
    if compact.is_empty() {
        return None;
    }
    let suffix = compact
        .chars()
        .rev()
        .filter(|ch| *ch != '-')
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    (!suffix.is_empty()).then_some(suffix)
}

fn auth_option_label(
    provider: &str,
    option: &kordi_cli::login::ProviderAuthOptionSummary,
) -> String {
    match (option.method, option.source) {
        (kordi_cli::login::ProviderAuthMethod::ApiKey, kordi_cli::login::AuthSource::EnvVar) => {
            "Environment API key".to_string()
        }
        (kordi_cli::login::ProviderAuthMethod::ApiKey, kordi_cli::login::AuthSource::BbAuth) => {
            option
                .account_label
                .clone()
                .unwrap_or_else(|| "Saved API key".to_string())
        }
        (kordi_cli::login::ProviderAuthMethod::OAuth, kordi_cli::login::AuthSource::EnvVar) => {
            "Environment OAuth".to_string()
        }
        (kordi_cli::login::ProviderAuthMethod::OAuth, kordi_cli::login::AuthSource::BbAuth) => {
            if provider == "anthropic" {
                return "Claude subscription".to_string();
            }

            if matches!(provider, "openai" | "openai-codex") {
                if let Some(account_label) = option.account_label.as_deref() {
                    if looks_like_uuid(account_label) {
                        return "ChatGPT account".to_string();
                    }
                }
            }

            option
                .account_label
                .clone()
                .unwrap_or_else(|| "Saved OAuth account".to_string())
        }
    }
}

fn auth_option_detail(
    provider: &str,
    option: &kordi_cli::login::ProviderAuthOptionSummary,
) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(authority) = &option.authority {
        parts.push(authority.clone());
    }
    if matches!(option.source, kordi_cli::login::AuthSource::BbAuth)
        && matches!(option.method, kordi_cli::login::ProviderAuthMethod::ApiKey)
    {
        if let Some(profile_id) = &option.profile_id {
            let suffix = profile_id
                .chars()
                .rev()
                .take(6)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>();
            parts.push(format!("profile {suffix}"));
        }
    }
    if provider == "anthropic"
        && matches!(option.method, kordi_cli::login::ProviderAuthMethod::OAuth)
        && matches!(option.source, kordi_cli::login::AuthSource::BbAuth)
    {
        parts.push("claude.ai".to_string());
        if let Some(profile_id) = &option.profile_id {
            let suffix = profile_id
                .chars()
                .rev()
                .take(6)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>();
            if !suffix.is_empty() {
                parts.push(format!("oauth id {suffix}"));
            }
        }
    }
    if matches!(provider, "openai" | "openai-codex")
        && matches!(option.method, kordi_cli::login::ProviderAuthMethod::OAuth)
        && matches!(option.source, kordi_cli::login::AuthSource::BbAuth)
    {
        if let Some(account_label) = option.account_label.as_deref() {
            if looks_like_uuid(account_label) {
                if let Some(suffix) = short_account_suffix(account_label) {
                    parts.push(format!("account {suffix}"));
                }
            }
        }
    }
    parts.push(option.source.label().to_string());
    (!parts.is_empty()).then(|| parts.join(" • "))
}

fn build_auth_state() -> DesktopAuthState {
    let providers = kordi_cli::login::known_providers()
        .iter()
        .map(|(provider, env_var, help_url)| {
            let options = kordi_cli::login::provider_auth_option_summaries(provider)
                .into_iter()
                .map(|option| DesktopAuthOption {
                    value: option
                        .profile_id
                        .clone()
                        .map(|profile_id| format!("profile:{profile_id}"))
                        .unwrap_or_else(|| format!("env:{}", option.method.footer_label())),
                    profile_id: option.profile_id.clone(),
                    method: option.method.label().to_string(),
                    source: option.source.label().to_string(),
                    label: auth_option_label(provider, &option),
                    detail: auth_option_detail(provider, &option),
                    active: option.active,
                    account_label: option.account_label.clone(),
                    authority: option.authority.clone(),
                    configured_at_ms: option.configured_at_ms,
                    updated_at_ms: option.updated_at_ms,
                })
                .collect::<Vec<_>>();
            let copilot_status = (*provider == "github-copilot").then(kordi_cli::login::github_copilot_status);
            DesktopAuthProvider {
                id: (*provider).to_string(),
                label: kordi_cli::login::provider_display_name(provider).into_owned(),
                status_summary: kordi_cli::login::provider_auth_status_summary(provider),
                login_hint: kordi_cli::login::provider_login_hint(provider),
                env_var: (*env_var).to_string(),
                help_url: (*help_url).to_string(),
                supports_oauth: kordi_cli::login::provider_oauth_variant(provider).is_some(),
                supports_api_key: kordi_cli::login::provider_api_key_variant(provider).is_some(),
                configured: !options.is_empty(),
                authority: copilot_status.and_then(|status| status.authority),
                options,
            }
        })
        .collect::<Vec<_>>();

    DesktopAuthState {
        auth_path: kordi_cli::login::auth_path().display().to_string(),
        has_any_auth: providers.iter().any(|provider| !provider.options.is_empty()),
        providers,
    }
}

fn snapshot_attempt(
    snapshot: &Arc<Mutex<DesktopAuthAttemptSnapshot>>,
) -> Result<DesktopAuthAttemptSnapshot, String> {
    snapshot
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "Auth attempt state is unavailable".to_string())
}

fn update_attempt(
    snapshot: &Arc<Mutex<DesktopAuthAttemptSnapshot>>,
    apply: impl FnOnce(&mut DesktopAuthAttemptSnapshot),
) {
    if let Ok(mut guard) = snapshot.lock() {
        apply(&mut guard);
    }
}

#[tauri::command]
pub fn desktop_auth_state() -> DesktopAuthState {
    build_auth_state()
}

#[tauri::command]
pub fn desktop_save_api_key(provider: String, key: String) -> Result<DesktopAuthState, String> {
    let provider = kordi_cli::login::provider_api_key_variant(&provider).unwrap_or(&provider);
    if key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    kordi_cli::login::save_api_key(provider, key.trim().to_string()).map_err(|err| err.to_string())?;
    Ok(build_auth_state())
}

#[tauri::command]
pub fn desktop_logout(provider: String) -> Result<DesktopAuthState, String> {
    kordi_cli::login::remove_auth(&provider).map_err(|err| err.to_string())?;
    Ok(build_auth_state())
}

#[tauri::command]
pub fn desktop_remove_auth_profile(
    provider: String,
    profile_id: String,
) -> Result<DesktopAuthState, String> {
    let removed = kordi_cli::login::remove_auth_profile(&provider, &profile_id)
        .map_err(|err| err.to_string())?;
    if !removed {
        return Err(format!("Unknown auth profile for {provider}"));
    }
    Ok(build_auth_state())
}

#[tauri::command]
pub fn desktop_set_active_auth_profile(
    provider: String,
    profile_id: String,
) -> Result<DesktopAuthState, String> {
    let selected = kordi_cli::login::set_active_auth_profile(&provider, &profile_id)
        .map_err(|err| err.to_string())?;
    if !selected {
        return Err(format!("Unknown auth profile for {provider}"));
    }
    Ok(build_auth_state())
}

#[tauri::command]
pub fn desktop_set_active_auth_choice(
    provider: String,
    choice: String,
) -> Result<DesktopAuthState, String> {
    let selected = kordi_cli::login::set_active_auth_choice(&provider, &choice)
        .map_err(|err| err.to_string())?;
    if !selected {
        return Err(format!("Unknown auth choice for {provider}: {choice}"));
    }
    Ok(build_auth_state())
}

#[tauri::command]
pub async fn desktop_start_oauth_login(
    provider: String,
    authority: Option<String>,
    manager: State<'_, DesktopAuthManager>,
) -> Result<DesktopAuthAttemptSnapshot, String> {
    let provider = kordi_cli::login::provider_oauth_variant(&provider)
        .unwrap_or(&provider)
        .to_string();
    if kordi_cli::login::provider_oauth_variant(&provider).is_none() && provider != "github-copilot" && provider != "anthropic" && provider != "openai-codex" {
        return Err(format!("OAuth is not available for {provider}"));
    }

    if provider == "github-copilot" {
        if let Some(authority) = authority {
            let authority =
                kordi_cli::login::normalize_github_domain(&authority).map_err(|err| err.to_string())?;
            kordi_cli::login::save_github_copilot_config(&authority)
                .map_err(|err| err.to_string())?;
        }
    }

    let attempt_id = uuid::Uuid::new_v4().to_string();
    let can_paste_callback = provider != "github-copilot";
    let snapshot = Arc::new(Mutex::new(DesktopAuthAttemptSnapshot {
        id: attempt_id.clone(),
        provider: provider.clone(),
        status: "starting".to_string(),
        message: format!("Starting {} sign-in…", kordi_cli::login::provider_display_name(&provider)),
        auth_url: None,
        browser_opened: false,
        verification_url: None,
        user_code: None,
        can_paste_callback,
        completed: false,
        succeeded: false,
        error: None,
    }));
    let (manual_tx, manual_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    {
        let mut attempts = manager.attempts.lock().await;
        attempts.insert(
            attempt_id.clone(),
            DesktopAuthAttemptHandle {
                manual_tx,
                snapshot: snapshot.clone(),
            },
        );
    }

    tokio::spawn({
        let provider = provider.clone();
        let snapshot = snapshot.clone();
        async move {
            let callbacks = kordi_cli::oauth::OAuthCallbacks {
                on_auth: Box::new({
                    let snapshot = snapshot.clone();
                    move |url| {
                        let opened = kordi_cli::login::try_open_browser(&url);
                        update_attempt(&snapshot, |state| {
                            state.status = "waiting_browser".to_string();
                            state.message = if opened {
                                "A browser should open locally. Finish sign-in there, then come back if we need the callback URL.".to_string()
                            } else {
                                "Open the sign-in URL in your browser, then come back here.".to_string()
                            };
                            state.auth_url = Some(url);
                            state.browser_opened = opened;
                        });
                    }
                }),
                on_device_code: Some(Box::new({
                    let snapshot = snapshot.clone();
                    move |device| {
                        update_attempt(&snapshot, |state| {
                            state.status = "waiting_device".to_string();
                            state.message = format!("Open {} and enter code {}", device.verification_uri, device.user_code);
                            state.verification_url = Some(device.verification_uri);
                            state.user_code = Some(device.user_code);
                        });
                    }
                })),
                on_manual_input: Some(manual_rx),
                on_progress: Some(Box::new({
                    let snapshot = snapshot.clone();
                    move |msg| {
                        update_attempt(&snapshot, |state| {
                            state.status = if msg.contains("Exchanging") {
                                "exchanging".to_string()
                            } else {
                                "waiting".to_string()
                            };
                            state.message = msg;
                        });
                    }
                })),
            };

            let result = kordi_cli::login::run_oauth_login(&provider, callbacks).await;
            match result {
                Ok(()) => update_attempt(&snapshot, |state| {
                    state.status = "succeeded".to_string();
                    state.message = format!("Logged in to {}", kordi_cli::login::provider_display_name(&provider));
                    state.completed = true;
                    state.succeeded = true;
                    state.error = None;
                }),
                Err(err) => update_attempt(&snapshot, |state| {
                    state.status = "failed".to_string();
                    state.message = "Authentication failed".to_string();
                    state.completed = true;
                    state.succeeded = false;
                    state.error = Some(err.to_string());
                }),
            }
        }
    });

    snapshot_attempt(&snapshot)
}

#[tauri::command]
pub async fn desktop_auth_attempt_state(
    attempt_id: String,
    manager: State<'_, DesktopAuthManager>,
) -> Result<DesktopAuthAttemptSnapshot, String> {
    let attempts = manager.attempts.lock().await;
    let attempt = attempts
        .get(&attempt_id)
        .ok_or_else(|| format!("Unknown auth attempt: {attempt_id}"))?;
    snapshot_attempt(&attempt.snapshot)
}

#[tauri::command]
pub async fn desktop_submit_auth_manual_input(
    attempt_id: String,
    value: String,
    manager: State<'_, DesktopAuthManager>,
) -> Result<DesktopAuthAttemptSnapshot, String> {
    let attempts = manager.attempts.lock().await;
    let attempt = attempts
        .get(&attempt_id)
        .ok_or_else(|| format!("Unknown auth attempt: {attempt_id}"))?;
    attempt
        .manual_tx
        .send(value)
        .map_err(|_| "Auth attempt is no longer accepting input".to_string())?;
    snapshot_attempt(&attempt.snapshot)
}

#[tauri::command]
pub async fn desktop_cancel_auth_attempt(
    attempt_id: String,
    manager: State<'_, DesktopAuthManager>,
) -> Result<DesktopAuthAttemptSnapshot, String> {
    let attempts = manager.attempts.lock().await;
    let attempt = attempts
        .get(&attempt_id)
        .ok_or_else(|| format!("Unknown auth attempt: {attempt_id}"))?;
    let _ = attempt.manual_tx.send(String::new());
    update_attempt(&attempt.snapshot, |state| {
        state.status = "cancelled".to_string();
        state.message = "Authentication cancelled".to_string();
        state.completed = true;
        state.succeeded = false;
    });
    snapshot_attempt(&attempt.snapshot)
}
