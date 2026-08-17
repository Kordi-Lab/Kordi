use serde_json::json;

use super::ensure_auth_store_readable;

pub(crate) fn desktop_cloud_provider_auth_snapshot_payload(
    provider: Option<String>,
    auth_choice: Option<String>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    ensure_auth_store_readable()?;
    let provider = provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("openai");
    let auth = match auth_choice
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(choice) => kordi_cli::login::resolve_provider_runtime_auth_choice(provider, choice)
            .ok_or_else(|| {
                format!("Could not resolve local auth choice {choice} for {provider}")
            })?,
        None => kordi_cli::login::resolve_provider_auth(provider)
            .ok_or_else(|| format!("Could not resolve local auth for {provider}"))?,
    };
    let model = cloud_provider_auth_snapshot_model(model.as_deref());
    let (provider, auth_choice, payload) = match auth.method {
        kordi_cli::login::ProviderAuthMethod::ApiKey => (
            auth.credential_provider.clone(),
            "local-active-api-key".to_string(),
            json!({ "apiKey": auth.credential, "model": model }),
        ),
        kordi_cli::login::ProviderAuthMethod::OAuth => match auth.credential_provider.as_str() {
            "openai-codex" => (
                "openai-codex".to_string(),
                "local-active-oauth".to_string(),
                json!({
                    "apiMode": "openai-codex-oauth",
                    "accessToken": auth.credential,
                    "accountId": auth.account_id,
                    "model": model,
                }),
            ),
            "anthropic-oauth" => (
                "anthropic".to_string(),
                "local-active-oauth".to_string(),
                json!({
                    "apiMode": "anthropic-oauth",
                    "accessToken": auth.credential,
                    "model": model,
                }),
            ),
            other => {
                return Err(format!(
                    "Cloud fallback provider-auth sync does not support OAuth credentials from {other}"
                ));
            }
        },
    };
    Ok(json!({
        "provider": provider,
        "authChoice": auth_choice,
        "payload": payload,
    }))
}

pub(crate) fn cloud_provider_auth_snapshot_model(model: Option<&str>) -> String {
    model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(kordi_core::agent_session::DEFAULT_OPENAI_MODEL_ID)
        .to_string()
}
