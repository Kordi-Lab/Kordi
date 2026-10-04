//! Endpoint and protocol selection for hosted provider snapshots.

use super::*;

fn material(provider: &str, payload: Value) -> ProviderAuthMaterial {
    ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: provider.to_string(),
        auth_choice: "cloud-login:session".to_string(),
        payload,
    }
}

#[test]
fn a_provider_outside_the_endpoint_table_uses_its_own_base_url() {
    let config = OpenAiProviderConfig::from_material(&material(
        "mistral",
        json!({
            "apiMode": "api-key",
            "apiKey": "key",
            "baseUrl": "https://api.mistral.ai/v1/",
            "api": "openai-completions",
            "model": "mistral-large-latest"
        }),
    ))
    .unwrap();
    assert_eq!(config.provider, "mistral");
    assert_eq!(config.base_url, "https://api.mistral.ai/v1");
    assert_eq!(config.api_mode, OpenAiApiMode::ChatCompletions);
}

#[test]
fn a_provider_outside_the_endpoint_table_without_a_base_url_fails_closed() {
    for provider in ["mistral", "cerebras", "deepseek", "custom"] {
        let error = OpenAiProviderConfig::from_material(&material(
            provider,
            json!({ "apiMode": "api-key", "apiKey": "key", "model": "some-model" }),
        ))
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "provider error: Kordi Cloud cannot run {provider} yet: no endpoint is known for it."
            )
        );
    }
}

#[test]
fn a_known_provider_without_a_base_url_keeps_its_table_entry() {
    for (provider, base_url) in [
        ("groq", "https://api.groq.com/openai/v1"),
        ("xai", "https://api.x.ai/v1"),
        ("openrouter", "https://openrouter.ai/api/v1"),
        ("openai", "https://api.openai.com/v1"),
        ("anthropic", "https://api.anthropic.com"),
        ("google", "https://generativelanguage.googleapis.com"),
    ] {
        let config = OpenAiProviderConfig::from_material(&material(
            provider,
            json!({ "apiMode": "api-key", "apiKey": "key" }),
        ))
        .unwrap();
        assert_eq!(config.base_url, base_url, "{provider}");
    }
}

#[test]
fn an_api_kind_the_runner_does_not_speak_fails_closed() {
    for (provider, api) in [
        ("mistral", "mistral-conversations"),
        ("groq", "openai-responses"),
        ("github-copilot", "openai-responses"),
        ("zai", "anthropic-messages"),
        ("custom", "anthropic-messages"),
        ("anthropic", "openai-completions"),
        ("google", "google-gemini-cli"),
    ] {
        let error = OpenAiProviderConfig::from_material(&material(
            provider,
            json!({
                "apiKey": "key",
                "baseUrl": "https://llm.example.com/v1",
                "api": api,
                "model": "some-model"
            }),
        ))
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("provider error: Kordi Cloud cannot run {provider} yet: its {api} API is not supported."),
        );
    }
    let hidden = OpenAiProviderConfig::from_material(&material(
        "groq",
        json!({ "apiKey": "key", "api": "Weird API\n", "model": "m" }),
    ))
    .unwrap_err();
    assert!(hidden.to_string().ends_with("its API is not supported."));
}

#[test]
fn each_client_accepts_the_api_kind_it_speaks() {
    for (provider, payload) in [
        (
            "groq",
            json!({ "apiKey": "key", "api": "openai-completions" }),
        ),
        (
            "openai",
            json!({ "apiKey": "key", "api": "openai-responses" }),
        ),
        ("xai", json!({ "apiKey": "key", "api": "openai-responses" })),
        (
            "openrouter",
            json!({ "apiKey": "key", "api": "openrouter" }),
        ),
        (
            "anthropic",
            json!({ "apiKey": "key", "api": "anthropic-messages" }),
        ),
        (
            "google",
            json!({ "apiKey": "key", "api": "google-generative-ai" }),
        ),
        (
            "openai-codex",
            json!({
                "apiMode": "openai-codex-oauth",
                "accessToken": "token",
                "api": "openai-codex-responses"
            }),
        ),
    ] {
        assert!(
            OpenAiProviderConfig::from_material(&material(provider, payload)).is_ok(),
            "{provider}"
        );
    }
}

