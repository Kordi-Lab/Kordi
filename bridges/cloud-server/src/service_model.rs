//! Authentication for Kordi-operated models. Google credentials stay on the
//! server; runners receive only a short-lived token for an admitted run.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use google_cloud_auth::credentials::{external_account, AccessTokenCredentials};

#[async_trait::async_trait]
pub(crate) trait ServiceTokenSource: Send + Sync {
    async fn access_token(&self) -> Result<String, &'static str>;
}

#[derive(Default)]
struct GoogleTokenSource {
    credentials: Mutex<Option<(Instant, AccessTokenCredentials)>>,
}

#[async_trait::async_trait]
impl ServiceTokenSource for GoogleTokenSource {
    async fn access_token(&self) -> Result<String, &'static str> {
        let mut cached = self.credentials.lock().await;
        if cached
            .as_ref()
            .is_some_and(|(created, _)| cache_needs_refresh(*created, Instant::now()))
        {
            *cached = None;
        }
        if cached.is_none() {
            let path = std::env::var("GOOGLE_APPLICATION_CREDENTIALS")
                .map_err(|_| "Google Cloud workload identity configuration is required")?;
            let contents = tokio::fs::read(path)
                .await
                .map_err(|_| "Google Cloud workload identity configuration is unavailable")?;
            let config: serde_json::Value = serde_json::from_slice(&contents)
                .map_err(|_| "Google Cloud workload identity configuration is invalid")?;
            validate_workload_identity(&config)?;
            let credentials = external_account::Builder::new(config)
                .with_scopes(["https://www.googleapis.com/auth/cloud-platform"])
                .build_access_token_credentials()
                .map_err(|_| "Google Cloud workload identity configuration is invalid")?;
            *cached = Some((Instant::now(), credentials));
        }
        let (_, credentials) = cached
            .as_ref()
            .ok_or("Google Cloud service credentials are unavailable")?;
        let token = tokio::time::timeout(Duration::from_secs(30), credentials.access_token())
            .await
            .map_err(|_| "Google Cloud service authentication timed out")?
            .map_err(|_| "Google Cloud service authentication failed")?;
        if token.token.trim().is_empty() {
            return Err("Google Cloud service authentication returned no access token");
        }
        Ok(token.token)
    }
}

// The SDK requests a one-hour impersonated token. Its normal cache refresh
// begins four minutes before expiry, too late for a ten-minute runner turn.
// Recreate the cache after forty minutes to retain a twenty-minute margin.
fn cache_needs_refresh(created: Instant, now: Instant) -> bool {
    now.saturating_duration_since(created) >= Duration::from_secs(40 * 60)
}

fn validate_workload_identity(config: &serde_json::Value) -> Result<(), &'static str> {
    if config["type"] != "external_account"
        || config["credential_source"]["file"]
            .as_str()
            .is_none_or(str::is_empty)
        || config["token_url"] != "https://sts.googleapis.com/v1/token"
        || !config["service_account_impersonation_url"]
            .as_str()
            .is_some_and(|url| {
                url.starts_with(
                    "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/",
                ) && url.ends_with(":generateAccessToken")
            })
    {
        return Err("Google Cloud services require a file-based workload identity with service account impersonation");
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) enum ServiceCredential {
    ApiKey(String),
    GoogleCloud(Arc<dyn ServiceTokenSource>),
}

impl ServiceCredential {
    pub(crate) fn google_cloud() -> Self {
        Self::GoogleCloud(Arc::new(GoogleTokenSource::default()))
    }

    pub(crate) async fn bearer_token(&self) -> Result<String, &'static str> {
        match self {
            Self::ApiKey(key) => Ok(key.clone()),
            Self::GoogleCloud(source) => source.access_token().await,
        }
    }

    pub(crate) fn validate_configuration(&self) -> Result<(), &'static str> {
        if !self.is_google_cloud() {
            return Ok(());
        }
        let path = std::env::var("GOOGLE_APPLICATION_CREDENTIALS")
            .map_err(|_| "Google Cloud workload identity configuration is required")?;
        let contents = std::fs::read(path)
            .map_err(|_| "Google Cloud workload identity configuration is unavailable")?;
        let config = serde_json::from_slice(&contents)
            .map_err(|_| "Google Cloud workload identity configuration is invalid")?;
        validate_workload_identity(&config)
    }

    pub(crate) fn is_google_cloud(&self) -> bool {
        matches!(self, Self::GoogleCloud(_))
    }

    #[cfg(test)]
    pub(crate) fn api_key(&self) -> &str {
        match self {
            Self::ApiKey(key) => key,
            Self::GoogleCloud(_) => panic!("Google Cloud has no static API key"),
        }
    }
}

