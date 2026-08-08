use serde_json::json;
use sha2::{Digest, Sha256};

#[tauri::command]
pub fn desktop_cloud_provider_auth_snapshot_payload(
    account_id: String,
    provider: Option<String>,
    auth_choice: Option<String>,
    model: Option<String>,
    active: Option<bool>,
) -> Result<serde_json::Value, String> {
    let active_account = crate::cloud_account_paths::cloud_account_storage_current()?
        .ok_or_else(|| "Cloud account storage is not active".to_string())?;
    if active_account.account_id != account_id.trim() {
        return Err("Cloud provider-auth sync account does not match active storage".to_string());
    }
    crate::auth::ensure_auth_store_readable()?;
    let provider = provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("openai");
    let requested_auth_choice = auth_choice
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let resolver_auth_choice = explicit_auth_choice(requested_auth_choice.as_deref());
    let auth = match resolver_auth_choice {
        Some(choice) => kordi_cli::login::resolve_provider_auth_choice(provider, choice)
            .ok_or_else(|| {
                format!("Could not resolve local auth choice {choice} for {provider}")
            })?,
        None => kordi_cli::login::resolve_provider_auth(provider)
            .ok_or_else(|| format!("Could not resolve local auth for {provider}"))?,
    };
    let model = snapshot_model(provider, model.as_deref());
    let cloud_oauth = matches!(auth.method, kordi_cli::login::ProviderAuthMethod::OAuth)
        .then(|| kordi_cli::login::cloud_oauth_snapshot_credentials(provider, resolver_auth_choice))
        .flatten();
    let snapshot_auth_choice = requested_auth_choice.unwrap_or_else(|| match auth.method {
        kordi_cli::login::ProviderAuthMethod::ApiKey => "local-active-api-key".to_string(),
        kordi_cli::login::ProviderAuthMethod::OAuth => "local-active-oauth".to_string(),
    });
    let (provider, auth_choice, payload) = match auth.method {
        kordi_cli::login::ProviderAuthMethod::ApiKey => (
            auth.credential_provider.clone(),
            snapshot_auth_choice.clone(),
            json!({
                "apiKey": auth.credential,
                "model": model,
                "syncActive": active.unwrap_or(false),
            }),
        ),
        kordi_cli::login::ProviderAuthMethod::OAuth => match auth.credential_provider.as_str() {
            "openai-codex" => (
                "openai-codex".to_string(),
                snapshot_auth_choice.clone(),
                json!({
                    "apiMode": "openai-codex-oauth",
                    "accessToken": auth.credential,
                    "refreshToken": cloud_oauth.as_ref().and_then(|value| value.refresh_token.clone()),
                    "expiresAt": cloud_oauth.as_ref().map(|value| value.access_expires_at_ms),
                    "accountId": auth.account_id,
                    "accountLabel": auth.account_label,
                    "model": model,
                    "syncActive": active.unwrap_or(false),
                }),
            ),
            "anthropic-oauth" => (
                "anthropic".to_string(),
                snapshot_auth_choice.clone(),
                json!({
                    "apiMode": "anthropic-oauth",
                    "accessToken": auth.credential,
                    "refreshToken": cloud_oauth.as_ref().and_then(|value| value.refresh_token.clone()),
                    "expiresAt": cloud_oauth.as_ref().map(|value| value.access_expires_at_ms),
                    "accountLabel": auth.account_label,
                    "model": model,
                    "syncActive": active.unwrap_or(false),
                }),
            ),
            "github-copilot" => (
                "github-copilot".to_string(),
                snapshot_auth_choice,
                json!({
                    "apiMode": "github-copilot-oauth",
                    "accessToken": auth.credential,
                    "refreshToken": cloud_oauth.as_ref().and_then(|value| value.refresh_token.clone()),
                    "githubAccessToken": cloud_oauth.as_ref().map(|value| value.access_token.clone()),
                    "githubAccessExpiresAt": cloud_oauth.as_ref().map(|value| value.access_expires_at_ms),
                    "runtimeExpiresAt": cloud_oauth.as_ref().and_then(|value| value.runtime_expires_at_ms),
                    "accountLabel": auth.account_label,
                    "authority": auth.authority,
                    "baseUrl": kordi_cli::login::github_copilot_api_base_url(),
                    "headers": kordi_cli::login::github_copilot_runtime_headers(),
                    "model": model,
                    "syncActive": active.unwrap_or(false),
                }),
            ),
            resolved => {
                return Err(format!(
                    "Cloud fallback provider-auth sync does not support OAuth provider {resolved}"
                ));
            }
        },
    };
    let credential_revision = credential_revision(&provider, &auth_choice, &payload);

    Ok(json!({
        "provider": provider,
        "authChoice": auth_choice,
        "payload": payload,
        "credentialRevision": credential_revision,
    }))
}

fn explicit_auth_choice(auth_choice: Option<&str>) -> Option<&str> {
    auth_choice
        .map(str::trim)
        .filter(|choice| choice.starts_with("profile:") || choice.starts_with("env:"))
}

fn credential_revision(provider: &str, auth_choice: &str, payload: &serde_json::Value) -> String {
    let mut hasher = Sha256::new();
    for value in [provider, auth_choice] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    hasher.update(serde_json::to_vec(payload).unwrap_or_default());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn snapshot_model(provider: &str, model: Option<&str>) -> String {
    model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| kordi_core::agent_session::parse_model_arg(Some(provider), None).1)
}

#[cfg(test)]
mod tests {
    use super::{credential_revision, explicit_auth_choice, snapshot_model};

    #[test]
    fn legacy_default_resolves_through_active_auth() {
        assert_eq!(explicit_auth_choice(Some("default")), None);
        assert_eq!(explicit_auth_choice(Some("local-active-oauth")), None);
        assert_eq!(
            explicit_auth_choice(Some("profile:one")),
            Some("profile:one")
        );
        assert_eq!(
            explicit_auth_choice(Some("env:api-key")),
            Some("env:api-key")
        );
    }

    #[test]
    fn snapshot_uses_provider_specific_default() {
        assert_eq!(snapshot_model("openai", None), "gpt-5.6-sol");
        assert_eq!(snapshot_model("anthropic", None), "claude-opus-4-6");
        assert_eq!(snapshot_model("github-copilot", None), "gpt-5.4");
        assert_eq!(snapshot_model("openai", Some("gpt-5.4")), "gpt-5.4");
    }

    #[test]
    fn revision_changes_with_route_or_credential() {
        let payload = serde_json::json!({
            "accessToken": "access-one",
            "refreshToken": "refresh-one",
            "model": "claude-opus-4-8",
            "syncActive": true,
        });
        let first = credential_revision("anthropic", "profile:one", &payload);
        let same = credential_revision("anthropic", "profile:one", &payload);
        let refreshed = credential_revision(
            "anthropic",
            "profile:one",
            &serde_json::json!({ "refreshToken": "refresh-two" }),
        );
        let inactive = credential_revision(
            "anthropic",
            "profile:one",
            &serde_json::json!({ "syncActive": false }),
        );
        assert_eq!(first, same);
        assert_ne!(first, refreshed);
        assert_ne!(first, inactive);
        assert_eq!(first.len(), 64);
    }
}
