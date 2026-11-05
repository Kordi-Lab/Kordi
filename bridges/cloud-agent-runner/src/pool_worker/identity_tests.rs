use std::time::Duration;

use base64::Engine;
use serde_json::json;

use super::credentials::{decode_secret_payload, ModelCredentials};
use super::identity::{identity_ttl, AccessTokenSource, IdentityTokenSource};
use super::test_server::{config, fake_jwt, temp_file, MockServer};
use crate::model_loop::OpenAiProviderConfig;

const TOKEN_PATH: &str = "/computeMetadata/v1/instance/service-accounts/default/token";
const IDENTITY_PATH: &str = "/computeMetadata/v1/instance/service-accounts/default/identity";

fn http() -> reqwest::Client {
    reqwest::Client::new()
}

fn api_key_settings(extra: &[(&'static str, &'static str)]) -> Vec<(&'static str, &'static str)> {
    let mut values = vec![
        ("POOL_ID", "partner"),
        ("CONTROL_PLANE_URL", "https://control.example.test"),
        ("AUDIENCE", "https://control.example.test"),
        ("PROVIDER", "openrouter"),
        ("MODEL", "vendor/synthetic-model"),
        ("BASE_URL", "https://models.example.test/api/v1"),
    ];
    values.extend_from_slice(extra);
    values
}

#[tokio::test]
async fn identity_token_file_is_reread_on_every_request() {
    let path = temp_file("first-identity\n");
    let source = IdentityTokenSource::File(path.clone());
    assert_eq!(source.token().await.unwrap(), "first-identity");
    std::fs::write(&path, "second-identity").unwrap();
    assert_eq!(source.token().await.unwrap(), "second-identity");
    std::fs::write(&path, "  ").unwrap();
    assert!(source.token().await.is_err());
    std::fs::remove_file(&path).unwrap();
    let error = source.token().await.unwrap_err();
    assert!(!error.to_string().contains("kordi-pool-worker-test"));
}

#[tokio::test]
async fn metadata_identity_token_is_requested_with_audience_and_cached() {
    let token = fake_jwt(3600);
    let served = token.clone();
    let server = MockServer::start(move |_| (200, served.clone())).await;
    let source =
        IdentityTokenSource::metadata(http(), &server.url, "https://control.example.test/pool");
    assert_eq!(source.token().await.unwrap(), token);
    assert_eq!(source.token().await.unwrap(), token);
    let requests = server.recorded();
    assert_eq!(requests.len(), 1, "second call should use the cache");
    assert_eq!(requests[0].method, "GET");
    assert_eq!(
        requests[0].path,
        format!("{IDENTITY_PATH}?audience=https%3A%2F%2Fcontrol.example.test%2Fpool&format=full")
    );
    assert_eq!(
        requests[0].header("metadata-flavor").as_deref(),
        Some("google")
    );
}

#[tokio::test]
async fn nearly_expired_identity_token_is_not_reused() {
    let server = MockServer::start(|_| (200, fake_jwt(60))).await;
    let source = IdentityTokenSource::metadata(http(), &server.url, "aud");
    source.token().await.unwrap();
    source.token().await.unwrap();
    assert_eq!(server.recorded().len(), 2);
}

#[test]
fn identity_ttl_reads_exp_or_falls_back() {
    let now = chrono::Utc::now().timestamp();
    let ttl = identity_ttl(&fake_jwt(3600), now);
    assert!(ttl <= Duration::from_secs(3300) && ttl >= Duration::from_secs(3290));
    assert_eq!(identity_ttl(&fake_jwt(100), now), Duration::ZERO);
    assert_eq!(identity_ttl("opaque", now), Duration::from_secs(300));
    assert_eq!(identity_ttl("a.%%%.c", now), Duration::from_secs(300));
}

#[tokio::test]
async fn metadata_errors_do_not_leak_bodies() {
    let server = MockServer::start(|_| (500, "{\"detail\":\"internal-detail\"}".into())).await;
    let error = AccessTokenSource::new(http(), &server.url)
        .token()
        .await
        .unwrap_err();
    assert!(!error.to_string().contains("internal-detail"));
}