#[test]
fn native_clients_drop_the_version_path_of_catalog_base_urls() {
    let google = OpenAiProviderConfig::from_material(&material(
        "google",
        json!({
            "apiKey": "key",
            "api": "google-generative-ai",
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta"
        }),
    ))
    .unwrap();
    assert_eq!(google.base_url, "https://generativelanguage.googleapis.com");
    let anthropic = OpenAiProviderConfig::from_material(&material(
        "anthropic",
        json!({ "apiKey": "key", "baseUrl": "https://api.anthropic.com/v1/" }),
    ))
    .unwrap();
    assert_eq!(anthropic.base_url, "https://api.anthropic.com");
    let groq = OpenAiProviderConfig::from_material(&material(
        "groq",
        json!({ "apiKey": "key", "baseUrl": "https://api.groq.com/openai/v1" }),
    ))
    .unwrap();
    assert_eq!(groq.base_url, "https://api.groq.com/openai/v1");
}

#[test]
fn a_null_base_url_counts_as_missing() {
    let error = OpenAiProviderConfig::from_material(&material(
        "amazon-bedrock",
        json!({
            "apiMode": "api-key",
            "apiKey": "key",
            "baseUrl": null,
            "api": "openai-completions"
        }),
    ))
    .unwrap_err();
    assert!(error
        .to_string()
        .ends_with("cannot run amazon-bedrock yet: no endpoint is known for it."));
    let groq = OpenAiProviderConfig::from_material(&material(
        "groq",
        json!({ "apiMode": "api-key", "apiKey": "key", "baseUrl": null, "api": "openai-completions" }),
    ))
    .unwrap();
    assert_eq!(groq.base_url, "https://api.groq.com/openai/v1");
}

#[test]
fn a_structured_json_credential_fails_closed_instead_of_becoming_a_bearer_token() {
    for (provider, key) in [
        (
            "alibaba-token-plan",
            r#"{"apiKey":"synthetic","baseUrl":"https://llm.example.com/v1"}"#,
        ),
        (
            "cloudflare-ai-gateway",
            r#" {"accountId":"a","gatewayId":"g","apiKey":"synthetic"}"#,
        ),
    ] {
        let error = OpenAiProviderConfig::from_material(&material(
            provider,
            json!({
                "apiMode": "api-key",
                "apiKey": key,
                "baseUrl": "https://llm.example.com/v1",
                "api": "openai-completions"
            }),
        ))
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "provider error: Kordi Cloud cannot run {provider} yet: its structured credential is not supported."
            )
        );
        assert!(!error.to_string().contains("synthetic"));
    }
    // A key that merely starts with a brace but is not an object is a key.
    assert!(OpenAiProviderConfig::from_material(&material(
        "groq",
        json!({ "apiMode": "api-key", "apiKey": "{not-json", "api": "openai-completions" }),
    ))
    .is_ok());
}

#[test]
fn provider_endpoints_must_be_public_addresses() {
    for base_url in [
        "http://localhost:11434/v1",
        "http://127.0.0.1:8000/v1",
        "http://10.43.0.12:17081/v1",
        "http://172.17.0.1:8080/v1",
        "http://192.168.1.20/v1",
        "http://100.100.1.1/v1",
        "http://169.254.169.254/computeMetadata/v1",
        "http://[::1]:8080/v1",
        "http://[fd12::1]/v1",
        "http://postgres:5432/v1",
        "http://minio:9000/v1",
        "http://kordi-cloud-server:17081/v1",
        "http://kordi-cloud-server.kordi-cloud.svc.cluster.local:17081/v1",
        "https://gateway.local/v1",
        "https://user:secret@llm.example.com/v1",
        "ftp://llm.example.com/v1",
        "not a url",
    ] {
        let error = ensure_provider_endpoint_allowed(base_url, false).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("provider error: {}", endpoint::OWNER_LOCAL_ENDPOINT_ERROR),
            "{base_url}"
        );
    }
    for base_url in [
        "https://api.openai.com/v1",
        "https://llm.example.com/v1",
        "https://llm.example.com:8443/v1",
        "http://8.8.8.8:8000/v1",
    ] {
        assert!(
            ensure_provider_endpoint_allowed(base_url, false).is_ok(),
            "{base_url}"
        );
    }
}

#[test]
fn the_operator_opt_in_allows_private_http_endpoints_only() {
    for base_url in [
        "http://localhost:11434/v1",
        "http://10.0.0.5:8000/v1",
        "http://100.64.0.1:8000/v1",
        "http://vllm:8000/v1",
        "https://gateway.local/v1",
    ] {
        assert!(
            ensure_provider_endpoint_allowed(base_url, true).is_ok(),
            "{base_url}"
        );
    }
    for base_url in [
        "ftp://vllm/v1",
        "file:///tmp/model",
        "not a url",
        "https://user:secret@vllm/v1",
    ] {
        assert!(
            ensure_provider_endpoint_allowed(base_url, true).is_err(),
            "{base_url}"
        );
    }
}

