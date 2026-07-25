use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use kordi_provider::anthropic::AnthropicProvider;
use kordi_provider::google::GoogleProvider;
use kordi_provider::openai::OpenAiProvider;
use kordi_provider::{
    CompletionRequest, Provider, ProviderAuthMode, ProviderErrorFormat, RequestOptions,
    StreamEvent, unexpected_response_with_sensitive_values,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum Adapter {
    OpenAi,
    Anthropic,
    Google,
}

impl Adapter {
    fn provider(self) -> Box<dyn Provider> {
        match self {
            Self::OpenAi => Box::new(OpenAiProvider::new()),
            Self::Anthropic => Box::new(AnthropicProvider::new()),
            Self::Google => Box::new(GoogleProvider::new()),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::OpenAi => "openai-compatible",
            Self::Anthropic => "anthropic",
            Self::Google => "google",
        }
    }

    fn expected_path(self) -> &'static str {
        match self {
            Self::OpenAi => "/chat/completions",
            Self::Anthropic => "/v1/messages",
            Self::Google => "/v1beta/models/test-model:streamGenerateContent",
        }
    }

    fn json_body(self) -> (&'static str, &'static str) {
        match self {
            Self::OpenAi => (
                r#"{"error":{"message":"OpenAI rejected gemini-secret-key and custom-header-secret","type":"forbidden"},"debug":"sibling-secret"}"#,
                "OpenAI rejected [redacted] and [redacted]",
            ),
            Self::Anthropic => (
                r#"{"type":"error","error":{"type":"forbidden","message":"Anthropic rejected gemini-secret-key and custom-header-secret"},"debug":"sibling-secret"}"#,
                "Anthropic rejected [redacted] and [redacted]",
            ),
            Self::Google => (
                r#"{"error":{"code":403,"message":"Gemini rejected gemini-secret-key and custom-header-secret","status":"PERMISSION_DENIED"},"debug":"sibling-secret"}"#,
                "Gemini rejected [redacted] and [redacted]",
            ),
        }
    }
}

fn request() -> CompletionRequest {
    CompletionRequest {
        system_prompt: String::new(),
        messages: Vec::new(),
        tools: Vec::new(),
        extra_tool_schemas: Vec::new(),
        model: "test-model".to_string(),
        max_tokens: Some(64),
        stream: true,
        thinking: None,
    }
}

fn options(adapter: Adapter, base_url: String) -> RequestOptions {
    let mut headers = HashMap::new();
    headers.insert(
        "X-Custom-Credential".to_string(),
        "custom-header-secret".to_string(),
    );
    RequestOptions {
        provider: adapter.name().to_string(),
        api_key: "gemini-secret-key".to_string(),
        auth_mode: ProviderAuthMode::ApiKey,
        auth_account_id: None,
        base_url,
        headers,
        cancel: CancellationToken::new(),
        retry_callback: None,
        max_retries: 3,
        retry_base_delay_ms: 1,
        max_retry_delay_ms: 10,
    }
}

async fn error_server(
    content_type: &'static str,
    body: String,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let requests_for_server = requests.clone();
    let response = format!(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: {content_type}\r\nCF-Ray: adapter-test-HKG\r\nX-Request-ID: request-test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );

    let handle = tokio::spawn(async move {
        loop {
            let Ok(Ok((mut stream, _))) =
                timeout(Duration::from_millis(100), listener.accept()).await
            else {
                break;
            };
            requests_for_server.fetch_add(1, Ordering::SeqCst);
            let mut request = [0_u8; 8_192];
            let _ = stream.read(&mut request).await.unwrap();
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });

    (format!("http://{address}"), requests, handle)
}

async fn run_error_case(
    adapter: Adapter,
    content_type: &'static str,
    body: String,
    expected_message: &str,
) {
    let (base_url, requests, server) = error_server(content_type, body).await;
    let provider = adapter.provider();
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
    let error = provider
        .stream(request(), options(adapter, base_url.clone()), tx)
        .await
        .expect_err("terminal 403 should fail");
    server.await.unwrap();

    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "{} retried a terminal response",
        adapter.name()
    );
    assert!(rx.try_recv().is_err());

    let rendered = error.to_string();
    assert!(rendered.contains("unexpected status 403 Forbidden"));
    assert!(rendered.contains(expected_message));
    assert!(rendered.contains(&format!("{base_url}{}", adapter.expected_path())));
    assert!(rendered.contains("cf-ray: adapter-test-HKG"));
    assert!(rendered.contains("request id: request-test"));
    assert!(
        !rendered.contains("Provider error:"),
        "provider error gained an outer prefix: {rendered}"
    );
    assert!(!rendered.contains("sibling-secret"));
    assert!(!rendered.contains("gemini-secret-key"));
    assert!(!rendered.contains("custom-header-secret"));
    assert!(!rendered.contains('?'));
}

#[tokio::test]
async fn every_provider_adapter_sanitizes_html_and_known_json_without_retrying_403() {
    for adapter in [Adapter::OpenAi, Adapter::Anthropic, Adapter::Google] {
        run_error_case(
            adapter,
            "text/html; charset=utf-8",
            r#"<html><style>body{color:red}</style><svg d="M0.500197 0.495044"></svg><p>[IP:203.0.113.1]</p></html>"#
                .to_string(),
            "Unknown error",
        )
        .await;

        let (body, expected_message) = adapter.json_body();
        run_error_case(
            adapter,
            "application/json",
            body.to_string(),
            expected_message,
        )
        .await;
    }
}

#[tokio::test]
async fn oauth_error_contract_never_echoes_submitted_or_response_secrets() {
    for (content_type, body, expected_message) in [
        (
            "text/html; charset=utf-8",
            "<html><p>code=submitted-code refresh_token=response-secret [IP:203.0.113.1]</p></html>",
            "Unknown error",
        ),
        (
            "application/json",
            r#"{"error":"invalid_grant","error_description":"Authorization code submitted-code expired","submitted_code":"submitted-code","refresh_token":"response-secret"}"#,
            "Authorization code [redacted] expired",
        ),
    ] {
        let (base_url, requests, server) = error_server(content_type, body.to_string()).await;
        let url = format!(
            "{base_url}/oauth/token?code=query-code&access_token=query-token#callback-fragment"
        );
        let response = reqwest::get(&url).await.unwrap();
        let sensitive_values = vec!["submitted-code".to_string()];
        let error = unexpected_response_with_sensitive_values(
            "openai",
            "token exchange",
            ProviderErrorFormat::OAuth,
            response,
            &sensitive_values,
        )
        .await;
        server.await.unwrap();

        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let rendered = error.to_string();
        assert!(rendered.contains(expected_message));
        assert!(rendered.contains(&format!("{base_url}/oauth/token")));
        for secret in [
            "submitted-code",
            "response-secret",
            "query-code",
            "query-token",
            "203.0.113.1",
            "<html",
        ] {
            assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
        }
        assert!(!rendered.contains('?'));
        assert!(!rendered.contains('#'));
    }
}
