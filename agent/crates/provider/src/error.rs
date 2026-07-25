use std::fmt;
use std::net::IpAddr;
use std::time::{Duration, SystemTime};

use futures::StreamExt;
use kordi_core::error::KordiError;
use reqwest::header::{CONTENT_TYPE, HeaderMap, RETRY_AFTER};
use reqwest::{Response, StatusCode, Url};
use serde_json::Value;
use thiserror::Error;

const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;
const MAX_USER_MESSAGE_BYTES: usize = 512;
const MAX_DIAGNOSTIC_BYTES: usize = 128;
const MAX_URL_BYTES: usize = 2_048;
const MAX_ERROR_BODY_READ_DURATION: Duration = Duration::from_secs(2);

/// Provider-specific JSON envelope used to extract a safe error message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderErrorFormat {
    OpenAi,
    Anthropic,
    Google,
    OAuth,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderTransportKind {
    Timeout,
    Connect,
    ResponseBody,
    Request,
}

/// Structured metadata for a non-success provider HTTP response.
///
/// This type intentionally never stores the raw response body. All fields are
/// bounded and safe to display or persist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderHttpError {
    pub provider: String,
    pub operation: String,
    pub status: StatusCode,
    pub url: String,
    pub content_type: Option<String>,
    pub message: String,
    pub code: Option<String>,
    pub request_id: Option<String>,
    pub cf_ray: Option<String>,
    pub retry_after_ms: Option<u64>,
    pub body_truncated: bool,
    pub cloudflare_block: bool,
    pub hint: Option<String>,
}

impl ProviderHttpError {
    pub fn is_retryable(&self) -> bool {
        is_retryable_status(self.status)
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        let hint = sanitize_user_text(&hint.into(), MAX_USER_MESSAGE_BYTES);
        self.hint = (!hint.is_empty()).then_some(hint);
        self
    }
}

impl fmt::Display for ProviderHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "unexpected status {}: {}, url: {}",
            self.status, self.message, self.url
        )?;

        if let Some(cf_ray) = &self.cf_ray {
            write!(f, ", cf-ray: {cf_ray}")?;
        }
        if let Some(request_id) = &self.request_id {
            write!(f, ", request id: {request_id}")?;
        }
        if let Some(hint) = &self.hint {
            write!(f, ". {hint}")?;
        }
        Ok(())
    }
}

/// Domain errors for provider requests and response streams.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ProviderError {
    #[error("{0}")]
    Http(ProviderHttpError),

    #[error("{message}, url: {url}")]
    Transport {
        provider: String,
        operation: String,
        kind: ProviderTransportKind,
        message: String,
        url: String,
        retryable: bool,
    },

    #[error("{message}")]
    Stream {
        provider: String,
        operation: String,
        message: String,
        code: Option<String>,
        retryable: bool,
        retry_after_ms: Option<u64>,
    },

    #[error("Request cancelled")]
    Cancelled,

    #[error("{message}")]
    Other { message: String, retryable: bool },
}

