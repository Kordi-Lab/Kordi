//! Typed retryability and retry-delay scenarios.

use super::*;

#[test]
fn only_explicit_status_tokens_are_retryable() {
    assert!(is_retryable_error_message(
        "unexpected status 503 Service Unavailable: Unknown error"
    ));
    assert!(is_retryable_error_message("HTTP 429: rate limited"));
    assert!(!is_retryable_error_message(
        "unexpected status 403 Forbidden: value 0.500197 and 0.495044"
    ));
    assert!(!is_retryable_error_message(
        "unexpected status 403 Forbidden: upstream server error"
    ));
}

#[test]
fn typed_retry_contract_covers_status_transport_and_retry_after() {
    for status in [408, 409, 425, 429, 500, 502, 503, 504, 529] {
        let error = http_error(
            ProviderErrorFormat::OpenAi,
            StatusCode::from_u16(status).unwrap(),
            "https://example.com/v1/responses",
            Some("application/json"),
            HeaderMap::new(),
            br#"{"error":{"message":"temporary"}}"#,
        );
        assert!(error.is_retryable(), "status {status} should retry");
    }
    for status in [400, 401, 403, 404, 422] {
        let error = http_error(
            ProviderErrorFormat::OpenAi,
            StatusCode::from_u16(status).unwrap(),
            "https://example.com/v1/responses",
            Some("application/json"),
            HeaderMap::new(),
            br#"{"error":{"message":"terminal"}}"#,
        );
        assert!(!error.is_retryable(), "status {status} should be terminal");
    }

    let explicit_overload = http_error(
        ProviderErrorFormat::Anthropic,
        StatusCode::BAD_REQUEST,
        "https://api.anthropic.com/v1/messages",
        Some("application/json"),
        HeaderMap::new(),
        br#"{"error":{"type":"overloaded_error","message":"Try again later"}}"#,
    );
    assert!(explicit_overload.is_retryable());

    let terminal_quota = http_error(
        ProviderErrorFormat::OpenAi,
        StatusCode::TOO_MANY_REQUESTS,
        "https://api.openai.com/v1/responses",
        Some("application/json"),
        HeaderMap::new(),
        br#"{"error":{"code":"insufficient_quota","message":"Quota exhausted"}}"#,
    );
    assert!(!terminal_quota.is_retryable());

    let timeout = ProviderError::Transport {
        provider: "openai".to_string(),
        operation: "responses".to_string(),
        kind: ProviderTransportKind::Timeout,
        message: "provider request timed out".to_string(),
        url: "https://example.com/v1/responses".to_string(),
        retryable: true,
    };
    let reset = ProviderError::Transport {
        provider: "openai".to_string(),
        operation: "responses stream".to_string(),
        kind: ProviderTransportKind::ResponseBody,
        message: "provider response stream failed".to_string(),
        url: "https://example.com/v1/responses".to_string(),
        retryable: true,
    };
    assert!(timeout.is_retryable());
    assert!(reset.is_retryable());

    let mut headers = HeaderMap::new();
    headers.insert(RETRY_AFTER, "2".parse().unwrap());
    let rate_limit = http_error(
        ProviderErrorFormat::OpenAi,
        StatusCode::TOO_MANY_REQUESTS,
        "https://example.com/v1/responses",
        Some("application/json"),
        headers,
        br#"{"error":{"message":"rate limited"}}"#,
    );
    assert_eq!(rate_limit.retry_after_ms, Some(2_000));

    let terminal_stream = ProviderError::stream(
        "openai",
        "responses stream",
        Some("upstream server error"),
        Some("authentication_error"),
    );
    assert!(!terminal_stream.is_retryable());

    let numeric_terminal_stream = ProviderError::stream(
        "google",
        "streamGenerateContent stream",
        Some("upstream server error"),
        Some("403"),
    );
    assert!(!numeric_terminal_stream.is_retryable());

    let google_terminal_stream = ProviderError::stream(
        "google",
        "streamGenerateContent stream",
        Some("upstream server error"),
        Some("PERMISSION_DENIED"),
    );
    assert!(!google_terminal_stream.is_retryable());
}

#[test]
fn retry_after_supports_seconds_milliseconds_and_http_dates() {
    let now = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);

    let mut seconds = HeaderMap::new();
    seconds.insert(RETRY_AFTER, "2".parse().unwrap());
    assert_eq!(retry_after_ms_at(&seconds, now), Some(2_000));

    let mut milliseconds = HeaderMap::new();
    milliseconds.insert("retry-after-ms", "250".parse().unwrap());
    assert_eq!(retry_after_ms_at(&milliseconds, now), Some(250));

    let mut date = HeaderMap::new();
    date.insert(
        RETRY_AFTER,
        httpdate::fmt_http_date(now + std::time::Duration::from_secs(42))
            .parse()
            .unwrap(),
    );
    assert_eq!(retry_after_ms_at(&date, now), Some(42_000));

    let google_retry_info = br#"{
        "error": {
            "code": 429,
            "details": [{
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                "retryDelay": "1.25s"
            }]
        }
    }"#;
    assert_eq!(
        provider_retry_delay_ms(ProviderErrorFormat::Google, google_retry_info),
        Some(1_250)
    );
    assert_eq!(
        provider_retry_delay_ms(ProviderErrorFormat::OpenAi, google_retry_info),
        None
    );

    let streamed = ProviderError::stream(
        "google",
        "streamGenerateContent stream",
        Some("Resource exhausted"),
        Some("RESOURCE_EXHAUSTED"),
    )
    .with_retry_after_ms(provider_retry_delay_ms(
        ProviderErrorFormat::Google,
        google_retry_info,
    ));
    assert_eq!(streamed.retry_after_ms(), Some(1_250));
}
