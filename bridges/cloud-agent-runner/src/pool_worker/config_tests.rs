use std::collections::HashMap;

use super::*;

const SECRET: &str = "projects/sponsor-project/secrets/model-key/versions/3";

fn base() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("POOL_ID", "partner"),
        ("CONTROL_PLANE_URL", "https://control.example.test/"),
        ("AUDIENCE", "https://control.example.test"),
        ("PROVIDER", "openrouter"),
        ("MODEL", "vendor/synthetic-model"),
        ("BASE_URL", "https://models.example.test/api/v1"),
        ("MODEL_SECRET", SECRET),
    ])
}

fn parse(
    values: &HashMap<&'static str, &'static str>,
) -> Result<PoolWorkerConfig, PoolWorkerConfigError> {
    PoolWorkerConfig::from_lookup(|name| {
        let short = name.strip_prefix("KORDI_POOL_WORKER_")?;
        values.get(short).map(|value| value.to_string())
    })
}

fn with(changes: &[(&'static str, &'static str)]) -> HashMap<&'static str, &'static str> {
    let mut values = base();
    for (key, value) in changes {
        values.insert(key, value);
    }
    values
}

fn without(keys: &[&str]) -> HashMap<&'static str, &'static str> {
    let mut values = base();
    values.retain(|key, _| !keys.contains(key));
    values
}

#[test]
fn api_key_provider_config_uses_defaults() {
    let config = parse(&base()).unwrap();
    assert_eq!(config.pool_id, "partner");
    assert_eq!(config.control_plane_url, "https://control.example.test");
    assert_eq!(config.provider, ModelProviderKind::OpenRouter);
    assert_eq!(config.base_url, "https://models.example.test/api/v1");
    assert_eq!(
        config.credential,
        ModelCredentialSource::SecretManager(SECRET.into())
    );
    assert!(config.worker_id.starts_with("pool-worker-"));
    assert_eq!(config.concurrency, 2);
    assert_eq!(config.poll_interval, Duration::from_millis(2_000));
    assert_eq!(config.identity_token_file, None);
    assert_eq!(config.metadata_url, DEFAULT_METADATA_URL);
}

#[test]
fn every_api_key_provider_is_accepted() {
    for provider in ["openai", "openai-compatible", "openrouter"] {
        let config = parse(&with(&[("PROVIDER", provider)])).unwrap();
        assert_eq!(config.provider.id(), provider);
    }
    assert!(parse(&with(&[("PROVIDER", "anthropic")])).is_err());
    assert!(parse(&without(&["PROVIDER"])).is_err());
}

#[test]
fn optional_settings_are_validated() {
    let config = parse(&with(&[
        ("ID", "worker-a"),
        ("CONCURRENCY", "4"),
        ("POLL_MS", "250"),
        ("IDENTITY_TOKEN_FILE", "/var/run/identity/token"),
    ]))
    .unwrap();
    assert_eq!(config.worker_id, "worker-a");
    assert_eq!(config.concurrency, 4);
    assert_eq!(config.poll_interval, Duration::from_millis(250));
    assert!(config.identity_token_file.is_some());
    for bad in [
        ("CONCURRENCY", "0"),
        ("CONCURRENCY", "5"),
        ("CONCURRENCY", "two"),
        ("POLL_MS", "249"),
        ("ID", "bad id"),
        ("POOL_ID", "has/slash"),
        ("MODEL", "two words"),
    ] {
        assert!(parse(&with(&[bad])).is_err(), "{bad:?} should be rejected");
    }
    let long_pool = "p".repeat(65);
    let mut values = base();
    values.insert("POOL_ID", long_pool.leak());
    assert!(parse(&values).is_err());
    assert!(parse(&without(&["AUDIENCE"])).is_err());
    assert!(parse(&without(&["MODEL"])).is_err());
}

