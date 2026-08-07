use anyhow::{bail, Context, Result};
use kordi_cli::login::{self, ProviderAuthMethod};
use serde_json::json;

fn main() -> Result<()> {
    let provider = std::env::var("KORDI_CLOUD_REAL_PROVIDER_PROVIDER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "openai".to_string());
    let auth = match std::env::var("KORDI_CLOUD_REAL_PROVIDER_AUTH_CHOICE")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        Some(choice) => {
            login::resolve_provider_auth_choice(&provider, &choice).with_context(|| {
                format!("could not resolve local auth choice {choice} for {provider}")
            })?
        }
        None => login::resolve_provider_auth(&provider)
            .with_context(|| format!("could not resolve local auth for {provider}"))?,
    };

    let model = std::env::var("KORDI_CLOUD_REAL_PROVIDER_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| kordi_core::agent_session::parse_model_arg(Some(&provider), None).1);

    let (provider, auth_choice, payload) = match auth.method {
        ProviderAuthMethod::ApiKey => (
            auth.credential_provider.clone(),
            "local-active-api-key".to_string(),
            json!({
                "apiKey": auth.credential,
                "model": model,
            }),
        ),
        ProviderAuthMethod::OAuth => match auth.credential_provider.as_str() {
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
                    "accountLabel": auth.account_label,
                    "model": model,
                }),
            ),
            "github-copilot" => (
                "github-copilot".to_string(),
                "local-active-oauth".to_string(),
                json!({
                    "apiMode": "github-copilot-oauth",
                    "accessToken": auth.credential,
                    "accountLabel": auth.account_label,
                    "authority": auth.authority,
                    "baseUrl": login::github_copilot_api_base_url(),
                    "headers": login::github_copilot_runtime_headers(),
                    "model": model,
                }),
            ),
            resolved => bail!("real-provider canary does not support OAuth provider {resolved}"),
        },
    };

    let body = json!({
        "provider": provider,
        "authChoice": auth_choice,
        "payload": payload,
    });
    println!("{}", serde_json::to_string(&body)?);
    Ok(())
}
