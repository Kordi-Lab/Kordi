use std::fmt;

use serde::Serialize;
use serde_json::Value;

use super::provider_family::equivalent_provider_ids;
#[derive(Debug, Serialize)]
pub struct RunnerProviderAuthMaterialEnvelope {
    #[serde(rename = "providerAuth")]
    pub provider_auth: RunnerProviderAuthMaterial,
}

#[derive(Serialize)]
pub struct RunnerProviderAuthMaterial {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub payload: Value,
}

pub struct ServiceProviderAuth<'a> {
    pub owner_account_id: &'a str,
    pub snapshot_id: &'a str,
    pub provider: &'a str,
    pub auth_choice: &'a str,
    pub api_key: &'a str,
    pub base_url: &'a str,
    pub model: &'a str,
}

pub(super) fn service_provider_auth_for_run(
    owner_account_id: &str,
    runtime_route: &Value,
    service_auth: Option<ServiceProviderAuth<'_>>,
) -> Option<RunnerProviderAuthMaterial> {
    let routed_provider_ids = equivalent_provider_ids(
        runtime_route
            .get("defaultAuthProvider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    );
    let routed_auth_choice = runtime_route
        .get("defaultAuthChoice")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let service_auth = service_auth.filter(|service_auth| {
        service_auth.owner_account_id == owner_account_id
            && routed_provider_ids.as_ref().is_some_and(|providers| {
                providers
                    .iter()
                    .any(|provider| provider == service_auth.provider)
            })
            && routed_auth_choice == Some(service_auth.auth_choice)
    })?;

    Some(RunnerProviderAuthMaterial {
        snapshot_id: service_auth.snapshot_id.to_string(),
        provider: service_auth.provider.to_string(),
        auth_choice: service_auth.auth_choice.to_string(),
        payload: serde_json::json!({
            "apiKey": service_auth.api_key,
            "baseUrl": service_auth.base_url,
            "model": service_auth.model,
        }),
    })
}

impl fmt::Debug for RunnerProviderAuthMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerProviderAuthMaterial")
            .field("snapshot_id", &self.snapshot_id)
            .field("provider", &self.provider)
            .field("auth_choice", &self.auth_choice)
            .field("payload", &"[REDACTED]")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_provider_auth_debug_redacts_secret_payloads() {
        let material = RunnerProviderAuthMaterial {
            snapshot_id: "support-service-openai".to_string(),
            provider: "openai".to_string(),
            auth_choice: "support-service-api-key".to_string(),
            payload: serde_json::json!({"apiKey":"secret-support-key"}),
        };

        let debug = format!("{material:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains("secret-support-key"));
    }
}
