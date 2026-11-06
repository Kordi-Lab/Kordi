//! One chat completion against a resource pool's OpenAI-compatible provider.
//! Errors are fixed codes: nothing here formats the prompt or the reply.

use std::time::Duration;

use serde_json::{json, Value};
use url::{Host, Url};

use crate::resource_pools::PoolProvider;

const RESPONSE_LIMIT_BYTES: usize = 256 * 1024;
/// Twelve one-sentence memories fit well within this.
const MAX_OUTPUT_TOKENS: u32 = 4_096;

const ERR_INVALID_URL: &str = "provider URL is invalid";
const ERR_REQUEST: &str = "provider request failed";
const ERR_STATUS: &str = "provider returned an unsuccessful status";
const ERR_TOO_LARGE: &str = "provider response exceeded the size limit";
const ERR_RESPONSE: &str = "provider response is invalid";
const ERR_CONTENT: &str = "provider response has no assistant content";

pub(super) async fn complete(
    provider: &PoolProvider,
    token: &str,
    system: &str,
    prompt: &str,
) -> Result<String, &'static str> {
    let auth = provider.auth();
    let endpoint = completion_endpoint(auth.base_url()).ok_or(ERR_INVALID_URL)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| ERR_REQUEST)?;
    let mut request = client.post(endpoint).bearer_auth(token).json(&json!({
        "model": auth.model(),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": MAX_OUTPUT_TOKENS,
    }));
    for (name, value) in provider.headers() {
        request = request.header(name, value);
    }
    let mut response = request.send().await.map_err(|_| ERR_REQUEST)?;
    if !response.status().is_success() {
        return Err(ERR_STATUS);
    }
    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_LIMIT_BYTES as u64)
    {
        return Err(ERR_TOO_LARGE);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ERR_RESPONSE)? {
        if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT_BYTES {
            return Err(ERR_TOO_LARGE);
        }
        bytes.extend_from_slice(&chunk);
    }
    let envelope: Value = serde_json::from_slice(&bytes).map_err(|_| ERR_RESPONSE)?;
    envelope
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or(ERR_CONTENT)
}

/// `<base>/chat/completions` for an HTTPS base URL, or plain HTTP on loopback
/// (local gateways and tests). Credentials, queries and fragments in the
/// base URL are refused.
fn completion_endpoint(base_url: &str) -> Option<Url> {
    let mut base = Url::parse(base_url).ok()?;
    let is_loopback = match base.host()? {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    };
    if (base.scheme() != "https" && !(base.scheme() == "http" && is_loopback))
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return None;
    }
    if !base.path().ends_with('/') {
        let path = format!("{}/", base.path());
        base.set_path(&path);
    }
    base.join("chat/completions").ok()
}