impl ProviderError {
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Http(error) => error.is_retryable(),
            Self::Transport { retryable, .. }
            | Self::Stream { retryable, .. }
            | Self::Other { retryable, .. } => *retryable,
            Self::Cancelled => false,
        }
    }

    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            Self::Http(error) => error.retry_after_ms,
            Self::Stream { retry_after_ms, .. } => *retry_after_ms,
            _ => None,
        }
    }

    pub fn with_retry_after_ms(mut self, retry_after_ms: Option<u64>) -> Self {
        if let Self::Stream {
            retry_after_ms: current,
            ..
        } = &mut self
        {
            *current = retry_after_ms.or(*current);
        }
        self
    }

    pub fn from_reqwest(
        provider: impl Into<String>,
        operation: impl Into<String>,
        url: &str,
        error: &reqwest::Error,
    ) -> Self {
        let provider = sanitize_metadata(&provider.into(), "unknown provider");
        let operation = sanitize_metadata(&operation.into(), "provider request");
        let url = sanitize_url_str(url);
        let (kind, message, retryable) = if error.is_timeout() {
            (
                ProviderTransportKind::Timeout,
                "provider request timed out".to_string(),
                true,
            )
        } else if error.is_connect() {
            (
                ProviderTransportKind::Connect,
                "could not connect to provider".to_string(),
                true,
            )
        } else if error.is_body() {
            (
                ProviderTransportKind::ResponseBody,
                "provider response stream failed".to_string(),
                true,
            )
        } else if error.is_request() && !error.is_builder() && !error.is_redirect() {
            (
                ProviderTransportKind::Request,
                "provider request failed".to_string(),
                true,
            )
        } else {
            (
                ProviderTransportKind::Request,
                "provider request failed".to_string(),
                false,
            )
        };
        Self::Transport {
            provider,
            operation,
            kind,
            message,
            url,
            retryable,
        }
    }

    pub fn stream(
        provider: impl Into<String>,
        operation: impl Into<String>,
        message: Option<&str>,
        code: Option<&str>,
    ) -> Self {
        Self::stream_with_sensitive_values(provider, operation, message, code, &[])
    }

    pub fn stream_with_sensitive_values(
        provider: impl Into<String>,
        operation: impl Into<String>,
        message: Option<&str>,
        code: Option<&str>,
        sensitive_values: &[String],
    ) -> Self {
        let message = message
            .map(|value| {
                sanitize_user_text_with_sensitive_values(
                    value,
                    MAX_USER_MESSAGE_BYTES,
                    sensitive_values,
                )
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Unknown error".to_string());
        let code = code
            .map(|value| {
                sanitize_user_text_with_sensitive_values(
                    value,
                    MAX_DIAGNOSTIC_BYTES,
                    sensitive_values,
                )
            })
            .filter(|value| !value.is_empty());
        let retryable = code
            .as_deref()
            .and_then(retryability_for_error_code)
            .unwrap_or_else(|| is_retryable_error_message(&message));
        let retry_after_ms = extract_retry_delay_ms(&message);

        Self::Stream {
            provider: sanitize_metadata(&provider.into(), "unknown provider"),
            operation: sanitize_metadata(&operation.into(), "provider stream"),
            message,
            code,
            retryable,
            retry_after_ms,
        }
    }

    pub fn other(message: impl Into<String>, retryable: bool) -> Self {
        let message = sanitize_user_text(&message.into(), MAX_USER_MESSAGE_BYTES);
        Self::Other {
            message: if message.is_empty() {
                "Unknown error".to_string()
            } else {
                message
            },
            retryable,
        }
    }
}

impl From<ProviderError> for KordiError {
    fn from(value: ProviderError) -> Self {
        KordiError::Provider(value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, ProviderError>;

/// Convert an HTTP response into a bounded, structured provider error.
pub async fn unexpected_response(
    provider: impl Into<String>,
    operation: impl Into<String>,
    format: ProviderErrorFormat,
    response: Response,
) -> ProviderError {
    unexpected_response_with_sensitive_values(provider, operation, format, response, &[]).await
}

/// Convert an HTTP response into a bounded provider error while also
/// redacting exact request credentials if the provider reflects them inside a
/// recognized JSON error field.
pub async fn unexpected_response_with_sensitive_values(
    provider: impl Into<String>,
    operation: impl Into<String>,
    format: ProviderErrorFormat,
    response: Response,
    sensitive_values: &[String],
) -> ProviderError {
    let provider = sanitize_metadata(&provider.into(), "unknown provider");
    let operation = sanitize_metadata(&operation.into(), "provider request");
    let status = response.status();
    let url = sanitize_url(response.url());
    let content_length = response.content_length();
    let headers = response.headers().clone();
    let content_type = bounded_content_type(&headers);
    let request_id = request_id(&headers);
    let cf_ray = bounded_header(&headers, "cf-ray");
    let header_retry_after_ms = retry_after_ms(&headers);
    let declared_html = content_type
        .as_deref()
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"));
    let (body, body_truncated) = if declared_html {
        (Vec::new(), content_length.unwrap_or(1) > 0)
    } else {
        read_bounded_body(response).await
    };
    let looks_html = looks_like_html(&body, content_type.as_deref());
    let (message, code) = if looks_html {
        (None, None)
    } else {
        parse_provider_envelope_with_sensitive_values(format, &body, sensitive_values)
    };
    let retry_after_ms = header_retry_after_ms.or_else(|| provider_retry_delay_ms(format, &body));

    ProviderError::Http(ProviderHttpError {
        provider,
        operation,
        status,
        url,
        content_type,
        message: message.unwrap_or_else(|| "Unknown error".to_string()),
        code,
        request_id,
        cloudflare_block: status == StatusCode::FORBIDDEN && cf_ray.is_some() && looks_html,
        cf_ray,
        retry_after_ms,
        body_truncated,
        hint: None,
    })
}

pub fn is_retryable_error_message(message: &str) -> bool {
    match parse_explicit_status(message) {
        Some(status) => is_retryable_status_code(status),
        None => is_retryable_semantic_message(message),
    }
}

fn is_retryable_status(status: StatusCode) -> bool {
    is_retryable_status_code(status.as_u16())
}

fn is_retryable_status_code(status: u16) -> bool {
    matches!(status, 408 | 409 | 425 | 429 | 500 | 502 | 503 | 504 | 529)
}

fn is_retryable_error_code(code: &str) -> bool {
    matches!(
        code.trim().to_ascii_lowercase().as_str(),
        "overloaded"
            | "overloaded_error"
            | "rate_limit"
            | "rate_limit_error"
            | "resource_exhausted"
            | "server_error"
            | "internal_error"
            | "rate_limit_exceeded"
            | "service_unavailable"
            | "temporarily_unavailable"
            | "unavailable"
            | "deadline_exceeded"
            | "aborted"
    )
}

fn is_terminal_error_code(code: &str) -> bool {
    matches!(
        code.trim().to_ascii_lowercase().as_str(),
        "authentication_error"
            | "invalid_api_key"
            | "permission_error"
            | "forbidden"
            | "insufficient_permissions"
            | "invalid_request_error"
            | "bad_request"
            | "invalid_argument"
            | "not_found"
            | "model_not_found"
            | "invalid_grant"
            | "permission_denied"
            | "unauthenticated"
            | "failed_precondition"
            | "out_of_range"
            | "unimplemented"
            | "unsupported_country_region_territory"
            | "context_length_exceeded"
            | "billing_error"
            | "insufficient_quota"
    )
}

fn retryability_for_error_code(code: &str) -> Option<bool> {
    let code = code.trim();
    if let Ok(status) = code.parse::<u16>() {
        return Some(is_retryable_status_code(status));
    }
    if is_terminal_error_code(code) {
        return Some(false);
    }
    if is_retryable_error_code(code) {
        return Some(true);
    }
    None
}

fn is_retryable_semantic_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "overloaded",
        "rate limit",
        "too many requests",
        "resource exhausted",
        "an error occurred while processing your request",
        "you can retry your request",
        "service unavailable",
        "server error",
        "internal error",
        "network error",
        "connection error",
        "connection refused",
        "connection lost",
        "other side closed",
        "upstream connect",
        "reset before headers",
        "socket hang up",
        "ended without",
        "http2 request did not get a response",
        "timed out",
        "timeout",
        "temporarily unavailable",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

fn parse_explicit_status(message: &str) -> Option<u16> {
    let message = message
        .trim()
        .strip_prefix("Provider error: ")
        .unwrap_or(message.trim());
    let remainder = message
        .strip_prefix("unexpected status ")
        .or_else(|| message.strip_prefix("HTTP "))
        .or_else(|| message.strip_prefix("http error "))?;
    remainder
        .split(|character: char| !character.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

fn parse_provider_envelope_with_sensitive_values(
    format: ProviderErrorFormat,
    body: &[u8],
    sensitive_values: &[String],
) -> (Option<String>, Option<String>) {
    let first = body
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace());
    if first != Some(b'{') {
        return (None, None);
    }
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return (None, None);
    };

    let (message, code) = match format {
        ProviderErrorFormat::OpenAi => (
            string_at(&value, &["error", "message"]).or_else(|| string_at(&value, &["message"])),
            scalar_at(&value, &["error", "code"]).or_else(|| scalar_at(&value, &["error", "type"])),
        ),
        ProviderErrorFormat::Anthropic => (
            string_at(&value, &["error", "message"]).or_else(|| string_at(&value, &["message"])),
            scalar_at(&value, &["error", "type"]).or_else(|| scalar_at(&value, &["error_type"])),
        ),
        ProviderErrorFormat::Google => (
            string_at(&value, &["error", "message"]).or_else(|| string_at(&value, &["message"])),
            scalar_at(&value, &["error", "status"])
                .or_else(|| scalar_at(&value, &["error", "code"])),
        ),
        ProviderErrorFormat::OAuth => (
            string_at(&value, &["error_description"])
                .or_else(|| string_at(&value, &["error", "message"]))
                .or_else(|| string_at(&value, &["message"])),
            scalar_at(&value, &["error", "type"]).or_else(|| scalar_at(&value, &["error"])),
        ),
    };

    (
        message
            .map(|value| {
                sanitize_user_text_with_sensitive_values(
                    value,
                    MAX_USER_MESSAGE_BYTES,
                    sensitive_values,
                )
            })
            .filter(|value| !value.is_empty()),
        code.map(|value| {
            sanitize_user_text_with_sensitive_values(&value, MAX_DIAGNOSTIC_BYTES, sensitive_values)
        })
        .filter(|value| !value.is_empty()),
    )
}

fn string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn scalar_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    match current {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn provider_retry_delay_ms(format: ProviderErrorFormat, body: &[u8]) -> Option<u64> {
    if format != ProviderErrorFormat::Google {
        return None;
    }
    let value = serde_json::from_slice::<Value>(body).ok()?;
    google_retry_delay_ms(&value)
}

pub(crate) fn google_retry_delay_ms(value: &Value) -> Option<u64> {
    let error = value.get("error")?;

    if let Some(delay) = error
        .get("retryDelay")
        .or_else(|| error.get("retry_delay"))
        .and_then(Value::as_str)
        .and_then(parse_duration_literal_ms)
    {
        return Some(delay);
    }

    error
        .get("details")?
        .as_array()?
        .iter()
        .filter(|detail| {
            detail
                .get("@type")
                .and_then(Value::as_str)
                .is_none_or(|kind| kind.ends_with("google.rpc.RetryInfo"))
        })
        .find_map(|detail| {
            detail
                .get("retryDelay")
                .or_else(|| detail.get("retry_delay"))
                .and_then(Value::as_str)
                .and_then(parse_duration_literal_ms)
        })
}

fn parse_duration_literal_ms(value: &str) -> Option<u64> {
    let value = value.trim().to_ascii_lowercase();
    let number_len = value
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .count();
    let amount = value[..number_len].parse::<f64>().ok()?;
    let milliseconds = match &value[number_len..] {
        "ms" => amount,
        "s" => amount * 1_000.0,
        _ => return None,
    };
    (milliseconds.is_finite() && milliseconds > 0.0)
        .then(|| milliseconds.ceil().min(u64::MAX as f64) as u64)
}

async fn read_bounded_body(response: Response) -> (Vec<u8>, bool) {
    let content_length = response.content_length();
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    let mut truncated = false;
    let deadline = tokio::time::Instant::now() + MAX_ERROR_BODY_READ_DURATION;

    loop {
        let chunk = match tokio::time::timeout_at(deadline, stream.next()).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                truncated = true;
                break;
            }
        };
        let Ok(chunk) = chunk else {
            truncated = true;
            break;
        };
        let remaining = MAX_ERROR_BODY_BYTES.saturating_sub(body.len());
        if chunk.len() > remaining {
            body.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
        if body.len() == MAX_ERROR_BODY_BYTES {
            truncated = match content_length {
                Some(length) => length > MAX_ERROR_BODY_BYTES as u64,
                None => match tokio::time::timeout_at(deadline, stream.next()).await {
                    Ok(Some(Ok(chunk))) => !chunk.is_empty(),
                    Ok(Some(Err(_))) | Err(_) => true,
                    Ok(None) => false,
                },
            };
            break;
        }
    }
    (body, truncated)
}

fn looks_like_html(body: &[u8], content_type: Option<&str>) -> bool {
    content_type.is_some_and(|value| value.to_ascii_lowercase().contains("text/html"))
        || std::str::from_utf8(body)
            .ok()
            .map(str::trim_start)
            .is_some_and(|value| {
                let prefix = truncate_utf8(value, 1_024).to_ascii_lowercase();
                prefix.starts_with("<!doctype")
                    || prefix.starts_with("<html")
                    || prefix.starts_with("<head")
                    || prefix.starts_with("<body")
                    || prefix.starts_with("<script")
                    || prefix.starts_with("<style")
                    || prefix.starts_with("<?xml")
                    || prefix.starts_with("<svg")
                    || prefix.contains("<html")
                    || prefix.contains("<script")
                    || prefix.contains("<style")
                    || prefix.contains("<svg")
                    || prefix.contains("@font-face")
                    || prefix.contains("body{")
                    || prefix.contains("body {")
                    || prefix.contains(":root{")
                    || prefix.contains(":root {")
            })
}

fn sanitize_url(url: &Url) -> String {
    let mut url = url.clone();
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    truncate_utf8(url.as_str(), MAX_URL_BYTES)
}

fn sanitize_url_str(value: &str) -> String {
    Url::parse(value)
        .map(|url| sanitize_url(&url))
        .unwrap_or_else(|_| "<redacted url>".to_string())
}

fn request_id(headers: &HeaderMap) -> Option<String> {
    [
        "x-request-id",
        "x-oai-request-id",
        "request-id",
        "x-github-request-id",
        "x-goog-request-id",
    ]
    .iter()
    .find_map(|name| bounded_header(headers, name))
}

fn bounded_header(headers: &HeaderMap, name: &str) -> Option<String> {
    let value = headers.get(name)?.to_str().ok()?.trim();
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.:/;=+".contains(character))
    {
        return None;
    }
    Some(truncate_utf8(value, MAX_DIAGNOSTIC_BYTES))
}

fn bounded_content_type(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(CONTENT_TYPE)?.to_str().ok()?.trim();
    if value.is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character.is_ascii_whitespace()
                || "-_.:/;=+".contains(character)
        })
    {
        return None;
    }
    Some(truncate_utf8(value, MAX_DIAGNOSTIC_BYTES))
}

fn retry_after_ms(headers: &HeaderMap) -> Option<u64> {
    retry_after_ms_at(headers, SystemTime::now())
}

fn retry_after_ms_at(headers: &HeaderMap, now: SystemTime) -> Option<u64> {
    if let Some(milliseconds) =
        bounded_header(headers, "retry-after-ms").and_then(|value| value.parse::<u64>().ok())
    {
        return Some(milliseconds);
    }
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    if value.is_empty() || value.len() > MAX_DIAGNOSTIC_BYTES {
        return None;
    }
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1_000));
    }
    let deadline = httpdate::parse_http_date(value).ok()?;
    let delay = deadline.duration_since(now).ok()?;
    Some(delay.as_millis().min(u64::MAX as u128) as u64)
}

