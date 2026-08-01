//! Provider-envelope parsing, redaction, and safe diagnostic rendering scenarios.

use super::*;

#[test]
fn html_403_is_safe_and_not_retryable_despite_svg_decimals() {
    let body = br#"<html><svg d="M 0.500197 0.495044"></svg><p>[IP:203.0.113.1]</p></html>"#;
    let error = http_error(
        ProviderErrorFormat::OpenAi,
        StatusCode::FORBIDDEN,
        "https://chatgpt.com/backend-api/codex/responses",
        Some("text/html"),
        HeaderMap::new(),
        body,
    );

    assert_eq!(error.message, "Unknown error");
    assert!(!error.is_retryable());
    let rendered = error.to_string();
    assert_eq!(
        rendered,
        "unexpected status 403 Forbidden: Unknown error, url: https://chatgpt.com/backend-api/codex/responses"
    );
    assert!(!rendered.contains("<html"));
    assert!(!rendered.contains("203.0.113.1"));
    assert!(!is_retryable_error_message(&rendered));
}

#[test]
fn provider_envelopes_extract_only_safe_messages() {
    let cases = [
        (
            ProviderErrorFormat::OpenAi,
            br#"{"error":{"message":"OpenAI rejected this","type":"invalid_request_error"}}"#
                .as_slice(),
            "OpenAI rejected this",
        ),
        (
            ProviderErrorFormat::Anthropic,
            br#"{"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}"#
                .as_slice(),
            "Request not allowed",
        ),
        (
            ProviderErrorFormat::Google,
            br#"{"error":{"code":403,"message":"Permission denied","status":"PERMISSION_DENIED"}}"#
                .as_slice(),
            "Permission denied",
        ),
        (
            ProviderErrorFormat::OAuth,
            br#"{"error":"invalid_grant","error_description":"Authorization code expired"}"#
                .as_slice(),
            "Authorization code expired",
        ),
    ];

    for (format, body, expected) in cases {
        let (message, _) = parse_provider_envelope_with_sensitive_values(format, body, &[]);
        assert_eq!(message.as_deref(), Some(expected));
    }

    for body in [
        b"Forbidden: access_token=secret".as_slice(),
        br#"{"error":{"message":"truncated""#.as_slice(),
        b"\0\xff\x01binary".as_slice(),
    ] {
        let (message, code) =
            parse_provider_envelope_with_sensitive_values(ProviderErrorFormat::OpenAi, body, &[]);
        assert_eq!(message, None);
        assert_eq!(code, None);
    }
}

#[test]
fn provider_envelopes_redact_exact_reflected_request_credentials() {
    let sensitive_values = vec![
        "arbitrary-oauth-code-123".to_string(),
        "custom-header-secret-456".to_string(),
    ];
    let body = br#"{"error":{"message":"code arbitrary-oauth-code-123 was rejected by custom-header-secret-456","code":"arbitrary-oauth-code-123"}}"#;
    let (message, code) = parse_provider_envelope_with_sensitive_values(
        ProviderErrorFormat::OpenAi,
        body,
        &sensitive_values,
    );

    assert_eq!(
        message.as_deref(),
        Some("code [redacted] was rejected by [redacted]")
    );
    assert_eq!(code.as_deref(), Some("[redacted]"));

    let (message, _) = parse_provider_envelope_with_sensitive_values(
        ProviderErrorFormat::OAuth,
        br#"{"error":"invalid_grant","error_description":"code x was rejected"}"#,
        &["x".to_string()],
    );
    assert_eq!(message.as_deref(), Some("[redacted]"));
}