impl std::fmt::Debug for ServiceCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ServiceCredential([REDACTED])")
    }
}

/// Builds only Google-controlled endpoints. Project/location values cannot
/// redirect a service token to a caller-supplied host or path.
pub(crate) fn vertex_endpoint(project: &str, location: &str) -> Result<String, &'static str> {
    let valid_component = |value: &str| {
        !value.is_empty()
            && value.len() <= 63
            && value
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
    };
    if !valid_component(project) {
        return Err("KORDI_SERVICE_VERTEX_PROJECT must be a Google Cloud project ID or number");
    }
    if !valid_component(location) {
        return Err("KORDI_SERVICE_VERTEX_LOCATION must be a Google Cloud location");
    }
    let host = if location == "global" {
        "aiplatform.googleapis.com".to_string()
    } else {
        format!("{location}-aiplatform.googleapis.com")
    };
    Ok(format!(
        "https://{host}/v1/projects/{project}/locations/{location}/endpoints/openapi"
    ))
}

pub(crate) fn vertex_configuration(
    get: &mut impl FnMut(&str) -> Option<String>,
    model: Option<String>,
) -> Result<(ServiceCredential, String, String), &'static str> {
    let project = get("KORDI_SERVICE_VERTEX_PROJECT").unwrap_or_default();
    let location = get("KORDI_SERVICE_VERTEX_LOCATION").unwrap_or_else(|| "global".to_string());
    let endpoint = vertex_endpoint(project.trim(), location.trim())?;
    let model = model.unwrap_or_default().trim().to_string();
    if model.is_empty() || model.len() > 200 || model.chars().any(char::is_whitespace) {
        return Err("An explicit Vertex model ID is required for each enabled service");
    }
    Ok((ServiceCredential::google_cloud(), endpoint, model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vertex_endpoint_handles_global_and_regional_locations() {
        assert_eq!(vertex_endpoint("test-project", "global").unwrap(),
            "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi");
        assert_eq!(vertex_endpoint("123456", "us-central1").unwrap(),
            "https://us-central1-aiplatform.googleapis.com/v1/projects/123456/locations/us-central1/endpoints/openapi");
    }

    #[test]
    fn vertex_endpoint_rejects_host_and_path_injection() {
        for invalid in [
            "",
            "../other",
            "project?redirect=1",
            "evil.example",
            "x@host",
            "-bad",
        ] {
            assert!(vertex_endpoint(invalid, "global").is_err());
            assert!(vertex_endpoint("test-project", invalid).is_err());
        }
    }
    #[test]
    fn credential_cache_refreshes_before_the_runner_can_outlive_its_token() {
        let created = Instant::now();
        assert!(!cache_needs_refresh(
            created,
            created + Duration::from_secs(2399)
        ));
        assert!(cache_needs_refresh(
            created,
            created + Duration::from_secs(2400)
        ));
    }

    #[test]
    fn workload_identity_rejects_user_credentials_and_untrusted_token_endpoints() {
        let mut config = serde_json::json!({
            "type": "external_account",
            "credential_source": {"file":"/var/run/workload/token"},
            "token_url": "https://sts.googleapis.com/v1/token",
            "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/test@example.invalid:generateAccessToken",
        });
        assert!(validate_workload_identity(&config).is_ok());
        config["type"] = "authorized_user".into();
        assert!(validate_workload_identity(&config).is_err());
        config["type"] = "external_account".into();
        config["token_url"] = "https://example.invalid/token".into();
        assert!(validate_workload_identity(&config).is_err());
    }
    #[tokio::test]
    async fn workload_identity_sdk_builds_with_the_server_tls_configuration() {
        let config = serde_json::json!({
            "type":"external_account",
            "audience":"//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/test/providers/test",
            "subject_token_type":"urn:ietf:params:oauth:token-type:jwt",
            "token_url":"https://sts.googleapis.com/v1/token",
            "service_account_impersonation_url":"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/test@example.invalid:generateAccessToken",
            "credential_source":{"file":"/nonexistent-kordi-synthetic-workload-token"},
        });
        validate_workload_identity(&config).unwrap();
        let credentials = external_account::Builder::new(config)
            .with_scopes(["https://www.googleapis.com/auth/cloud-platform"])
            .build_access_token_credentials()
            .unwrap();
        // Missing source material fails locally, without contacting Google or
        // using any ambient developer credential. This also exercises TLS
        // client construction with the workspace's crypto provider features.
        let result = tokio::time::timeout(Duration::from_secs(2), credentials.access_token()).await;
        assert!(result
            .expect("missing source should fail promptly")
            .is_err());
    }
}