#[test]
fn secret_payload_is_base64_decoded_and_trimmed() {
    let data = base64::engine::general_purpose::STANDARD.encode("  synthetic-model-key\n");
    let body = json!({"name": "x", "payload": {"data": data}}).to_string();
    assert_eq!(decode_secret_payload(&body).unwrap(), "synthetic-model-key");
    assert!(decode_secret_payload("{\"payload\":{}}").is_err());
    assert!(decode_secret_payload("{\"payload\":{\"data\":\"***\"}}").is_err());
}

#[tokio::test]
async fn secret_manager_key_is_read_with_an_access_token_and_cached() {
    let data = base64::engine::general_purpose::STANDARD.encode("synthetic-model-key");
    let server = MockServer::start(move |request| {
        if request.path == TOKEN_PATH {
            (
                200,
                json!({"access_token": "synthetic-access", "expires_in": 3600}).to_string(),
            )
        } else {
            (200, json!({"payload": {"data": data}}).to_string())
        }
    })
    .await;
    let settings = api_key_settings(&[(
        "MODEL_SECRET",
        "projects/sponsor-project/secrets/model-key/versions/3",
    )]);
    let credentials = ModelCredentials::new(http(), &config(&settings, &server.url));
    let material = credentials.material().await.unwrap();
    credentials.material().await.unwrap();
    assert_eq!(material.provider, "openrouter");
    assert_eq!(material.payload["apiKey"], "synthetic-model-key");
    assert_eq!(
        material.payload["baseUrl"],
        "https://models.example.test/api/v1"
    );
    assert_eq!(material.payload["model"], "vendor/synthetic-model");
    let requests = server.recorded();
    assert_eq!(requests.len(), 2, "the key is cached after the first read");
    assert_eq!(
        requests[0].header("metadata-flavor").as_deref(),
        Some("google")
    );
    assert_eq!(
        requests[1].path,
        "/v1/projects/sponsor-project/secrets/model-key/versions/3:access"
    );
    assert_eq!(
        requests[1].header("authorization").as_deref(),
        Some("bearer synthetic-access")
    );
    let auth = OpenAiProviderConfig::from_material(&material).unwrap();
    assert_eq!(auth.api_key, "synthetic-model-key");
    assert_eq!(auth.model, "vendor/synthetic-model");
}

#[tokio::test]
async fn api_key_file_builds_material_without_google_calls() {
    let path = temp_file("synthetic-file-key\n");
    let file = path.to_str().unwrap().to_string();
    let settings = api_key_settings(&[("API_KEY_FILE", file.leak())]);
    let credentials = ModelCredentials::new(http(), &config(&settings, "http://127.0.0.1:9"));
    let material = credentials.material().await.unwrap();
    assert_eq!(material.payload["apiKey"], "synthetic-file-key");
    assert_eq!(material.auth_choice, "pool-worker-api-key");
    std::fs::remove_file(&path).unwrap();
}

#[tokio::test]
async fn vertex_material_uses_the_metadata_access_token() {
    let server = MockServer::start(|_| {
        (
            200,
            json!({"access_token": "synthetic-vertex", "expires_in": 3600}).to_string(),
        )
    })
    .await;
    let settings = [
        ("POOL_ID", "partner"),
        ("CONTROL_PLANE_URL", "https://control.example.test"),
        ("AUDIENCE", "https://control.example.test"),
        ("PROVIDER", "vertex-ai"),
        ("MODEL", "google/synthetic-model"),
        ("VERTEX_PROJECT", "sponsor-project"),
        ("VERTEX_LOCATION", "global"),
    ];
    let credentials = ModelCredentials::new(http(), &config(&settings, &server.url));
    let material = credentials.material().await.unwrap();
    credentials.material().await.unwrap();
    assert_eq!(server.paths(), vec![TOKEN_PATH.to_string()]);
    assert_eq!(material.provider, "vertex-ai");
    let auth = OpenAiProviderConfig::from_material(&material).unwrap();
    assert_eq!(auth.api_key, "synthetic-vertex");
    assert_eq!(
        auth.base_url,
        "https://aiplatform.googleapis.com/v1/projects/sponsor-project/locations/global/endpoints/openapi"
    );
}
