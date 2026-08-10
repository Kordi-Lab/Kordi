use kordi_cli::login::{ProviderAuthMethod, ResolvedProviderAuth};
use serde_json::json;

pub(super) fn payload_from_resolved(
    auth: ResolvedProviderAuth,
    model: String,
) -> Result<serde_json::Value, String> {
    let (provider, auth_choice, payload) = match auth.method {
        ProviderAuthMethod::ApiKey => (
            auth.credential_provider.clone(),
            "local-active-api-key".to_string(),
            json!({ "apiKey": auth.credential, "model": model }),
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
            "anthropic" | "anthropic-oauth" => (
                "anthropic".to_string(),
                "local-active-oauth".to_string(),
                json!({
                    "apiMode": "anthropic-oauth",
                    "accessToken": auth.credential,
                    "model": model,
                }),
            ),
            _ => {
                return Err(format!(
                    "Cloud fallback does not support OAuth for provider {}",
                    auth.credential_provider
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

pub(super) fn snapshot_model(model: Option<&str>) -> String {
    model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(kordi_core::agent_session::DEFAULT_OPENAI_MODEL_ID)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_cli::login::AuthSource;

    #[test]
    fn snapshot_uses_root_openai_default() {
        assert_eq!(snapshot_model(None), "gpt-5.6-sol");
        assert_eq!(snapshot_model(Some("gpt-5.4")), "gpt-5.4");
    }

    #[test]
    fn anthropic_oauth_snapshot_is_explicitly_routed_to_anthropic() {
        let payload = payload_from_resolved(
            ResolvedProviderAuth {
                source: AuthSource::KordiAuth,
                credential_provider: "anthropic-oauth".to_string(),
                method: ProviderAuthMethod::OAuth,
                credential: "provider-token".to_string(),
                account_id: None,
                account_label: None,
                authority: None,
            },
            "anthropic/claude-opus-4-8".to_string(),
        )
        .unwrap();

        assert_eq!(payload["provider"], "anthropic");
        assert_eq!(payload["authChoice"], "local-active-oauth");
        assert_eq!(payload["payload"]["apiMode"], "anthropic-oauth");
        assert_eq!(payload["payload"]["accessToken"], "provider-token");
    }
}
