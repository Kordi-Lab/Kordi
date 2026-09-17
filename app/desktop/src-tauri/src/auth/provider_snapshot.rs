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
    let model = cloud_provider_auth_snapshot_model_for(&auth.credential_provider, model.as_deref());
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

/// The model stored with a cloud sign-in: the requested one when it belongs
/// to the signed-in provider, otherwise that provider's default. An OpenAI
/// model saved with an Anthropic sign-in would make every cloud run fail.
pub(crate) fn cloud_provider_auth_snapshot_model_for(
    credential_provider: &str,
    model: Option<&str>,
) -> String {
    let provider = match credential_provider {
        "anthropic-oauth" => "anthropic",
        other => other,
    };
    let requested = model.map(str::trim).filter(|value| !value.is_empty());
    let family_of = |name: &str| {
        let name = name
            .rsplit_once('/')
            .map(|(_, name)| name)
            .unwrap_or(name)
            .to_ascii_lowercase();
        if name.starts_with("claude") {
            Some("anthropic")
        } else if name.starts_with("gemini") {
            Some("google")
        } else if name.starts_with("gpt-") || name.starts_with("codex") {
            Some("openai")
        } else {
            None
        }
    };
    let provider_family = match provider {
        "anthropic" => Some("anthropic"),
        "google" => Some("google"),
        "openai" | "openai-codex" => Some("openai"),
        _ => None,
    };
    if let Some(requested) = requested {
        if provider_family.is_none()
            || family_of(requested).is_none()
            || family_of(requested) == provider_family
        {
            return requested.to_string();
        }
    }
    let (_, default_model, _) = kordi_core::agent_session::parse_model_arg(Some(provider), None);
    default_model
}

#[cfg(test)]
pub(crate) fn cloud_provider_auth_snapshot_model(model: Option<&str>) -> String {
    model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(kordi_core::agent_session::DEFAULT_OPENAI_MODEL_ID)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::cloud_provider_auth_snapshot_model_for;

    #[test]
    fn cloud_auth_snapshot_model_matches_the_signed_in_provider() {
        assert!(
            cloud_provider_auth_snapshot_model_for("anthropic-oauth", None).starts_with("claude")
        );
        assert!(
            cloud_provider_auth_snapshot_model_for("anthropic", Some("gpt-5.6-sol"))
                .starts_with("claude")
        );
        assert_eq!(
            cloud_provider_auth_snapshot_model_for("anthropic", Some("claude-sonnet-5")),
            "claude-sonnet-5"
        );
        assert_eq!(
            cloud_provider_auth_snapshot_model_for("openai-codex", None),
            "gpt-5.6-sol"
        );
    }
}