#[test]
fn control_plane_url_must_be_https_unless_loopback() {
    for ok in [
        "https://control.example.test",
        "http://127.0.0.1:8080",
        "http://localhost:3000/",
        "http://[::1]:9000",
    ] {
        assert!(parse(&with(&[("CONTROL_PLANE_URL", ok)])).is_ok(), "{ok}");
    }
    for bad in [
        "http://control.example.test",
        "ftp://control.example.test",
        "https://name@control.example.test",
        "https://control.example.test/?x=1",
        "not a url",
    ] {
        assert!(
            parse(&with(&[("CONTROL_PLANE_URL", bad)])).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn api_key_providers_need_https_base_url_and_one_secret_source() {
    assert!(parse(&with(&[("BASE_URL", "http://models.example.test/v1")])).is_err());
    assert!(parse(&without(&["BASE_URL"])).is_err());
    // Both sources.
    assert!(parse(&with(&[("API_KEY_FILE", "/run/secrets/key")])).is_err());
    // Neither source.
    assert!(parse(&without(&["MODEL_SECRET"])).is_err());
    // Key file only.
    let mut values = without(&["MODEL_SECRET"]);
    values.insert("API_KEY_FILE", "/run/secrets/key");
    assert_eq!(
        parse(&values).unwrap().credential,
        ModelCredentialSource::ApiKeyFile("/run/secrets/key".into())
    );
    for bad in [
        "projects/p/secrets/s",
        "projects/p/keys/s/versions/1",
        "projects//secrets/s/versions/1",
        "projects/p/secrets/s/versions/1/extra",
    ] {
        assert!(parse(&with(&[("MODEL_SECRET", bad)])).is_err(), "{bad}");
    }
    assert!(parse(&with(&[("VERTEX_PROJECT", "sponsor-project")])).is_err());
}

#[test]
fn vertex_needs_project_and_location_and_no_key_settings() {
    let mut values = without(&["BASE_URL", "MODEL_SECRET"]);
    values.insert("PROVIDER", "vertex-ai");
    values.insert("MODEL", "google/synthetic-model");
    values.insert("VERTEX_PROJECT", "sponsor-project");
    values.insert("VERTEX_LOCATION", "us-central1");
    let config = parse(&values).unwrap();
    assert_eq!(config.provider, ModelProviderKind::VertexAi);
    assert_eq!(
        config.base_url,
        "https://us-central1-aiplatform.googleapis.com/v1/projects/sponsor-project/locations/us-central1/endpoints/openapi"
    );
    assert_eq!(
        config.credential,
        ModelCredentialSource::Vertex {
            project: "sponsor-project".into(),
            location: "us-central1".into()
        }
    );
    for (key, value) in [
        ("BASE_URL", "https://models.example.test/v1"),
        ("MODEL_SECRET", SECRET),
        ("API_KEY_FILE", "/run/secrets/key"),
        ("VERTEX_LOCATION", "US Central"),
        ("VERTEX_PROJECT", "bad/project"),
    ] {
        let mut bad = values.clone();
        bad.insert(key, value);
        assert!(parse(&bad).is_err(), "{key}");
    }
    let mut missing = values.clone();
    missing.remove("VERTEX_LOCATION");
    assert!(parse(&missing).is_err());
}

#[test]
fn vertex_base_url_handles_global_and_regions() {
    assert_eq!(
        vertex_base_url("sponsor-project", "global"),
        "https://aiplatform.googleapis.com/v1/projects/sponsor-project/locations/global/endpoints/openapi"
    );
    assert_eq!(
        vertex_base_url("sponsor-project", "europe-west4"),
        "https://europe-west4-aiplatform.googleapis.com/v1/projects/sponsor-project/locations/europe-west4/endpoints/openapi"
    );
}

#[test]
fn errors_never_echo_values() {
    let secret_looking = "projects/p/secrets/hidden-value";
    let error = parse(&with(&[("MODEL_SECRET", secret_looking)])).unwrap_err();
    assert!(!error.to_string().contains("hidden-value"));
    let error = parse(&with(&[(
        "CONTROL_PLANE_URL",
        "http://hidden-host.example.test",
    )]))
    .unwrap_err();
    assert!(!error.to_string().contains("hidden-host"));
}
