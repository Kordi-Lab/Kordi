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
        .unwrap_or_else(|| "gpt-5.5".to_string());

    let (provider, auth_choice, payload) = match auth.method {
        ProviderAuthMethod::ApiKey => (
            auth.credential_provider.clone(),
            "local-active-api-key".to_string(),
            json!({
                "apiKey": auth.credential,
                "model": model,
            }),
        ),
        ProviderAuthMethod::OAuth => {
            if auth.credential_provider != "openai-codex" {
                bail!(
                    "real-provider canary only supports OpenAI OAuth right now; resolved {}",
                    auth.credential_provider
                );
            }
            (
                "openai-codex".to_string(),
                "local-active-oauth".to_string(),
                json!({
                    "apiMode": "openai-codex-oauth",
                    "accessToken": auth.credential,
                    "accountId": auth.account_id,
                    "model": model,
                }),
            )
        }
    };

    let body = json!({
        "provider": provider,
        "authChoice": auth_choice,
        "payload": payload,
    });
    println!("{}", serde_json::to_string(&body)?);
    Ok(())
}