#[test]
fn the_operator_opt_in_still_refuses_link_local_and_metadata_endpoints() {
    for base_url in [
        "http://169.254.169.254/computeMetadata/v1",
        "http://169.254.169.254/latest/meta-data",
        "http://[fe80::1]:8000/v1",
        "http://[::ffff:169.254.169.254]/v1",
        "http://metadata.google.internal/computeMetadata/v1",
        "http://metadata/computeMetadata/v1",
    ] {
        let error = ensure_provider_endpoint_allowed(base_url, true).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("provider error: {}", endpoint::OWNER_LOCAL_ENDPOINT_ERROR),
            "{base_url}"
        );
    }
}

#[test]
fn a_cluster_service_name_is_not_accepted_as_a_custom_endpoint() {
    for base_url in ["http://minio:9000/v1", "http://kordi-cloud-server:17081/v1"] {
        let error = OpenAiProviderConfig::from_material(&material(
            "custom",
            json!({ "apiKey": "key", "baseUrl": base_url, "model": "some-model" }),
        ))
        .unwrap_err();
        assert!(
            error.to_string().contains("owner-local provider endpoints"),
            "{base_url}"
        );
    }
}

async fn counting_listener() -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let connections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = connections.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    )
                    .await;
                let _ = stream.shutdown().await;
            });
        }
    });
    (port, connections)
}

fn config_for(base_url: String) -> OpenAiProviderConfig {
    OpenAiProviderConfig {
        provider: "custom".to_string(),
        api_key: "synthetic-provider-key".to_string(),
        base_url,
        model: "some-model".to_string(),
        thinking: "default".to_string(),
        api_mode: OpenAiApiMode::ChatCompletions,
        account_id: None,
    }
}

fn user_message() -> Vec<Value> {
    vec![json!({ "role": "user", "content": "hello" })]
}

#[tokio::test]
async fn provider_requests_refuse_names_that_resolve_to_private_addresses() {
    let (port, connections) = counting_listener().await;
    // A name that passed validation earlier but now resolves to a loopback
    // address is refused by the transport before any connection is made.
    let error = OpenAiCompatibleProvider::new(false)
        .next_response(
            &config_for(format!("http://localhost:{port}/v1")),
            &user_message(),
            &[],
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("could not connect"), "{error}");
    assert_eq!(
        connections.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the private listener must not be contacted"
    );
}

#[tokio::test]
async fn the_operator_opt_in_reaches_private_addresses() {
    let (port, connections) = counting_listener().await;
    let _ = OpenAiCompatibleProvider::new(true)
        .next_response(
            &config_for(format!("http://localhost:{port}/v1")),
            &user_message(),
            &[],
        )
        .await;
    assert!(connections.load(std::sync::atomic::Ordering::SeqCst) >= 1);
}

/// A private listener that redirects every request to the metadata service.
async fn redirect_to_metadata_listener() -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://169.254.169.254/latest/meta-data\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                let _ = stream.shutdown().await;
            });
        }
    });
    port
}

#[tokio::test]
async fn the_private_network_transport_refuses_redirects_to_metadata() {
    let port = redirect_to_metadata_listener().await;
    let error = private_network_provider_client()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .body("{}")
        .send()
        .await
        .unwrap_err();
    let chain = std::iter::successors(
        Some(&error as &(dyn std::error::Error + 'static)),
        |error| error.source(),
    )
    .map(ToString::to_string)
    .collect::<Vec<_>>()
    .join(": ");
    assert!(error.is_redirect(), "{chain}");
    assert!(chain.contains("not authorized"), "{chain}");
}

#[tokio::test]
async fn endpoints_for_the_omp_worker_must_resolve_to_allowed_addresses() {
    // `localhost` resolves without network access, to loopback addresses.
    let error =
        endpoint::ensure_endpoint_resolves_to_allowed_addresses("http://localhost:11434/v1", false)
            .await
            .unwrap_err();
    assert_eq!(
        error.to_string(),
        format!("provider error: {}", endpoint::OWNER_LOCAL_ENDPOINT_ERROR)
    );
    assert!(endpoint::ensure_endpoint_resolves_to_allowed_addresses(
        "http://localhost:11434/v1",
        true
    )
    .await
    .is_ok());
    for refused in [
        "http://169.254.169.254/v1",
        "http://[fe80::1]/v1",
        "not a url",
    ] {
        assert!(
            endpoint::ensure_endpoint_resolves_to_allowed_addresses(refused, true)
                .await
                .is_err(),
            "{refused}"
        );
    }
    assert!(
        endpoint::ensure_endpoint_resolves_to_allowed_addresses("https://8.8.8.8/v1", false)
            .await
            .is_ok()
    );
}