#[test]
fn url_and_diagnostics_are_sanitized() {
    let mut headers = HeaderMap::new();
    headers.insert("cf-ray", "ray-123-HKG".parse().unwrap());
    headers.insert("x-request-id", "request-456".parse().unwrap());
    let error = http_error(
        ProviderErrorFormat::Google,
        StatusCode::FORBIDDEN,
        "https://user:password@generativelanguage.googleapis.com/v1beta/models/test:streamGenerateContent?key=super-secret&alt=sse#fragment",
        Some("application/json"),
        headers,
        br#"{"error":{"message":"Permission denied"}}"#,
    );

    let rendered = error.to_string();
    assert!(rendered.contains("Permission denied"));
    assert!(rendered.contains("cf-ray: ray-123-HKG"));
    assert!(rendered.contains("request id: request-456"));
    assert!(!rendered.contains("super-secret"));
    assert!(!rendered.contains("password"));
    assert!(!rendered.contains("?key"));
    assert!(!rendered.contains("#fragment"));
}

#[test]
fn response_identifiers_are_allowlisted_and_bounded() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-request-id",
        "a".repeat(MAX_DIAGNOSTIC_BYTES * 2).parse().unwrap(),
    );
    headers.insert("cf-ray", "unsafe value with spaces".parse().unwrap());
    let error = http_error(
        ProviderErrorFormat::OpenAi,
        StatusCode::BAD_GATEWAY,
        "https://example.com/v1/responses",
        Some("application/json"),
        headers,
        br#"{"error":{"message":"temporary"}}"#,
    );

    assert_eq!(
        error.request_id.as_deref().map(str::len),
        Some(MAX_DIAGNOSTIC_BYTES)
    );
    assert_eq!(error.cf_ray, None);

    let mut unsafe_headers = HeaderMap::new();
    unsafe_headers.insert("x-request-id", "token=reflected-secret".parse().unwrap());
    unsafe_headers.insert("cf-ray", "203.0.113.1".parse().unwrap());
    let error = http_error(
        ProviderErrorFormat::OpenAi,
        StatusCode::BAD_GATEWAY,
        "https://example.com/v1/responses",
        Some("application/json"),
        unsafe_headers,
        br#"{"error":{"message":"temporary"}}"#,
    );
    assert_eq!(error.request_id, None);
    assert_eq!(error.cf_ray, None);
}

#[test]
fn provider_messages_redact_urls_secrets_ips_and_embedded_markup() {
    let safe = sanitize_user_text(
        "request https://example.com/v1?access_token=secret failed from 203.0.113.1 with Bearer abc123",
        MAX_USER_MESSAGE_BYTES,
    );
    assert_eq!(
        safe,
        "request https://example.com/v1 failed from [redacted ip] with Bearer [redacted]"
    );
    assert!(!safe.contains("secret"));
    assert!(!safe.contains("abc123"));

    let embedded_ips = sanitize_user_text(
        "client_ip=203.0.113.1 source=[2001:db8::1] endpoint=198.51.100.2:443",
        MAX_USER_MESSAGE_BYTES,
    );
    assert_eq!(embedded_ips, "[redacted ip] [redacted ip] [redacted ip]");
    assert!(!embedded_ips.contains("203.0.113.1"));
    assert!(!embedded_ips.contains("2001:db8::1"));
    assert!(!embedded_ips.contains("198.51.100.2"));

    assert!(
        sanitize_user_text(
            "<html><body>blocked at 203.0.113.1</body></html>",
            MAX_USER_MESSAGE_BYTES
        )
        .is_empty()
    );
    assert!(
        sanitize_user_text(
            "body { color: red; background-image: url(https://example.com/?token=secret); }",
            MAX_USER_MESSAGE_BYTES
        )
        .is_empty()
    );
    assert!(
        sanitize_user_text(
            &format!("{}<svg><path /></svg>", "x".repeat(400)),
            MAX_USER_MESSAGE_BYTES
        )
        .is_empty()
    );
    assert!(
        sanitize_user_text(
            "The edge returned <iframe src=\"https://example.com\"></iframe>",
            MAX_USER_MESSAGE_BYTES
        )
        .is_empty()
    );
    assert!(sanitize_user_text(".blocked { display: none }", MAX_USER_MESSAGE_BYTES).is_empty());
}
