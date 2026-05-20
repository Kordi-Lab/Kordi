use serde_json::Value;

#[derive(Clone, Debug)]
pub struct CloudFallbackAuthSnapshot {
    pub format_version: i32,
    pub auth_json: Value,
    pub active_provider: Option<String>,
    pub active_profile_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudFallbackRuntimeProfile {
    pub provider: String,
    pub profile_id: Option<String>,
    pub local_device_tools_enabled: bool,
    pub execution_mode: kordi_tools::ToolExecutionMode,
    pub execution_policy: kordi_tools::ExecutionPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloudFallbackRuntimeError {
    InvalidFormatVersion,
    InvalidAuthJson,
    MissingProvider,
}

fn clean_text(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn active_profile_from_auth_json(auth_json: &Value, provider: &str) -> Option<String> {
    auth_json
        .get("active_auth_profiles")
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(provider))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub fn build_cloud_fallback_runtime_profile(
    snapshot: CloudFallbackAuthSnapshot,
) -> Result<CloudFallbackRuntimeProfile, CloudFallbackRuntimeError> {
    if snapshot.format_version <= 0 {
        return Err(CloudFallbackRuntimeError::InvalidFormatVersion);
    }
    if !snapshot.auth_json.is_object() {
        return Err(CloudFallbackRuntimeError::InvalidAuthJson);
    }
    let provider = clean_text(snapshot.active_provider)
        .or_else(|| {
            snapshot
                .auth_json
                .get("last_provider")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .ok_or(CloudFallbackRuntimeError::MissingProvider)?;
    let profile_id = clean_text(snapshot.active_profile_id)
        .or_else(|| active_profile_from_auth_json(&snapshot.auth_json, &provider));

    Ok(CloudFallbackRuntimeProfile {
        provider,
        profile_id,
        local_device_tools_enabled: false,
        execution_mode: kordi_tools::ToolExecutionMode::NonInteractive,
        execution_policy: kordi_tools::ExecutionPolicy::Safety,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_runtime_profile_from_local_auth_json_shape() {
        let profile = build_cloud_fallback_runtime_profile(CloudFallbackAuthSnapshot {
            format_version: 2,
            auth_json: json!({
                "version": 2,
                "profiles": {
                    "openai": [{ "id": "profile-openai", "type": "api_key", "key": "sk-test" }]
                },
                "active_auth_profiles": { "openai": "profile-openai" },
                "active_auth_methods": { "openai": "api_key" }
            }),
            active_provider: Some("openai".to_string()),
            active_profile_id: None,
        })
        .expect("local auth json shape should build a fallback profile");

        assert_eq!(profile.provider, "openai");
        assert_eq!(profile.profile_id.as_deref(), Some("profile-openai"));
        assert!(!profile.local_device_tools_enabled);
        assert_eq!(
            profile.execution_mode,
            kordi_tools::ToolExecutionMode::NonInteractive
        );
        assert_eq!(
            profile.execution_policy,
            kordi_tools::ExecutionPolicy::Safety
        );
    }

    #[test]
    fn rejects_missing_provider_choice() {
        let error = build_cloud_fallback_runtime_profile(CloudFallbackAuthSnapshot {
            format_version: 2,
            auth_json: json!({ "version": 2, "profiles": {} }),
            active_provider: None,
            active_profile_id: None,
        })
        .expect_err("fallback runtime must know which provider to use");

        assert_eq!(error, CloudFallbackRuntimeError::MissingProvider);
    }
}
