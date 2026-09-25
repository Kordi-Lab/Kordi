//! GitHub Copilot credential resolution and Copilot runtime session exchange.

use super::*;

pub(super) fn resolve_github_copilot_env_auth() -> Option<ResolvedProviderAuth> {
    for key in ["GH_COPILOT_TOKEN", "GITHUB_COPILOT_TOKEN"] {
        if let Ok(val) = std::env::var(key)
            && !val.trim().is_empty()
        {
            return Some(ResolvedProviderAuth {
                source: AuthSource::EnvVar,
                credential_provider: "github-copilot".to_string(),
                method: ProviderAuthMethod::OAuth,
                credential: val,
                account_id: None,
                account_label: None,
                authority: None,
            });
        }
    }
    None
}

pub(super) fn resolve_github_copilot_profile_auth(
    profile: &AuthProfile,
) -> Option<ResolvedProviderAuth> {
    let AuthEntry::OAuth {
        access,
        refresh,
        expires,
        extra,
    } = profile.entry.clone()
    else {
        return None;
    };

    let authority = extra
        .get("domain")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .or_else(github_copilot_domain)
        .unwrap_or_else(|| "github.com".to_string());
    let account_label = extra
        .get("login")
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let now_ms = chrono::Utc::now().timestamp_millis();

    if let Some(token) = extra.get("copilot_token").and_then(|value| value.as_str())
        && let Some(expires_at) = extra
            .get("copilot_expires_at")
            .and_then(|value| value.as_i64())
        && expires_at > now_ms + 300_000
        && !token.trim().is_empty()
    {
        return Some(ResolvedProviderAuth {
            source: AuthSource::KordiAuth,
            credential_provider: "github-copilot".to_string(),
            method: ProviderAuthMethod::OAuth,
            credential: token.to_string(),
            account_id: None,
            account_label,
            authority: Some(authority),
        });
    }

    if expires <= now_ms + 60_000
        && !refresh.trim().is_empty()
        && let Some(token) = try_refresh_sync("github-copilot", &refresh)
    {
        return Some(ResolvedProviderAuth {
            source: AuthSource::KordiAuth,
            credential_provider: "github-copilot".to_string(),
            method: ProviderAuthMethod::OAuth,
            credential: token,
            account_id: None,
            account_label,
            authority: Some(authority),
        });
    }

    if access.trim().is_empty() {
        return None;
    }

    let refreshed = refresh_github_copilot_runtime_sync(&authority, &access)?;
    let mut extra = extra;
    merge_github_copilot_runtime_extra(&mut extra, &authority, &refreshed);
    let _ = save_oauth_state("github-copilot", access, refresh, expires, extra);
    Some(ResolvedProviderAuth {
        source: AuthSource::KordiAuth,
        credential_provider: "github-copilot".to_string(),
        method: ProviderAuthMethod::OAuth,
        credential: refreshed.copilot_token,
        account_id: None,
        account_label: refreshed.login.clone(),
        authority: Some(authority),
    })
}

pub(super) fn resolve_github_copilot_auth() -> Option<ResolvedProviderAuth> {
    resolve_github_copilot_env_auth().or_else(|| {
        let store = load_auth();
        let profile =
            stored_auth_profile_for_method(&store, "github-copilot", ProviderAuthMethod::OAuth)?;
        resolve_github_copilot_profile_auth(profile)
    })
}

fn merge_github_copilot_runtime_extra(
    extra: &mut serde_json::Value,
    authority: &str,
    runtime: &crate::oauth::github_copilot::CopilotRuntimeSession,
) {
    let mut map = extra.as_object().cloned().unwrap_or_default();
    map.insert(
        "domain".to_string(),
        serde_json::Value::String(authority.to_string()),
    );
    map.insert(
        "login".to_string(),
        runtime
            .login
            .as_ref()
            .map(|value| serde_json::Value::String(value.clone()))
            .unwrap_or(serde_json::Value::Null),
    );
    map.insert(
        "copilot_token".to_string(),
        serde_json::Value::String(runtime.copilot_token.clone()),
    );
    map.insert(
        "copilot_expires_at".to_string(),
        serde_json::Value::Number(runtime.copilot_expires_at_ms.into()),
    );
    map.insert(
        "copilot_api_base_url".to_string(),
        serde_json::Value::String(runtime.api_base_url.clone()),
    );
    map.insert(
        "copilot_models".to_string(),
        serde_json::Value::Array(
            runtime
                .models
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    map.insert(
        "organization_list".to_string(),
        serde_json::Value::Array(
            runtime
                .organization_list
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    map.insert(
        "enterprise_list".to_string(),
        serde_json::Value::Array(
            runtime
                .enterprise_list
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    map.insert(
        "sku".to_string(),
        runtime
            .sku
            .as_ref()
            .map(|value| serde_json::Value::String(value.clone()))
            .unwrap_or(serde_json::Value::Null),
    );
    map.insert(
        "copilot_endpoints".to_string(),
        serde_json::to_value(runtime.raw_endpoints.clone()).unwrap_or(serde_json::Value::Null),
    );
    *extra = serde_json::Value::Object(map);
}

fn refresh_github_copilot_runtime_sync(
    authority: &str,
    github_access_token: &str,
) -> Option<crate::oauth::github_copilot::CopilotRuntimeSession> {
    let rt = match tokio::runtime::Handle::try_current() {
        Ok(_handle) => {
            let authority = authority.to_string();
            let github_access_token = github_access_token.to_string();
            return std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().ok()?;
                rt.block_on(
                    crate::oauth::github_copilot::exchange_github_token_for_copilot_session(
                        &authority,
                        &github_access_token,
                    ),
                )
                .ok()
            })
            .join()
            .ok()
            .flatten();
        }
        Err(_) => tokio::runtime::Runtime::new().ok()?,
    };
    rt.block_on(
        crate::oauth::github_copilot::exchange_github_token_for_copilot_session(
            authority,
            github_access_token,
        ),
    )
    .ok()
}
