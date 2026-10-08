//! Authenticated JSON calls to provider APIs with a timeout, a response size
//! bound, and the caps every tool result shares.

use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde_json::Value;

use super::ProviderError;

/// Largest provider response body read into memory.
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Lists in tool results are capped at this many items.
pub const MAX_LIST_ITEMS: usize = 50;
/// Free text in tool results (bodies, descriptions) is capped at this many
/// characters.
pub const MAX_TEXT_CHARS: usize = 4000;

/// One provider API: a base URL, fixed headers, and the shared client.
#[derive(Clone)]
pub struct ProviderHttp {
    client: reqwest::Client,
    base: String,
    headers: &'static [(&'static str, &'static str)],
}

impl ProviderHttp {
    pub fn new(
        client: reqwest::Client,
        base: impl Into<String>,
        headers: &'static [(&'static str, &'static str)],
    ) -> Self {
        Self {
            client,
            base: base.into().trim_end_matches('/').to_string(),
            headers,
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    pub async fn get(
        &self,
        path: &str,
        token: &str,
        query: &[(&str, String)],
    ) -> Result<Value, ProviderError> {
        self.send(Method::GET, path, token, query, None).await
    }

    pub async fn post(
        &self,
        path: &str,
        token: &str,
        body: &Value,
    ) -> Result<Value, ProviderError> {
        self.send(Method::POST, path, token, &[], Some(body)).await
    }

    /// Sends one request with the bearer token and returns the JSON body
    /// (`Null` for an empty body). The token never appears in an error.
    pub async fn send(
        &self,
        method: Method,
        path: &str,
        token: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Value, ProviderError> {
        let mut request = self
            .client
            .request(method, self.url(path))
            .timeout(REQUEST_TIMEOUT)
            .bearer_auth(token);
        if !self.headers.iter().any(|(name, _)| *name == "accept") {
            request = request.header("accept", "application/json");
        }
        for (name, value) in self.headers {
            request = request.header(*name, *value);
        }
        if !query.is_empty() {
            request = request.query(query);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| ProviderError::Request(error.without_url().to_string()))?;
        let status = response.status();
        let bytes = read_capped(response).await?;
        match status {
            StatusCode::UNAUTHORIZED => return Err(ProviderError::Unauthorized),
            StatusCode::NOT_FOUND => {
                return Err(ProviderError::invalid(
                    "The provider could not find that item, or this connection cannot see it.",
                ))
            }
            StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => {
                return Err(ProviderError::invalid(
                    "The provider rejected the request. Check the arguments.",
                ))
            }
            status if !status.is_success() => {
                return Err(ProviderError::Request(format!("HTTP {}", status.as_u16())))
            }
            _ => {}
        }
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| ProviderError::InvalidResponse)
    }
}

async fn read_capped(mut response: reqwest::Response) -> Result<Vec<u8>, ProviderError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ProviderError::Request("response too large".into()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| ProviderError::Request(error.without_url().to_string()))?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ProviderError::Request("response too large".into()));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// At most `max` characters of `text`, marking a cut with "...".
pub fn cap_text(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let capped: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{capped}...")
    } else {
        capped
    }
}

/// `value` at `pointer` as capped text, when it is a string.
pub fn text_at(value: &Value, pointer: &str, max: usize) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(|text| cap_text(text, max))
}

/// The items of the array at `pointer`, capped at [`MAX_LIST_ITEMS`].
pub fn list_at<'a>(value: &'a Value, pointer: &str) -> impl Iterator<Item = &'a Value> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .map(|items| items.as_slice())
        .unwrap_or(&[])
        .iter()
        .take(MAX_LIST_ITEMS)
}

/// A trimmed, non-empty string argument.
pub fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// A required string argument of at most `max` characters.
pub fn required_str<'a>(args: &'a Value, key: &str, max: usize) -> Result<&'a str, ProviderError> {
    let value =
        str_arg(args, key).ok_or_else(|| ProviderError::invalid(format!("{key} is required.")))?;
    if value.chars().count() > max {
        return Err(ProviderError::invalid(format!(
            "{key} must be at most {max} characters."
        )));
    }
    Ok(value)
}

/// A positive integer argument, clamped to `1..=max`, or `default`.
pub fn limit_arg(args: &Value, key: &str, default: u64, max: u64) -> u64 {
    args.get(key)
        .and_then(Value::as_u64)
        .unwrap_or(default)
        .clamp(1, max)
}

/// Percent-encodes one URL path segment.
pub fn path_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

/// A GitHub-style identifier (owner, repository): letters, digits, `.`,
/// `_`, and `-`.
pub fn is_plain_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && value != "."
        && value != ".."
}
