use std::fmt;

use serde::Serialize;
use serde_json::Value;

use crate::service_model::ServiceCredential;

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
    pub(crate) credential: &'a ServiceCredential,
    pub base_url: &'a str,
    pub model: &'a str,
    /// When set, the credential only serves runs whose id starts with this
    /// prefix. The System agent's key belongs to its own sweep runs, never to
    /// an ordinary agent run that happens to be owned by its account.
    pub run_id_prefix: Option<&'a str>,
}

impl ServiceProviderAuth<'_> {
    pub fn covers_run(&self, run_id: &str) -> bool {
        self.run_id_prefix
            .is_none_or(|prefix| run_id.starts_with(prefix))
    }

    pub(crate) fn matches_run(&self, owner: &str, run_id: &str, route: &Value) -> bool {
        self.owner_account_id == owner
            && self.covers_run(run_id)
            && equivalent_provider_ids(route.get("defaultAuthProvider").and_then(Value::as_str))
                .is_some_and(|providers| providers.iter().any(|provider| provider == self.provider))
            && route
                .get("defaultAuthChoice")
                .and_then(Value::as_str)
                .map(str::trim)
                == Some(self.auth_choice)
    }
}

pub(super) async fn service_provider_auth_for_run(
    owner_account_id: &str,
    run_id: &str,
    runtime_route: &Value,
    service_auths: Vec<ServiceProviderAuth<'_>>,
) -> Result<Option<RunnerProviderAuthMaterial>, sqlx_core::Error> {
    let Some(service_auth) = service_auths
        .into_iter()
        .find(|auth| auth.matches_run(owner_account_id, run_id, runtime_route))
    else {
        return Ok(None);
    };
    // Admission happens before any access to Google workload credentials. A
    // refresh failure must not fall through to a member's saved account.
    let token = service_auth
        .credential
        .bearer_token()
        .await
        .map_err(|message| sqlx_core::Error::Protocol(message.to_string()))?;

    Ok(Some(RunnerProviderAuthMaterial {
        snapshot_id: service_auth.snapshot_id.to_string(),
        provider: service_auth.provider.to_string(),
        auth_choice: service_auth.auth_choice.to_string(),
        payload: serde_json::json!({
            "apiKey": token,
            "baseUrl": service_auth.base_url,
            "model": service_auth.model,
        }),
    }))
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

    #[tokio::test]
    async fn a_prefixed_service_key_only_serves_its_own_runs() {
        let route = serde_json::json!({
            "defaultAuthProvider": "openai",
            "defaultAuthChoice": "pip-service-api-key",
        });
        let credential = ServiceCredential::ApiKey("secret-system-agent-key".to_string());
        let system_agent_key = || ServiceProviderAuth {
            owner_account_id: "acct_kordi_pip",
            snapshot_id: "pip-service-openai",
            provider: "openai",
            auth_choice: "pip-service-api-key",
            credential: &credential,
            base_url: "https://api.openai.com/v1",
            model: "gpt",
            run_id_prefix: Some("pip_"),
        };
        assert!(service_provider_auth_for_run(
            "acct_kordi_pip",
            "pip_123",
            &route,
            vec![system_agent_key()]
        )
        .await
        .unwrap()
        .is_some());
        assert!(service_provider_auth_for_run(
            "acct_kordi_pip",
            "run_from_a_member",
            &route,
            vec![system_agent_key()]
        )
        .await
        .unwrap()
        .is_none());
    }
    struct CountingTokenSource(std::sync::atomic::AtomicUsize);

    #[async_trait::async_trait]
    impl crate::service_model::ServiceTokenSource for CountingTokenSource {
        async fn access_token(&self) -> Result<String, &'static str> {
            let n = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 2 {
                return Err("synthetic refresh failure");
            }
            Ok(format!("short-lived-token-{n}"))
        }
    }

    #[tokio::test]
    async fn google_token_resolution_is_scoped_and_refresh_failures_are_closed() {
        let source =
            std::sync::Arc::new(CountingTokenSource(std::sync::atomic::AtomicUsize::new(0)));
        let credential = ServiceCredential::GoogleCloud(source.clone());
        let endpoint = "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi";
        let auth = || ServiceProviderAuth {
            owner_account_id: "service-owner",
            snapshot_id: "pip-service-vertex",
            provider: "vertex-ai",
            auth_choice: "pip-service-google-cloud",
            credential: &credential,
            base_url: endpoint,
            model: "google/synthetic-model",
            run_id_prefix: Some("cg_"),
        };
        let route = serde_json::json!({
            "defaultAuthProvider": "vertex-ai",
            "defaultAuthChoice": "pip-service-google-cloud",
        });
        for (owner, run_id, candidate_route) in [
            ("member", "cg_123", route.clone()),
            ("service-owner", "user_run", route.clone()),
            (
                "service-owner",
                "cg_123",
                serde_json::json!({"defaultAuthProvider":"openai", "defaultAuthChoice":"pip-service-google-cloud"}),
            ),
            (
                "service-owner",
                "cg_123",
                serde_json::json!({"defaultAuthProvider":"vertex-ai", "defaultAuthChoice":"user-snapshot"}),
            ),
        ] {
            assert!(
                service_provider_auth_for_run(owner, run_id, &candidate_route, vec![auth()])
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(source.0.load(std::sync::atomic::Ordering::SeqCst), 0);
        for n in 0..2 {
            let material =
                service_provider_auth_for_run("service-owner", "cg_123", &route, vec![auth()])
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(material.payload["apiKey"], format!("short-lived-token-{n}"));
            assert!(material.payload.get("refreshToken").is_none());
            assert!(!format!("{material:?}").contains("short-lived-token"));
        }
        assert!(
            service_provider_auth_for_run("service-owner", "cg_123", &route, vec![auth()])
                .await
                .is_err()
        );
    }
}
