//! Shared fixtures and scenario partitions for provider error behavior.

use super::*;

fn http_error(
    format: ProviderErrorFormat,
    status: StatusCode,
    url: &str,
    content_type: Option<&str>,
    headers: HeaderMap,
    body: &[u8],
) -> ProviderHttpError {
    let content_type = content_type.map(ToString::to_string);
    let looks_html = looks_like_html(body, content_type.as_deref());
    let (message, code) = if looks_html {
        (None, None)
    } else {
        parse_provider_envelope_with_sensitive_values(format, body, &[])
    };
    ProviderHttpError {
        provider: "test".to_string(),
        operation: "test request".to_string(),
        status,
        url: sanitize_url(&Url::parse(url).unwrap()),
        content_type,
        message: message.unwrap_or_else(|| "Unknown error".to_string()),
        code,
        request_id: request_id(&headers),
        cf_ray: bounded_header(&headers, "cf-ray"),
        retry_after_ms: retry_after_ms(&headers),
        body_truncated: false,
        cloudflare_block: false,
        hint: None,
    }
}

mod parsing_and_sanitization;
mod response_handling;
mod retry_policy;