fn extract_retry_delay_ms(message: &str) -> Option<u64> {
    let lower = message.to_ascii_lowercase();
    let marker = "retry in ";
    let start = lower.find(marker)? + marker.len();
    let suffix = &lower[start..];
    let literal_len = suffix
        .chars()
        .take_while(|character| {
            character.is_ascii_digit()
                || *character == '.'
                || character.eq_ignore_ascii_case(&'m')
                || character.eq_ignore_ascii_case(&'s')
        })
        .count();
    parse_duration_literal_ms(&suffix[..literal_len])
}

fn sanitize_user_text(value: &str, max_bytes: usize) -> String {
    sanitize_user_text_with_sensitive_values(value, max_bytes, &[])
}

fn sanitize_metadata(value: &str, fallback: &str) -> String {
    let value = sanitize_user_text(value, MAX_DIAGNOSTIC_BYTES);
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn sanitize_user_text_with_sensitive_values(
    value: &str,
    max_bytes: usize,
    sensitive_values: &[String],
) -> String {
    let redacted = redact_sensitive_values(value, sensitive_values);
    let normalized = redacted
        .chars()
        .map(|character| {
            if character.is_control() && !character.is_whitespace() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if looks_like_html(normalized.as_bytes(), None) {
        return String::new();
    }

    let mut redact_next_token = false;
    let sanitized = normalized
        .split_whitespace()
        .map(|token| {
            if redact_next_token {
                redact_next_token = false;
                return "[redacted]".to_string();
            }

            if token.eq_ignore_ascii_case("bearer") {
                redact_next_token = true;
                return token.to_string();
            }

            sanitize_message_token(token)
        })
        .collect::<Vec<_>>()
        .join(" ");
    truncate_utf8(sanitized.trim(), max_bytes)
}

fn redact_sensitive_values(value: &str, sensitive_values: &[String]) -> String {
    let mut values = sensitive_values
        .iter()
        .map(|value| value.trim())
        .filter(|value| value.len() >= 4)
        .collect::<Vec<_>>();
    values.sort_unstable_by_key(|value| std::cmp::Reverse(value.len()));
    values.dedup();

    values
        .into_iter()
        .fold(value.to_string(), |redacted, sensitive| {
            redacted.replace(sensitive, "[redacted]")
        })
}

fn sanitize_message_token(token: &str) -> String {
    let lower = token.to_ascii_lowercase();
    if token_contains_ip_address(token) {
        return "[redacted ip]".to_string();
    }

    if let Some(url_start) = lower.find("http://").or_else(|| lower.find("https://")) {
        let (prefix, candidate) = token.split_at(url_start);
        let trailing_len = candidate
            .chars()
            .rev()
            .take_while(|character| ".,;:)]}".contains(*character))
            .map(char::len_utf8)
            .sum::<usize>();
        let (candidate, trailing) =
            candidate.split_at(candidate.len().saturating_sub(trailing_len));
        if let Ok(url) = Url::parse(candidate) {
            return format!("{prefix}{}{trailing}", sanitize_url(&url));
        }
    }

    if [
        "access_token=",
        "refresh_token=",
        "api_key=",
        "apikey=",
        "key=",
        "token=",
        "authorization=",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return "[redacted]".to_string();
    }
    token.to_string()
}

fn token_is_ip_address(token: &str) -> bool {
    let trimmed = token.trim_matches(|character: char| "[](){}<>,;|\"'".contains(character));
    let candidate = trimmed
        .strip_prefix("IP:")
        .or_else(|| trimmed.strip_prefix("ip:"))
        .unwrap_or(trimmed);
    candidate.parse::<IpAddr>().is_ok()
}

fn token_contains_ip_address(token: &str) -> bool {
    if token_is_ip_address(token) {
        return true;
    }

    token
        .split(|character: char| {
            !(character.is_ascii_hexdigit() || character == '.' || character == ':')
        })
        .filter(|candidate| !candidate.is_empty())
        .any(|candidate| {
            let candidate = candidate.trim_end_matches('.');
            let without_label_separator = candidate.strip_prefix(':').unwrap_or(candidate);
            [candidate, without_label_separator]
                .into_iter()
                .any(|candidate| {
                    candidate.parse::<IpAddr>().is_ok()
                        || candidate.rsplit_once(':').is_some_and(|(host, port)| {
                            !port.is_empty()
                                && port.chars().all(|character| character.is_ascii_digit())
                                && host.parse::<IpAddr>().is_ok()
                        })
                })
        })
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

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
            let (message, code) = parse_provider_envelope_with_sensitive_values(
                ProviderErrorFormat::OpenAi,
                body,
                &[],
            );
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
    }

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

    #[tokio::test]
    async fn live_response_parser_bounds_html_and_preserves_safe_diagnostics() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = format!(
            "<html><svg d=\"M 0.500197 0.495044\"></svg><p>[IP:203.0.113.1]</p>{}</html>",
            "x".repeat(MAX_ERROR_BODY_BYTES * 2)
        );
        let response_bytes = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: text/html; charset=utf-8\r\nCF-Ray: ray-test-HKG\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2_048];
            let _ = stream.read(&mut request).await.unwrap();
            stream.write_all(response_bytes.as_bytes()).await.unwrap();
        });

        let url = format!(
            "http://user:password@{address}/backend-api/codex/responses?access_token=secret#fragment"
        );
        let response = reqwest::get(&url).await.unwrap();
        let error = unexpected_response(
            "openai",
            "responses request",
            ProviderErrorFormat::OpenAi,
            response,
        )
        .await;
        server.await.unwrap();

        let ProviderError::Http(error) = error else {
            panic!("expected an HTTP provider error");
        };
        let rendered = error.to_string();
        assert_eq!(
            error.content_type.as_deref(),
            Some("text/html; charset=utf-8")
        );
        assert!(error.body_truncated);
        assert!(error.cloudflare_block);
        assert_eq!(error.cf_ray.as_deref(), Some("ray-test-HKG"));
        assert!(rendered.contains("unexpected status 403 Forbidden: Unknown error"));
        assert!(rendered.contains("cf-ray: ray-test-HKG"));
        assert!(!rendered.contains("secret"));
        assert!(!rendered.contains("password"));
        assert!(!rendered.contains("203.0.113.1"));
        assert!(!rendered.contains("<html"));
        assert!(!error.is_retryable());
    }

    #[tokio::test]
    async fn terminal_error_body_read_has_a_total_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2_048];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: 128\r\nConnection: close\r\n\r\n{\"error\":",
                )
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_secs(10)).await;
        });

        let response = reqwest::get(format!("http://{address}/slow-error"))
            .await
            .unwrap();
        let started = tokio::time::Instant::now();
        let error = unexpected_response(
            "openai",
            "responses request",
            ProviderErrorFormat::OpenAi,
            response,
        )
        .await;
        let elapsed = started.elapsed();
        server.abort();

        let ProviderError::Http(error) = error else {
            panic!("expected an HTTP provider error");
        };
        assert!(error.body_truncated);
        assert_eq!(error.message, "Unknown error");
        assert!(
            elapsed >= MAX_ERROR_BODY_READ_DURATION
                && elapsed < MAX_ERROR_BODY_READ_DURATION + Duration::from_secs(3),
            "bounded read took {elapsed:?}"
        );
        assert!(!error.is_retryable());
    }

    #[tokio::test]
    async fn declared_html_error_does_not_wait_for_the_upstream_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2_048];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nCF-Ray: ray-slow-HKG\r\nContent-Length: 128\r\nConnection: close\r\n\r\n<html>",
                )
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_secs(10)).await;
        });

        let response = reqwest::get(format!("http://{address}/slow-html"))
            .await
            .unwrap();
        let started = tokio::time::Instant::now();
        let error = unexpected_response(
            "openai",
            "responses request",
            ProviderErrorFormat::OpenAi,
            response,
        )
        .await;
        let elapsed = started.elapsed();
        server.abort();

        let ProviderError::Http(error) = error else {
            panic!("expected an HTTP provider error");
        };
        assert_eq!(error.message, "Unknown error");
        assert!(error.body_truncated);
        assert!(error.cloudflare_block);
        assert!(
            elapsed < Duration::from_secs(1),
            "HTML error body should not be read, took {elapsed:?}"
        );
        assert!(!error.is_retryable());
    }
}
